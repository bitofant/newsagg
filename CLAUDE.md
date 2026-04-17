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

1. **AI** (`src/ai/`) - LLM wrapper (OpenAI-compatible API, targeting Ollama)
   - Config: model name, thinking effort, URL, optional credentials, max context size, status window
   - **LLM call logging**: every `complete()` call writes 3 files to `llm/{YYYYMMDD}/` (gitignored): `{unix_ts}.req` (request JSON), `{unix_ts}.res` (response text), `{unix_ts}.think` (reasoning tokens, if present). Fire-and-forget, never blocks inference. Useful for debugging prompt issues or unexpected LLM output.
   - **Call metrics**: each `complete()` records `{startedAt, endedAt, promptTokens, completionTokens}` in a rolling window (`ai.statusWindowMs`, default 10 min). Surfaced via `status()` as `busyPct` (% of window spent in LLM calls; can exceed 100% if calls overlap), `reqPerMin`, `tokPerSec`. Token counts come from OpenAI-compatible `usage` field (0 if absent).

2. **News DB** (`src/db/news.ts`) - Hierarchical article storage (SQLite)
   - High-level topic list with terse descriptions (used by consolidator for matching)
   - Per-topic `summary` column: LLM-generated 2-3 sentence summary, created when topic reaches 2+ articles, regenerated on `substantial_new_info`
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
   - Pushes articles to consolidator queue (sync, non-blocking)
   - No dedup — that's the consolidator's job via DB

5. **Consolidator** (`src/consolidator/`) - Topic matching, signal generation & summary generation
   - Internal async queue: `enqueue()` dedups against an in-memory pending set + DB (`articleExistsByUrl`) and buffers articles; drain loop processes every 5s
   - Batches up to 10 articles, matches against topics in pages of 50 (newest first)
   - Multi-topic matching: an article can match multiple existing topics (e.g., a roundup article covering several subjects)
   - Creates new topics or appends to existing ones
   - Enqueues signals to all users: `new_topic`, `added_to_topic`, `substantial_new_info`, `concluded_issue`
   - Combined LLM assessment: substantiality + conclusion detection in one call with topic context
   - **Batched LLM calls per drain cycle**: assessments (all article-topic pairs), new topic summaries (all unmatched articles), and summary regenerations (all topics needing it) each collapse into a single LLM call per batch — minimizes Ollama backpressure
   - **Token-budgeted batching**: each batched call (matching, assessments, new-topic summaries, summary regen) estimates tokens (~4 chars/token) against `ai.maxContextTokens` minus output reserve, and splits into multiple chunks if a single call would exceed the budget
   - **Topic summary generation**: generates/regenerates a 2-3 sentence LLM summary when a topic reaches 2+ articles or when `substantial_new_info` is detected; stored in `topics.summary` column
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
   - "Mark above as read" dividers between topic cards: clicking marks all topics above as read (and topics below as unread); read state persisted via `POST /api/readtopics`
   - Read topics shown below unread section at reduced opacity
   - Login/register flow
   - Thumbs up/down voting on articles
   - SSE subscription for live front page updates (auto-refreshes on new generation)
   - Topic detail view: click "N sources" on a card to expand inline article list with titles (linked to original), source names, and relative timestamps; lazy-loaded via `GET /api/topics/:topicId/articles`
   - Per-article ungroup button (`Unlink2` icon) in expanded source list: removes article from topic and re-classifies it via `POST /api/topics/:topicId/articles/:articleId/ungroup`
   - Status page at `/status` (no auth, not linked from nav): LLM metrics (busy %, req/min, tok/s over `ai.statusWindowMs`), consolidator buffer depth + processing flag + estimated backlog duration, aggregator queue length + active workers, topic/article counts, a Deployable card (build time from mtime of `dist/server/index.js` + process uptime), and a per-user list with interval / last-front-page age / overdue status / 14-day signal count. All relative times tick every second. Auto-refreshes every 5s. Data source: `GET /api/status`.

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
  "ai": { "url", "model", "thinkingEffort", "maxContextTokens", "apiKey?", "statusWindowMs" },
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
./rebuild.sh         # build UI + compile backend
./restart.sh         # stop → rebuild → start

# Type check
npx tsc --noEmit
```

## Code Style

- TypeScript strict mode, ES modules (`"type": "module"`)
- Functional factories (`createX()`) rather than classes
- Interfaces exported alongside implementations
- Column mapping from snake_case (SQL) to camelCase (TS) done at the DB layer boundary

## Not Yet Implemented

Items tracked in code with `// PLANNED` markers:

- **Embedding-based pre-filter** (`src/consolidator/index.ts:18`) — fast vector similarity step to narrow candidate topics before the LLM matching call
- ~~**Aggregator punt logic**~~ → **IMPLEMENTED** (`src/aggregator/index.ts`) — tick is skipped entirely when all workers are saturated; per-user queue depth cap (`workers * 2`) prevents queue bloat within a tick
- ~~**User preferences expansion**~~ → **IMPLEMENTED** — `interval_ms` + `preference_profile` (LLM-generated markdown) exposed via `GET/PATCH /api/preferences` and `/settings` UI; profile auto-generated from votes via profiler, hand-editable in settings
- ~~**WebSocket push**~~ → **IMPLEMENTED as SSE push** (`src/server/index.ts`) — `GET /api/events?token=<jwt>` sends `frontpage` events when a new front page is generated; UI auto-refreshes via `EventSource` with exponential backoff reconnect
- **`thinking_effort` parameter** (`src/ai/index.ts:29`) — commented out pending model support in Ollama

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

21. **Status endpoint over CLI script, no auth** (2026-04-16): Pipeline health (is processing behind?) is exposed via `GET /api/status` and a `/status` UI page, not a `npm run check` CLI script. Rationale: the most useful signals — consolidator `buffer.length`, aggregator `queue.length` and `activeWorkers` — are in-memory state inside the running process, not queryable from SQLite. A standalone script would only see the DB side (topic/article counts, last front-page times). The endpoint is unauthenticated because a) this is a personal/hobby deployment, b) it exposes no user-generated content, only counters and email addresses that the user already controls, and c) it needs to be trivially curl-able. If the project ever becomes multi-tenant, gate the endpoint and stop emitting emails.
