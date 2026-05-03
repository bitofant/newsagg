# Consolidator (`src/consolidator/`)

Topic matching, signal generation, summary generation, ungroup/unmerge/merge. The heaviest LLM-using component.

## Drain cycle

- Internal async queue: `enqueue()` dedups against an in-memory pending set + DB (`articleExistsByUrl`) and buffers articles. Drain loop runs every 5s, serialized via the `processing` flag.
- Batches up to 10 articles. For each batch, the **embedding pre-filter** computes article vectors on CPU, scores them against all stored topic embeddings, picks per-article candidates by threshold + min-K, and unions across the batch. The result is one small candidate set passed to a single LLM matching call.
- Multi-topic matching: an article can match multiple existing topics (e.g. a roundup article covering several subjects). The pre-filter preserves this — candidates are returned per-article and unioned, the LLM still does the multi-label assignment.
- Creates new topics (for unmatched articles) or appends to existing ones. New topics are embedded at create-time so the next batch can find them; updated topics re-embed at the end of every summary regen.
- Enqueues signals to all users: `new_topic`, `added_to_topic`, `substantial_new_info`, `concluded_issue`.
- Combined LLM assessment: substantiality + conclusion detection in one call with topic context.

## Embedding pre-filter

`preFilterCandidates(articles, excludeTopicId?)` is the gate in front of every `matchBatchAgainstTopics` call. CPU-side embeddings via `getEmbedder()`; details in `@docs/embeddings.md`. Per-article picking rules: take all topics with `cosine ≥ candidateThreshold`, capped at `candidateMaxK`; if fewer than `candidateMinK` clear the threshold, take the top-`candidateMinK` regardless. Per-article picks unioned across the batch, sorted by topic id ASC for partial vLLM prefix-cache reuse, returned as `Topic[]`.

When the union is empty for the whole batch, the LLM matching call is skipped entirely and every article routes to new-topic creation — a free latency win on genuine-novel-story drains. The token-budget chunker inside `matchBatchAgainstTopics` is unchanged; it splits oversized unions automatically.

`backfillEmbeddings()` runs at `consolidator.start()` in the background, paging through topics whose `embedding_model` doesn't match `config.embedding.model`. The first `drain()` iteration awaits the resulting promise before processing anything; subsequent drains see a resolved promise and skip the await. Server `listen()` is not blocked.

## Batched + parallel LLM dispatch

Inside one drain cycle, independent LLM calls fan out via `Promise.all`. The drain itself remains serialized.

- **Batched calls**: assessments (all article-topic pairs), new-topic summaries (all unmatched articles), summary regenerations (all topics needing one) each collapse into a single batched LLM call (or N chunked calls if token-budgeted) with a single-item fast path.
- **Token-budgeted chunking**: every batched call estimates tokens (~4 chars/token) against `ai.maxContextTokens - MAX_OUTPUT_TOKENS - overhead - safety_margin`, accumulates greedily, fires when budget is hit. If a chunk ends up with one item, the function's single-item fast path is used.
- **Parallel dispatch**: token-budget chunks within each batched function and phase-4 (regen existing summaries) + phase-5 (new-topic summaries) run concurrently.

Sized for vLLM's continuous batching, where concurrent requests share GPU time efficiently.

## Topic summaries

- **Short mode** (default): 2-3 sentence prose summary in `topics.summary`. Generated when a topic reaches 2+ articles; regenerated when `substantial_new_info` is detected.
- **Long mode** (threshold-gated): each topic tracks `substantial_event_timestamps` (one append per `substantial_new_info`). When `length >= BULLETS_THRESHOLD` (currently 2), regeneration switches to a structured `{ summary, bullets, newInfo }` JSON shape (one LLM call, written via `updateTopicLongForm`). Within a single drain cycle, short-mode and long-mode batches dispatch in parallel via `Promise.all`, each with its own token-budgeted chunking.
- Bullet style is enforced in the prompt: terse half-sentence headlines (3-7 words, e.g. "Trump insults Pope"), facts over emotion (no mood-only bullets — "Trump frustrated with recent events" is rejected; reactions only acceptable when paired with the underlying fact).
- The single-item wrappers (`regenerateTopicSummary`, `generateTopicSummary`) are kept only for `ungroupArticle`, where batching doesn't apply.

## Read-state reset on substantial news

When `substantial_new_info` is detected, the topic's read flag is removed for all users **except** those who downvoted (thumbs down) an article in that topic — ensures users see important developments even if they previously marked the topic as read.

## Article ungrouping

`ungroupArticle(articleId, topicId)` removes an article from a topic and re-classifies it via the same embedding-pre-filter + LLM matching used by the drain (excluding the source topic id). Falls back to creating a new standalone topic if no match found, embedded immediately. Cleans up empty topics.

## Topic unmerging

`unmergeTopic(topicId)` splits a wrongly-merged topic via a two-phase LLM call:

1. **Phase 1** (`identifyNewTopics`, `reasoningEffort: 'high'`, one call) reads all article titles + the original topic and outputs sub-topic descriptors (default 2, capped at 4). Prompt biases hard toward 2 — typical wrong-merge is "one big topic + a small off-topic group that snuck in".
2. **Phase 2** (`assignArticlesToTopics`, `reasoningEffort: 'off'`, parallel via `Promise.all`) chunks articles by token budget and assigns each to a phase-1 sub-topic by index.

Then: new topics are created, summaries regenerated, read state is copied from the old topic to all new topics (per-user via `db.users.replaceReadTopic`), and every user's latest front page that referenced the old topic is rewritten in place (section spliced out, new sections spliced in at the same index, saved as a new `front_pages` row so SSE pushes the update). The old topic is deleted last. Returns `{ newTopicIds, affectedUserIds }`.

The HTTP layer wraps this asynchronously: `POST /api/topics/:id/unmerge` kicks off the work and returns immediately; `GET /api/topics/:id/unmerge-result?wait=N` long-polls (up to 60s, server-clamped) and returns `{ status: 'pending' | 'done' | 'error', newTopics?, error? }`. Job state lives in an in-memory `Map<topicId, UnmergeJob>` in the server with a 5-minute TTL.

## Topic merging

`mergeTopic(loserId, winnerId)` folds duplicate topics together (user-flagged "these are the same story"):

1. Rewire `article_topics` rows from loser → winner via `INSERT OR IGNORE` (handles articles already linked to both).
2. Concat both topics' `substantial_event_timestamps` (sorted) onto winner — the threshold-gated long-form mode picks up combined history on the next regen.
3. `db.users.unionReadTopic(loserId, winnerId)` — for any user that had loser read, mark winner read with loser's `read_at` (`INSERT OR IGNORE` preserves any existing winner read_at). Avoids resurfacing a topic the user already saw.
4. Enqueue summary regen via `enqueueRegen(winnerId)` (skipped if loser had 0 articles). Runs on the next drain cycle; merge endpoint returns immediately. Long-mode dispatch is automatic when regen runs.
5. Rewrite each user's latest front page in place using winner's *current* (pre-regen) summary: if only loser-section is present, swap in a fresh winner-section at the same index carrying loser's `articleIds`; if both are present, drop loser-section and union loser's `articleIds` into the winner-section. Save as a new `front_pages` row so SSE pushes the update.
6. `db.news.deleteTopic(loserId)` last — clears `article_topics`, `signal_queue`, `user_read_topics` and repoints any `articles.topic_id` legacy column.

Synchronous (sub-second) via `POST /api/topics/:id/merge` with `{ intoTopicId }`. Returns `{ winnerId, winnerTitle }`. The picker is fed by `GET /api/topics?limit=N` returning `{id, title, updatedAt, articleCount}` ordered by `updated_at DESC`.

## Background regen queue

`enqueueRegen(topicId)` adds a topic id to an in-memory `Set` that the drain processes alongside the article buffer. Used for cases where summary regen should not block a request — currently only `mergeTopic`. The drain runs articles first (if any), then drains regens; both go through the same serialized `processing` flag so LLM calls don't overlap. Errors during regen are logged and don't affect article processing. `status().pendingRegens` exposes the queue depth.

## Status

Each drain records `{startedAt, endedAt, articleCount}` in a rolling window (size `consolidator.statusWindowMs`), surfaced via `status()` as `estimatedBehindMs` (buffer depth × avg ms/article). LLM busy % is tracked separately in `src/ai/`, not here, because other components also consume LLM time.

## Design decisions

### Embedding pre-filter replaces paginated topic matching (2026-05-03)
Original matcher fanned out one LLM call per page of 50 topics; with ~1.4k topics that's ~28 parallel calls per 10-article drain at ~560k input tokens total. The pre-filter (`preFilterCandidates`, see `@docs/embeddings.md`) embeds articles on CPU, cosine-scores against all topic embeddings (brute-force, sub-millisecond at this scale), keeps per-article candidates by `threshold + min-K + max-K`, unions across the batch, hands one small candidate set to a single LLM call. Per-batch input drops to ~3k tokens, the LLM still does the multi-label classification — just on a useful subset. Trade: the previous architecture's deterministic 50-topic prefix-cache pages are gone, candidate sets are now article-content-driven and vary per drain. Net throughput is dramatically better because token volume reduction dominates cache hit rate at our scale; some prefix-cache hits remain opportunistically (system prompt is byte-stable, intra-call article suffix is byte-stable, candidate union is sorted by topic id so consecutive overlapping unions share leading prefix). Threshold + min-K rather than fixed top-K ensures novel-story articles still get a fair LLM look at the closest existing topics rather than the pre-filter making the no-match call alone; an empty candidate set across the whole batch skips the LLM call entirely and routes to new-topic creation. New topics are embedded at create-time so the very next batch can find them; topics re-embed on every summary regen so the embedding tracks the topic's current state, not its origin description. Removed at the same time: `db.news.listTopicsPaginated` and the `regenerateTopicSummary` single-topic wrapper, both unused after the pre-filter integration.

### Persistent topic summaries over per-generation LLM headlines (2026-04-13)
Instead of generating headlines and summaries via LLM at front-page time (feasible for 8 sections but not for 100), topic summaries are generated once by the consolidator and stored in `topics.summary`. Created when a topic reaches 2+ articles; regenerated on `substantial_new_info`. Single-article topics use the article's own text. The aggregator uses `topic.title` as the headline. Rationale: decouples summary quality from front-page generation speed; avoids 10+ sequential LLM calls per front page.

### Consolidator collapses LLM work into batched calls per drain cycle (2026-04-16)
After matching, the consolidator issues at most one LLM call each for (a) assessing all article-topic pairs, (b) generating topic summaries for all unmatched articles, (c) regenerating summaries for all topics that need it. Previously these ran one call per item, which backed up Ollama during heavy drain cycles (e.g. 20 sequential assess calls for 10 articles matching 2 topics each). Each batched function has a single-item fast path with the original prompt; multi-item paths return JSON arrays/objects keyed by index/topicId. Rationale: Ollama is the throughput bottleneck — fewer, larger prompts amortize request overhead. Do NOT revert to per-item calls for simplicity; the per-item versions are kept only as wrappers used by `ungroupArticle` where batching doesn't apply.

### Token-budgeted chunking for batched LLM calls (2026-04-16)
Every batched consolidator call (`matchBatchAgainstTopics`, `assessArticleBatch`, `generateTopicSummaries`, `regenerateTopicSummaries`) rejects fixed chunk sizes in favor of a rough token estimate (`~4 chars/token`) against `ai.maxContextTokens - MAX_OUTPUT_TOKENS - overhead - safety_margin`. Items accumulated greedily until budget is hit, then chunk fires and a new one starts. If a chunk ends up with a single item, execution falls through to the function's single-item fast path. Rationale: hardcoded `TOPIC_PAGE_SIZE = 50` and unbounded per-batch pair counts could silently overflow small-context models, causing truncation or empty responses. `maxContextTokens` is now the single knob that controls safe prompt sizing. The estimate is deliberately rough — failure mode of over-estimating is an extra LLM call, not a rejected request.

### Parallel LLM dispatch inside a consolidator drain (2026-04-26)
Independent LLM calls inside a drain fan out via `Promise.all`: paginated topic-matching pages, token-budget chunks within each batched function, and phase 4 (regen existing summaries) + phase 5 (new-topic summaries). The drain itself remains serialized via the `processing` flag — only the LLM-bound work inside one drain runs concurrently. Rationale: with vLLM's continuous batching, concurrent requests share GPU time efficiently, so serial pacing leaves throughput on the table. Complements (does not replace) the batching decision above: batching keeps each request large; parallel dispatch keeps the GPU busy across the requests that remain. Side effect: LLM log filenames now include a per-process sequence suffix so concurrent calls in the same second don't overwrite each other's `.req`/`.res`/`.think` files.

### Threshold-gated long-form topic summaries (2026-04-27)
Long-running stories (e.g. the Ukraine war) accumulate dozens of articles, and a single 2-3 sentence prose summary becomes the wrong shape — either an unreadable wall as the model crams everything in, or so general that meaningful new developments disappear. Solution: each topic tracks `substantial_event_timestamps` (one append per `substantial_new_info` event) and switches to structured `{ summary, bullets, newInfo }` once the count crosses `BULLETS_THRESHOLD` (currently 2). Below threshold, prose-only behavior is unchanged. The long-mode prompt mandates ticker-style half-sentence bullets ("Trump insults Pope", 3-7 words) and rejects emotion-only content ("Trump frustrated with recent events" is a stated BAD example) — reactions only acceptable when paired with the underlying fact. The full state regenerates on every substantial event; the LLM is responsible for folding previously-NEW items into bullets, dropping superseded items, flagging the actually-new ones in `newInfo`. Timestamps stored as a JSON array (rather than a bare counter) so the same column gives recency for free, useful for surfacing "last update X ago". UI renders newInfo first with an amber "NEW:" prefix, then bullets, on both card and detail views. Rationale: the cheapest change that fixes the wall-of-text failure mode while keeping the writer-side prompt simple and giving the reader an at-a-glance "what changed".

### Topic unmerging rewrites front pages in place (2026-04-28)
When the user splits a wrongly-merged topic, `consolidator.unmergeTopic` doesn't just delete the old topic and let the next aggregator tick rebuild — it actively rewrites every user's latest front page, splicing the old section out and the N new sections in at the same index, then saves a new `front_pages` row so SSE pushes the update. Rationale: unmerge is a user-triggered correction; making the user wait up to `intervalMs` (default 15 minutes) for the front page to "look right" feels broken, especially right after the user has confirmed a destructive action. The cost is one parse + splice + INSERT per user with a section referencing that topic — cheap. Read state is also actively migrated (`db.users.replaceReadTopic`) so a user who had marked the merged topic as read sees the new topics under the read line, not surfacing as fresh unread. New `new_topic` signals are still enqueued for all users so future aggregator runs see the new topics naturally; the front-page rewrite is purely an immediate-feedback optimization on top.

### Manual merge is sync via background regen queue (2026-05-01)
Merge is the inverse of unmerge but doesn't need its two-phase reasoning machinery — the user has already decided "these are duplicates", so there's no LLM classification to make. The only LLM work is one summary regen on the winner. That sounds fast in the median case but isn't: a merge that pushes the combined topic over the bullets threshold runs long-mode regen on ~10 recent articles, which has been observed taking ~5 minutes under LLM load — past most browser/proxy timeouts. So the endpoint is sync but does NOT await regen: `mergeTopic` enqueues the winner via `enqueueRegen(topicId)` and returns immediately, the drain picks it up on its next 5s tick. Tradeoff: front-page rewrite uses winner's pre-merge summary text; the next aggregator tick (per-user `intervalMs`, default 15min) refreshes the rendered summary. Acceptable — the article list and bullets are correct immediately, only the prose summary briefly lags. Read state uses union (`INSERT OR IGNORE`) rather than replace, so if a user had only winner read with a recent `read_at`, it stays — only users who had loser-but-not-winner read get an entry copied. Picker endpoint `GET /api/topics?limit=N` returns light `{id, title, articleCount, updatedAt}` projections; the UI fetches once and filters client-side. Rejected alternatives: (a) async polling job like unmerge — overkill since the merge itself completes in <100ms once regen is decoupled; (b) fire-and-forget `void regenerateTopicSummaries(...)` from inside `mergeTopic` — bypasses the consolidator's serialization and would race with the article drain's own regen calls; the queue keeps all LLM-bound work funneled through one drain. (c) actively rewriting saved front pages again when background regen completes — possible refinement, deferred until staleness becomes annoying in practice.

### Two-phase unmerge split (2026-04-29)
The single-shot "partition all articles in one reasoning call" approach (in `splitTopicViaLlm`) timed out repeatedly on real wrongly-merged topics with 60-85 articles — the reasoning chain has to weigh every article against every potential grouping, the chain alone exhausts the 8k output budget before any JSON appears, and the call hits the 5-minute `requestTimeoutMs`. Solution: split the work. **Phase 1** (`identifyNewTopics`, `reasoningEffort: 'high'`) reads only the article titles plus the original (incorrect) topic and outputs sub-topic `{ title, description }` entries — defaulting to 2, capped at 4. The reasoning chain is bounded by "decide the structure" rather than "structure + place every article". **Phase 2** (`assignArticlesToTopics`, `reasoningEffort: 'off'`, parallel via `Promise.all`) takes that small list of candidate topics + chunks the articles by token budget and asks the LLM to classify each article by index — pure mechanical assignment, chunks fan out concurrently. Each chunk's failure mode is "leaves articles unassigned"; the wrapper puts unassigned articles in group 0 so the existing sanitizer can drop empty groups and surface "produced <2 non-empty" if classification went badly. **Phase 1 prompt biases hard toward returning 2 sub-topics**, with explicit instructions that the typical wrong-merge is "one large topic + a small off-topic group that snuck in" and that aspects/sub-themes of the same ongoing story are ONE topic. Without this bias the model fans out into 5-6 buckets even for clearly-2-way splits (a user reported clicking unmerge expecting 2 topics and getting 6). Rejected alternatives: (a) refuse unmerges above N articles (papers over the actual problem and is user-hostile for exactly the cases that need fixing); (b) drop reasoning entirely on the partition decision (the structure-finding step genuinely is reasoning-shaped — without it Qwen3.6 produced incoherent groups in early experiments).
