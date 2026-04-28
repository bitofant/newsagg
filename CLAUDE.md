# newsagg - Custom News Aggregator

> **This file is the primary context for AI coding agents working on this project. It must be kept in sync with the codebase as it evolves.** A stale CLAUDE.md is worse than none — it causes agents to make incorrect assumptions and propose already-rejected approaches.
>
> **Update this file as part of every change that affects it.** Specifically:
> - When moving a feature from PLANNED → IMPLEMENTED, update its status here
> - When adding a new component, dependency, or config option, document it here
> - When making a non-obvious design decision, add it to "Deliberate Decisions"
> - When changing architecture (new signals, new DB tables, new endpoints), reflect it in the Components section
>
> Do not defer CLAUDE.md updates to a separate step — make them in the same change.

## Project Overview

A personal news aggregator that collects articles from RSS feeds, consolidates them into topics using LLMs, and generates personalized newspaper-style front pages per user. Single-process architecture: one Node.js process + one SQLite file + Ollama.

**This is a public GitHub repository.** Never commit user-specific data, secrets, or personal configuration. All such values must live in gitignored files (`config.json`, `.jwt_secret`, `*.db`). Committed code must only contain templates (`config.example.json`) and sensible defaults.

## Architecture

### Components

1. **AI** (`src/ai/`) - LLM wrapper (OpenAI-compatible API, targeting Ollama or vLLM)
   - Polymorphic via `InferenceProvider` (abstract base in `src/ai/provider.ts`) with `OllamaProvider` and `VllmProvider` subclasses. Production code receives the abstract type via `getAi()` from `src/ai/index.ts`; backend-specific methods (`VllmProvider.fetchModelInfo`, `OllamaProvider.listModels`/`ping`) are intentionally not on the abstract interface so production code cannot depend on them — they are reachable from `llm-test.ts` and tests via `instanceof` narrowing.
   - Lazy singleton via `Singletons.computeIfAbsent('ai', ...)` (see `src/singletons.ts`). The first `getAi()` call constructs the right provider based on `config.ai.backend`. Tests pre-populate the registry with a mock (`Singletons.set('ai', mock)`) before any production code touches `getAi()`.
   - Config: `backend: 'ollama' | 'vllm'`, model name, URL, optional credentials, max context size, status window, `requestTimeoutMs` (default 5 min — caps every chat-completion call so a hung backend surfaces fast).
   - `model` and `maxContextTokens` accept `"auto"` to fetch from `/v1/models` at startup (vLLM serves `max_model_len` in the model list; Ollama does not — `OllamaProvider.doInit()` throws if either is `"auto"`).
   - Initialization is lazy and one-shot: `InferenceProvider.ensureInitialized()` runs `doInit()` once on the first `complete()` call. Mocks pre-populated in `Singletons` skip init entirely (they override `complete` directly).
   - **Per-call reasoning effort**: `complete(prompt, { reasoningEffort })` accepts `'off' | 'low' | 'medium' | 'high'`. `low/medium/high` send OpenAI-compatible `reasoning_effort`. `'off'` sends `chat_template_kwargs: { enable_thinking: false }` instead — a vLLM extension respected by Qwen3's chat template (and our custom one) to disable the `<think>` block entirely; the OpenAI API has no equivalent. Omit the option to leave at backend default. **Important**: the model in production (Qwen3.6:27b) treats reasoning as binary on/off — `low`/`medium`/`high` all behave identically (full reasoning), only `'off'` actually disables thinking. So picking a level is really a yes/no question, and reasoning roughly 5×'s wall-clock per call. Callers pick `'off'` vs a non-off level based on whether the task is reasoning-shaped: matching passes `'high'` (multi-label classification with the "substantial info, not passing mention" judgment) and profile generation passes `'high'` (rare, debounced 15min); assessment, relevance scoring, and topic summary generation/regeneration pass `'off'` (clear-criteria booleans, title-vs-profile pattern match, and extractive summarization respectively — none benefit from a `<think>` block, and they run on hot paths where 5× latency directly grows the consolidator/aggregator backlog). Reasoning content is read from `message.reasoning_content` *or* `message.reasoning` (different vLLM reasoning parsers emit different field names — `deepseek_r1` uses `reasoning_content`, `qwen3` uses `reasoning`; Ollama gpt-oss models populate `reasoning_content`). When `usage.completion_tokens_details.reasoning_tokens` isn't returned (qwen3 parser doesn't), reasoning-token count is estimated from the reasoning text length at ~4 chars/token so `/status` still shows non-zero `reasoningTokPerSec`.
   - **Per-call timeout**: `complete(prompt, { timeoutMs })` overrides `config.ai.requestTimeoutMs` for one call. `npm run llm-test` uses 30s.
   - **LLM call logging**: every `complete()` call writes 3 files to `llm/{YYYYMMDD}/` (gitignored): `{unix_ts}_{seq}.req` (request JSON), `{unix_ts}_{seq}.res` (response text), `{unix_ts}_{seq}.think` (reasoning tokens text, if present). The `{seq}` suffix is a per-process monotonic counter so concurrent calls in the same second don't overwrite each other. Fire-and-forget, never blocks inference.
   - **Call metrics**: each `complete()` records `{startedAt, endedAt, promptTokens, completionTokens, reasoningTokens}` in a rolling window (`ai.statusWindowMs`, default 10 min). Surfaced via `status()` as `busyPct`, `reqPerMin`, `tokPerSec`, `reasoningTokPerSec` (non-zero only for reasoning models; sourced from `usage.completion_tokens_details.reasoning_tokens`). `reasoningTokPerSec` is shown on `/status` only when non-zero.

2. **News DB** (`src/db/news.ts`) - Hierarchical article storage (SQLite)
   - High-level topic list with terse descriptions (used by consolidator for matching)
   - Per-topic `summary` column: LLM-generated 2-3 sentence summary, created when topic reaches 2+ articles, regenerated on `substantial_new_info`
   - Per-topic `bullets` and `new_info` columns (JSON arrays of strings, nullable): used by long-running topics that have crossed the bullets threshold. `bullets` is the running list of material developments; `new_info` is what's materially new since the previous regeneration (rendered with a "NEW:" prefix in the UI).
   - Per-topic `substantial_event_timestamps` column (JSON array of unix-ms numbers, nullable, treated as `[]` when null): one timestamp appended per `substantial_new_info` event. Length doubles as the threshold counter for switching prose-only → bullets format; the values themselves are also useful for surfacing recency in the UI.
   - Articles linked to topics via `article_topics` junction table (many-to-many); an article can belong to multiple topics
   - Per-topic article lists (topic, text, timestamp, source, ...)

3. **User DB** (`src/db/users.ts`) - User management + preferences + signal queue + read tracking (SQLite)
   - User profiles (email, password hash)
   - Per-user article votes: thumbs up/down persisted in `user_votes` table (one vote per user per article, upsert on change)
   - Preference profile: LLM-generated markdown description of user interests (stored in `preference_profile` column), auto-generated from votes via debounced profiler, hand-editable in settings
   - Signal queue for consolidator → aggregator communication
   - Read-topic tracking: `user_read_topics` table (user_id, topic_id, read_at) — tracks which topics a user has marked as read; managed atomically via `setReadTopics()`

4. **News Grabber** (`src/grabber/`) - RSS feed follower
   - Monitors configured RSS feeds via `rss-parser`
   - Per-feed poll interval: `config.rssPollInterval.default` with per-feed `overrides` matched as case-insensitive substrings of the feed URL (first match wins). Each feed gets its own `setInterval` and is polled once on `start()`.
   - Pushes articles to consolidator queue (sync, non-blocking)
   - No dedup — that's the consolidator's job via DB

5. **Consolidator** (`src/consolidator/`) - Topic matching, signal generation & summary generation
   - Internal async queue: `enqueue()` dedups against an in-memory pending set + DB (`articleExistsByUrl`) and buffers articles; drain loop processes every 5s
   - Batches up to 10 articles, matches against topics in pages of 50 (newest first)
   - Multi-topic matching: an article can match multiple existing topics (e.g., a roundup article covering several subjects)
   - Creates new topics or appends to existing ones
   - Enqueues signals to all users: `new_topic`, `added_to_topic`, `substantial_new_info`, `concluded_issue`
   - Combined LLM assessment: substantiality + conclusion detection in one call with topic context
   - **Batched LLM calls per drain cycle**: assessments (all article-topic pairs), new topic summaries (all unmatched articles), and summary regenerations (all topics needing it) each collapse into a single batched LLM call (or N chunked calls if token-budgeted) — minimizes per-request overhead
   - **Token-budgeted batching**: each batched call (matching, assessments, new-topic summaries, summary regen) estimates tokens (~4 chars/token) against `ai.maxContextTokens` minus output reserve, and splits into multiple chunks if a single call would exceed the budget
   - **Parallel LLM dispatch within a drain**: independent calls inside a drain fan out via `Promise.all`: paginated topic-matching pages, token-budget chunks within each batched function, and phase-4 (regen existing summaries) + phase-5 (new-topic summaries) run concurrently. The drain itself stays serialized via the `processing` flag. Sized for vLLM's continuous batching, where concurrent requests share GPU time efficiently and serial pacing leaves throughput on the table.
   - **Topic summary generation**: generates/regenerates a 2-3 sentence LLM summary when a topic reaches 2+ articles or when `substantial_new_info` is detected; stored in `topics.summary` column
   - **Threshold-gated long-form regeneration**: each topic has a `substantial_event_timestamps` array (one append per `substantial_new_info`). When `length >= BULLETS_THRESHOLD` (currently 2), regeneration switches from prose-only to a structured `{ summary, bullets, newInfo }` JSON shape (one LLM call, written via `updateTopicLongForm`). Below threshold, regeneration is unchanged. Within a single drain cycle, short-mode and long-mode batches dispatch in parallel via `Promise.all`, each with its own token-budgeted chunking. Bullet style is enforced in the prompt: terse half-sentence headlines (3-7 words, e.g. "Trump insults Pope"), facts over emotion (no mood-only bullets — "Trump frustrated with recent events" is rejected; reactions only acceptable when paired with the underlying fact).
   - **Read-state reset on substantial news**: when `substantial_new_info` is detected, the topic's read flag is removed for all users except those who downvoted (thumbs down) an article in that topic — ensures users see important developments even if they previously marked the topic as read
   - **Article ungrouping**: `ungroupArticle(articleId, topicId)` removes an article from a topic and re-classifies it via the same paginated LLM matching (excluding the source topic); falls back to creating a new standalone topic if no match found; cleans up empty topics
   - **Batch timing history**: each drain records `{startedAt, endedAt, articleCount}` in a rolling window (size `consolidator.statusWindowMs`), surfaced via `status()` as `estimatedBehindMs` (buffer depth × avg ms/article) for the /status page. Note: LLM busy % is tracked separately in `src/ai/`, not here, because other components (aggregator, profiler) also consume LLM time.
   - PLANNED: embedding-based pre-filter

6. **News Aggregator** (`src/aggregator/`) - Per-user front page generation
   - 14-day rolling signal window: reads all signals from the last 14 days (no consumption model)
   - Excludes topics the user has marked as read via `user_read_topics` table
   - Up to 100 topics per front page, scored by signal priority
   - Uses persistent topic summaries (from consolidator) or first-article text for single-article topics
   - Per-user generation interval (stored in users table, checked every 30s tick)
   - In-memory async worker pool with N configurable workers to avoid saturating Ollama
   - If user has preference profile: single LLM call for relevance scoring (1-5) on topic titles, re-sorts by relevance
   - Front pages persisted in SQLite `front_pages` table
   - Optional `onFrontPageGenerated` callback for push notifications (used by SSE)
   - Periodic cleanup: deletes signals older than 14 days (hourly)
   - **Status: IMPLEMENTED** — scheduling loop, worker pool, per-user intervals, persistent topic summaries, preference-profile-based relevance ranking, punt logic when overloaded, read-topic exclusion

7. **Profiler** (`src/profiler/`) - User preference profile generation
   - Debounced trigger: `onVote(userId)` resets a 15-minute timer per user
   - When timer fires: reads vote history with article/topic context, asks LLM to generate a markdown preference description
   - Stores result in `users.preference_profile` column
   - Profile is editable by user in settings UI

8. **UI** (`ui/`) - SvelteKit + Tailwind CSS
   - Mobile-responsive single-column front page per user (up to 100 topics)
   - Icons via `lucide-svelte` (tree-shakeable SVG icons, styled via Tailwind `currentColor`)
   - Per-card vertical button column (right-aligned): read/unread toggle (`CircleCheck`/`Circle`), thumbs up (`ThumbsUp`), thumbs down (`ThumbsDown`)
   - "Mark above as read" dividers between topic cards: clicking marks all topics above as read (and topics below as unread); read state persisted via `POST /api/readtopics` (atomic full replace). Single-topic toggles use `PUT /api/readtopics/:topicId { read }` (delta).
   - Read topics shown below unread section at reduced opacity
   - Login/register flow
   - Thumbs up/down voting on articles
   - SSE subscription for live front page updates (auto-refreshes on new generation)
   - **Bullets rendering**: when a topic is in long-form mode, both the front-page card and the topic detail page render `newInfo` (with a "NEW:" amber prefix) followed by `bullets` as a single `<ul>` below the summary paragraph. Same shape on both views; cards may grow taller for active topics, intentionally accepted.
   - Inline source expander: click "N sources" on a card to expand article list with titles (linked to original), source names, and relative timestamps; lazy-loaded via `GET /api/topics/:topicId/articles`
   - **Topic detail page** at `/topics/:topicId`: clicking the title/summary area of a card navigates to a polished, hero-style view (larger typography, roomier `max-w-2xl` layout, labelled action buttons). Loads bundled topic metadata + articles + read state via `GET /api/topics/:topicId`. Shareable URL. Same vote / read / ungroup actions as the card. Empty topics (after ungroup) redirect to `/`.
   - Per-article ungroup button (`Unlink2` icon) in inline source list and detail page: removes article from topic and re-classifies it via `POST /api/topics/:topicId/articles/:articleId/ungroup`
   - Status page at `/status` (no auth, not linked from nav): LLM metrics (busy %, req/min, tok/s over `ai.statusWindowMs`), consolidator buffer depth + processing flag + estimated backlog duration, aggregator queue length + active workers, topic/article counts, a Deployable card (build time from mtime of `dist/server/index.js` + process uptime), and a per-user list with interval / last-front-page age / overdue status / 14-day signal count. All relative times tick every second. Auto-refreshes every 5s; a `RefreshIndicator` ring next to the title visualizes the poll cycle (blue fills 0→100% over 2s while in-flight, orange if still pending after 2s, then green/red on response and drains over the remainder of the cycle). State changes push fresh DOM nodes that fade in over the prior one's fade-out, so transitions never get re-targeted mid-flight. Data source: `GET /api/status`.

### Implementation Status Tracking

Use these markers in code comments:
- `// IMPLEMENTED` - fully working
- `// MOCKED` - stubbed out with placeholder logic, needs real implementation
- `// PLANNED` - not yet coded, design exists

## Configuration

All configuration lives in `config.json` at the project root (override path via `CONFIG_PATH` env var).

```jsonc
{
  "feeds": ["https://..."],           // RSS feed URLs
  "rssPollInterval": { "default": "10m", "overrides": { "<substring of feed URL>": "<duration>" } },  // duration units: ms/s/m/h
  "ai": { "backend", "url", "model", "maxContextTokens", "apiKey?", "statusWindowMs", "requestTimeoutMs" },
  "consolidator": { "statusWindowMs" },   // rolling window for /status busy % + backlog ETA
  "aggregator": { "intervalMs", "workers" },
  "server": { "port", "uiDir" },
  "dbPath": "./newsagg.db"
}
```

## Tech Stack

- **Runtime**: Node.js (v22.5+, uses `node:sqlite`)
- **Language**: TypeScript (strict mode, ES modules)
- **LLM**: Ollama via OpenAI-compatible API (only external process)
- **Database**: SQLite via `node:sqlite` (embedded, zero deps)
- **HTTP**: Fastify, serves built SvelteKit UI as static files
- **Frontend**: SvelteKit (adapter-static, SPA mode) + Tailwind CSS v4 + Lucide icons (`lucide-svelte`)
- **Auth**: bcrypt + JWT
- **RSS**: `rss-parser` npm package
- **Event/queue**: in-process only (EventEmitter, in-memory async queue)
- **Real-time push**: Server-Sent Events (SSE) via Fastify `reply.hijack()`

## Commands

```bash
# Development
npm run dev          # run backend with hot reload (tsx watch)
cd ui && npm run dev # run SvelteKit UI dev server (proxies /api to :3000)

# Production build
npm run build        # build UI then compile backend TS
npm start            # run compiled output

# Production ops (survive SSH disconnect)
./start.sh           # nohup launch, pid in newsagg.pid, log in newsagg.log
./stop.sh            # stop via pidfile
./status.sh          # check if running via pidfile (exit 0 = running, 1 = not)
./rebuild.sh         # build UI + compile backend
./restart.sh         # stop → rebuild → start

# Type check
npx tsc --noEmit

# Diagnose the LLM backend (sends a hardcoded prompt with a 30s timeout)
npm run llm-test
```

## Code Style

- TypeScript strict mode, ES modules (`"type": "module"`)
- Functional factories (`createX()`) rather than classes — *exception:* where polymorphism is the natural model (e.g. AI inference providers in `src/ai/`), use an abstract base + subclasses. The `Singletons` container in `src/singletons.ts` (keyed by string, with `computeIfAbsent` / `set` / `clear`) decides which concrete instance is used at runtime, and tests pre-populate it with mocks.
- Interfaces exported alongside implementations
- Column mapping from snake_case (SQL) to camelCase (TS) done at the DB layer boundary

## Not Yet Implemented

Items tracked in code with `// PLANNED` markers:

- **Embedding-based pre-filter** (`src/consolidator/index.ts:18`) — fast vector similarity step to narrow candidate topics before the LLM matching call
- ~~**Aggregator punt logic**~~ → **IMPLEMENTED** (`src/aggregator/index.ts`) — tick is skipped entirely when all workers are saturated; per-user queue depth cap (`workers * 2`) prevents queue bloat within a tick
- ~~**User preferences expansion**~~ → **IMPLEMENTED** — `interval_ms` + `preference_profile` (LLM-generated markdown) exposed via `GET/PATCH /api/preferences` and `/settings` UI; profile auto-generated from votes via profiler, hand-editable in settings
- ~~**WebSocket push**~~ → **IMPLEMENTED as SSE push** (`src/server/index.ts`) — `GET /api/events?token=<jwt>` sends `frontpage` events when a new front page is generated; UI auto-refreshes via `EventSource` with exponential backoff reconnect

## Deliberate Decisions

A log of non-obvious choices and course corrections. Read these before proposing changes to avoid re-treading settled ground.

1. **Config file, not env vars** (2026-04-07): All configuration (RSS feeds, AI settings, aggregator tuning, server config) lives in `config.json`, not environment variables. Env vars are only used for `CONFIG_PATH` (to locate the config file) and `JWT_SECRET`. Rationale: env vars are clunky for list-valued config like feeds, and a single JSON file is easier to version, diff, and hand-edit for a hobby project.

2. **Single process, no distributed anything** (2026-04-07): The entire backend runs as one Node.js process. No message queues (Redis/RabbitMQ), no separate database processes (Postgres), no job queue frameworks (Bull). SQLite is embedded via `node:sqlite`, events are in-memory, the worker pool is just an async counter. Ollama is the only external process and that's intentional (it's the LLM). This keeps ops trivial for a hobby project.

3. **`node:sqlite` over `better-sqlite3`** (2026-04-07): Node 22.5+ ships built-in SQLite. This avoids native addon compilation issues (which broke on Node 25) and removes a heavyweight dependency. The API is synchronous like `better-sqlite3`. It's marked "experimental" but is stable enough for this use case.

4. **Signal queue in SQLite, not in-memory** (2026-04-07): Consolidator signals are written to a `signal_queue` table rather than kept in memory. This survives process restarts and means no signals are lost if the aggregator hasn't consumed them yet.

5. **Front pages persisted in SQLite** (2026-04-07): Generated front pages are stored in a `front_pages` table, not an in-memory Map. This is consistent with decision #4 — if signals survive restarts, front pages should too. The aggregator reads from DB on demand rather than caching.

6. **Grabber dedup is the consolidator's job** (2026-04-07, updated 2026-04-17): The grabber does not track seen URLs. It emits every article from every poll. The consolidator dedups at `enqueue()` time against both an in-memory `pendingUrls: Set<string>` (mirrors the buffer) AND `db.news.articleExistsByUrl()` (indexed SQL lookup, very cheap). When items are spliced out of the buffer in `drain()`, their URLs are removed from the pending set. Rationale for updating: without `enqueue`-time dedup, a slow drain combined with 5-minute RSS re-polling caused the buffer to fill with duplicates (e.g. 3000+ entries representing ~100-300 distinct URLs, each duplicated 10-30×). The in-memory Set is accepted as a tradeoff — yes, it's lost on restart, but so is the buffer itself, and the DB check at `enqueue()` + the safety-net filter in `drain()` cover the restart case correctly.

7. **Grabber → consolidator is decoupled via async queue** (2026-04-07): The grabber calls `consolidator.enqueue()` synchronously (just pushes to a buffer). The consolidator has its own drain loop that processes articles in batches every 5 seconds. This prevents a slow Ollama response from blocking RSS polling.

8. **Batched paginated topic matching** (2026-04-07, updated 2026-04-14): The consolidator matches up to 10 articles at a time against topics in pages of 50, ordered by `created_at DESC` (newest first). All articles are checked against every topic page (not pruned after a match), accumulating topic matches across pages — this is necessary because a multi-subject article may match topics on different pages. Articles with no matches after all pages get new topics. This keeps prompt size bounded regardless of how many topics accumulate.

9. **Per-user front page intervals** (2026-04-07): Each user has their own `interval_ms` in the DB. The aggregator ticks every 30 seconds and checks each user's last generation time against their interval. This replaces the earlier single global interval, honoring the schema that was already there.

10. **adapter-static over adapter-node** (2026-04-10): Switched SvelteKit from `adapter-node` to `adapter-static` with SPA fallback (`fallback: 'index.html'`). The UI is a pure SPA with no server-side load functions — all data comes via API calls. adapter-node produces a Node.js SSR server which can't be served by `@fastify/static`; adapter-static produces plain HTML/JS/CSS files that Fastify serves directly. Root `+layout.ts` exports `prerender = false` and `ssr = false`.

11. **LLM response code fence stripping** (2026-04-10): Both consolidator and aggregator strip markdown code fences (` ```json ... ``` `) from LLM responses before JSON parsing via `stripCodeFences()`. Models (especially Gemma 4) wrap JSON in code fences despite explicit "no code fences" prompts. Without stripping, all `JSON.parse()` calls fail.

12. **max_tokens = 4096 for LLM output** (2026-04-10, updated 2026-04-16): The AI client sends `max_tokens: 4096` (output token limit). `maxContextTokens` (the prompt-size budget) is exposed on the `AiClient` interface and read by the consolidator to split batched prompts. Gemma 4 uses reasoning/thinking tokens that consume the `max_tokens` budget before generating visible content — 1024 was too low, causing empty responses.

13. **Preference profile over raw vote scoring** (2026-04-13): Replaced direct vote-based topic scoring with an LLM-generated preference profile. Previously, the aggregator read all raw votes, aggregated them to per-topic numeric scores, and used those to rank sections. Now: votes trigger a debounced (15-min) LLM call that generates a markdown preference description, stored in the users table. The aggregator injects this profile into its headline-generation prompt and asks the LLM to also return a relevance score (1–5) per section. Users can hand-edit the profile in settings. Raw votes are retained in `user_votes` as source data for profile regeneration. Rationale: numeric vote aggregation has no semantic understanding — a profile description lets the LLM reason about *why* a user liked/disliked content.

14. ~~**View-gated signal consumption**~~ → **REPLACED by read-topic tracking** (2026-04-13): The signal `consumed` flag and `last_viewed_at` are no longer used. Instead, the aggregator reads a 14-day rolling window of all signals regardless of consumption state. Users mark topics as read via a "read line" UI divider (`POST /api/readtopics`), and read topics are excluded from future front page generation. `user_read_topics(user_id, topic_id, read_at)` table tracks read state. Old signals are cleaned up hourly. Rationale: the view-gated model only showed signals since last visit; the rolling window + read tracking gives users up to 100 topics from the last 2 weeks and lets them progressively work through them.

15. **Persistent topic summaries over per-generation LLM headlines** (2026-04-13): Instead of generating headlines and summaries via LLM at front-page time (which was feasible for 8 sections but not for 100), topic summaries are generated once by the consolidator and stored in `topics.summary`. Summaries are created when a topic reaches 2+ articles and regenerated when `substantial_new_info` is detected. Single-article topics use the article's own text as summary. The aggregator uses `topic.title` as the headline. Rationale: decouples summary quality from front-page generation speed; avoids 10+ sequential LLM calls per front page.

16. **Read line as atomic state replacement** (2026-04-13): `POST /api/readtopics` receives the full set of topic IDs that should be read. The server does a transactional delete-all + re-insert for the user. This means clicking a "mark above as read" divider in the middle of the list also un-reads anything below it that was previously read. Rationale: simpler than incremental add/remove operations, and the read-line metaphor naturally implies a single position in the list.

17. **Card design: floating, borderless, rounded** (2026-04-14): Topic cards use shadow-based separation (no borders), large border radius (`rounded-xl`), and a subtle hover lift effect (`hover:shadow-lg hover:-translate-y-0.5`). Page background is warm stone (`stone-50`/`stone-950`) so white cards appear to float. Rationale: modern "material" aesthetic — cards as floating paper rather than bordered boxes. Keep this direction when adding new card-like UI elements.

18. **Many-to-many article-topic relationship** (2026-04-14): Articles are linked to topics via an `article_topics` junction table, not a single `topic_id` FK. A roundup article covering US-Iran diplomacy and Artemis II should belong to both topics, not merge them. The legacy `articles.topic_id` column remains (SQLite can't drop columns) but is vestigial — all queries use the junction table. The consolidator's LLM prompt returns `topicIds: number[]` per article. Topic summaries are instructed to focus only on aspects relevant to the specific topic, since shared articles may cover unrelated subjects.

19. **Consolidator collapses LLM work into batched calls per drain cycle** (2026-04-16): After matching, the consolidator issues at most one LLM call each for (a) assessing all article-topic pairs, (b) generating topic summaries for all unmatched articles, and (c) regenerating summaries for all topics that need it. Previously these ran one call per item, which backed up Ollama during heavy drain cycles (e.g. 20 sequential assess calls for 10 articles matching 2 topics each). Each batched function has a single-item fast path with the original prompt; multi-item paths return JSON arrays/objects keyed by index/topicId. Rationale: Ollama is the throughput bottleneck — fewer, larger prompts amortize request overhead and let the single process keep up. Do NOT revert to per-item calls for simplicity; the per-item versions are kept only as wrappers (`regenerateTopicSummary`, `generateTopicSummary`) used by `ungroupArticle` where batching doesn't apply.

20. **Token-budgeted chunking for batched LLM calls** (2026-04-16): Every batched consolidator call (`matchBatchAgainstTopics`, `assessArticleBatch`, `generateTopicSummaries`, `regenerateTopicSummaries`) rejects fixed chunk sizes in favor of a rough token estimate (`~4 chars/token`) against `ai.maxContextTokens - MAX_OUTPUT_TOKENS - overhead - safety_margin`. Items are accumulated greedily until the budget is hit, then the chunk fires and a new one starts. If a chunk ends up with a single item, execution falls through to the function's single-item fast path (simpler prompt, same parse shape). Rationale: hardcoded `TOPIC_PAGE_SIZE = 50` and unbounded per-batch pair counts could silently overflow small-context models (e.g., a local 2K-context setup), causing truncation or empty responses. `maxContextTokens` is now the single knob that controls safe prompt sizing. The estimate is deliberately rough — the failure mode of over-estimating is an extra LLM call, not a rejected request.

21. **vLLM auto-detection via `"auto"` sentinel** (2026-04-25): `config.ai.model` and `config.ai.maxContextTokens` accept `"auto"` to fetch the first model's `id` and `max_model_len` from `GET /v1/models` at startup. `VllmProvider.doInit()` resolves these before the first `complete()` call. One fetch covers both fields. vLLM always includes `max_model_len` in its model list; Ollama does not — setting `"auto"` with Ollama backend throws a clear error. The `maxContextTokens` property on `InferenceProvider` is always a resolved `number` after init. Rationale: vLLM typically serves a single model and the context window is a property of the model weights, not something operators should have to look up manually.

22. **Reasoning effort is per-call, not config** (2026-04-25): `InferenceProvider.complete(prompt, { reasoningEffort })` accepts `'off' | 'low' | 'medium' | 'high'`. `low/medium/high` send OpenAI-compatible `reasoning_effort`; `'off'` sends `chat_template_kwargs.enable_thinking: false`. The previous config-level `thinkingEffort` field was removed because it never made it into a request body; the per-call parameter replaces it. Rationale: a global config value would force all stages to the same setting, but stages have very different latency tolerances. Note: the production model (Qwen3.6:27b) treats reasoning as binary on/off — `low/medium/high` all behave identically. Current call sites: matching and profiler use `'high'` (genuinely reasoning-shaped); assessment, relevance scoring, and all topic-summary generation/regeneration use `'off'` (clear-criteria booleans, title-vs-profile pattern match, and extractive summarization respectively — none benefit from a `<think>` block, and they sit on hot paths where 5× wall-clock would directly grow the consolidator/aggregator backlog).

23. **Status endpoint over CLI script, no auth** (2026-04-16): Pipeline health (is processing behind?) is exposed via `GET /api/status` and a `/status` UI page, not a `npm run check` CLI script. Rationale: the most useful signals — consolidator `buffer.length`, aggregator `queue.length` and `activeWorkers` — are in-memory state inside the running process, not queryable from SQLite. A standalone script would only see the DB side (topic/article counts, last front-page times). The endpoint is unauthenticated because a) this is a personal/hobby deployment, b) it exposes no user-generated content, only counters and email addresses that the user already controls, and c) it needs to be trivially curl-able. If the project ever becomes multi-tenant, gate the endpoint and stop emitting emails.

24. **AI module: classes + Singletons container** (2026-04-25): The AI module is the one place where `createX()` factories are replaced with classes — abstract `InferenceProvider` (in `src/ai/provider.ts`) with `OllamaProvider` and `VllmProvider` subclasses. Backend-specific public methods (`fetchModelInfo`, `listModels`, `ping`) are reachable only via `instanceof` narrowing; production code holds the abstract type. A generic `Singletons` registry (`src/singletons.ts`, `computeIfAbsent` / `set` / `clear`, keyed by string) lazily constructs the configured provider on first `getAi()` call; tests pre-populate it with mocks. Other modules keep their `createX()` factories — this scope is AI-only for now. Rationale: backends share an OpenAI-compatible request body but differ in initialization and diagnostic surface; polymorphism captures that cleanly, and the registry gives a uniform test-override hook.

25. **Per-request timeout in `complete()`** (2026-04-25): Every chat-completion call uses `AbortController` with `config.ai.requestTimeoutMs` (default 5 min, overridable via `opts.timeoutMs`). Previously `fetch` had no timeout — a hung backend could pin the consolidator drain silently.

26. **Parallel LLM dispatch inside a consolidator drain** (2026-04-26): Inside a drain cycle, independent LLM calls now fan out via `Promise.all`: (a) paginated topic-matching pages, (b) token-budget chunks within each batched function (`matchBatchAgainstTopics`, `assessArticleBatch`, `generateTopicSummaries`, `regenerateTopicSummaries`), and (c) phase 4 (regen existing topic summaries) + phase 5 (new-topic summaries for unmatched articles). The drain itself remains serialized via the `processing` flag — only the LLM-bound work inside one drain runs concurrently. Rationale: with vLLM as the production backend, continuous batching means concurrent requests share GPU time efficiently, so serial pacing leaves throughput on the table. This complements (does not replace) Decision 19's batching: batching keeps each request large and amortizes overhead; parallel dispatch keeps the GPU busy across the requests that remain. Side effect: LLM log filenames now include a per-process sequence suffix (`{unix_ts}_{seq}`) so concurrent calls in the same second don't overwrite each other's `.req`/`.res`/`.think` files.

27. **Threshold-gated long-form topic summaries** (2026-04-27): Long-running stories (e.g. the Ukraine war) accumulate dozens of articles, and a single 2-3 sentence prose summary becomes the wrong shape — either an unreadable wall as the model crams everything in, or so general that meaningful new developments disappear. Solution: each topic tracks `substantial_event_timestamps` (one append per `substantial_new_info` event) and switches to a structured `{ summary, bullets, newInfo }` format once the count crosses `BULLETS_THRESHOLD` (currently 2). Below threshold, prose-only behavior is unchanged. The long-mode prompt mandates ticker-style half-sentence bullets ("Trump insults Pope", 3-7 words) and rejects emotion-only content ("Trump frustrated with recent events" is a stated BAD example) — reactions are only acceptable when paired with the underlying fact. The full state (summary + bullets + newInfo) regenerates on every substantial event; the LLM is responsible for folding previously-NEW items into bullets, dropping superseded items, and flagging the actually-new ones in `newInfo`. Timestamps are stored as a JSON array (rather than a bare counter) so the same column also gives recency for free, useful for surfacing "last update X ago" without an extra column. UI renders newInfo first with an amber "NEW:" prefix, then bullets, on both card and detail views. Rationale: structuring the regeneration prompt this way is the cheapest change that fixes the wall-of-text failure mode while keeping the writer-side prompt simple and giving the reader an at-a-glance "what changed".
