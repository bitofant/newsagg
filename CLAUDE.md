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

## Architecture

### Components

1. **AI** (`src/ai/`) - LLM wrapper (OpenAI-compatible API, targeting Ollama)
   - Config: model name, thinking effort, URL, optional credentials, max context size

2. **News DB** (`src/db/news.ts`) - Hierarchical article storage (SQLite)
   - High-level topic list with terse descriptions (used by consolidator for matching)
   - Per-topic article lists (topic, text, timestamp, source, ...)

3. **User DB** (`src/db/users.ts`) - User management + preferences + signal queue (SQLite)
   - User profiles (email, password hash)
   - Per-user topic interests: thumbs up/down on articles
   - Signal queue for consolidator → aggregator communication

4. **News Grabber** (`src/grabber/`) - RSS feed follower
   - Monitors configured RSS feeds via `rss-parser`
   - Pushes articles to consolidator queue (sync, non-blocking)
   - No dedup — that's the consolidator's job via DB

5. **Consolidator** (`src/consolidator/`) - Topic matching & signal generation
   - Internal async queue: `enqueue()` buffers articles, drain loop processes every 5s
   - Batches up to 10 articles, matches against topics in pages of 50 (newest first)
   - Creates new topics or appends to existing ones
   - Enqueues signals to all users: `new_topic`, `added_to_topic`, `substantial_new_info`, `concluded_issue`
   - Combined LLM assessment: substantiality + conclusion detection in one call with topic context
   - PLANNED: embedding-based pre-filter

6. **News Aggregator** (`src/aggregator/`) - Per-user front page generation
   - Consumes signal queue from DB per user
   - Per-user generation interval (stored in users table, checked every 30s tick)
   - In-memory async worker pool with N configurable workers to avoid saturating Ollama
   - Front pages persisted in SQLite `front_pages` table
   - Optional `onFrontPageGenerated` callback for push notifications (used by SSE)
   - **Status: IMPLEMENTED** — scheduling loop, worker pool, per-user intervals, AI-generated headlines/summaries, basic vote-based scoring, punt logic when overloaded

7. **UI** (`ui/`) - SvelteKit + Tailwind CSS
   - Mobile-responsive newspaper-style front page per user
   - Login/register flow
   - Thumbs up/down voting on articles
   - SSE subscription for live front page updates (auto-refreshes on new generation)

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
  "ai": { "url", "model", "thinkingEffort", "maxContextTokens", "apiKey?" },
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
- **Frontend**: SvelteKit (adapter-node) + Tailwind CSS v4
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
- **User preferences expansion** — only `interval_ms` is exposed via `GET/PATCH /api/preferences` and `/settings` UI; additional preferences TBD
- ~~**WebSocket push**~~ → **IMPLEMENTED as SSE push** (`src/server/index.ts`) — `GET /api/events?token=<jwt>` sends `frontpage` events when a new front page is generated; UI auto-refreshes via `EventSource` with exponential backoff reconnect
- **`thinking_effort` parameter** (`src/ai/index.ts:29`) — commented out pending model support in Ollama

## Deliberate Decisions

A log of non-obvious choices and course corrections. Read these before proposing changes to avoid re-treading settled ground.

1. **Config file, not env vars** (2026-04-07): All configuration (RSS feeds, AI settings, aggregator tuning, server config) lives in `config.json`, not environment variables. Env vars are only used for `CONFIG_PATH` (to locate the config file) and `JWT_SECRET`. Rationale: env vars are clunky for list-valued config like feeds, and a single JSON file is easier to version, diff, and hand-edit for a hobby project.

2. **Single process, no distributed anything** (2026-04-07): The entire backend runs as one Node.js process. No message queues (Redis/RabbitMQ), no separate database processes (Postgres), no job queue frameworks (Bull). SQLite is embedded via `node:sqlite`, events are in-memory, the worker pool is just an async counter. Ollama is the only external process and that's intentional (it's the LLM). This keeps ops trivial for a hobby project.

3. **`node:sqlite` over `better-sqlite3`** (2026-04-07): Node 22.5+ ships built-in SQLite. This avoids native addon compilation issues (which broke on Node 25) and removes a heavyweight dependency. The API is synchronous like `better-sqlite3`. It's marked "experimental" but is stable enough for this use case.

4. **Signal queue in SQLite, not in-memory** (2026-04-07): Consolidator signals are written to a `signal_queue` table rather than kept in memory. This survives process restarts and means no signals are lost if the aggregator hasn't consumed them yet.

5. **Front pages persisted in SQLite** (2026-04-07): Generated front pages are stored in a `front_pages` table, not an in-memory Map. This is consistent with decision #4 — if signals survive restarts, front pages should too. The aggregator reads from DB on demand rather than caching.

6. **Grabber dedup is the consolidator's job** (2026-04-07): The grabber does not track seen URLs. It emits every article from every poll. The consolidator checks `articleExistsByUrl()` against SQLite, which is the authoritative dedup. This avoids a redundant in-memory Set that wouldn't survive restarts anyway.

7. **Grabber → consolidator is decoupled via async queue** (2026-04-07): The grabber calls `consolidator.enqueue()` synchronously (just pushes to a buffer). The consolidator has its own drain loop that processes articles in batches every 5 seconds. This prevents a slow Ollama response from blocking RSS polling.

8. **Batched paginated topic matching** (2026-04-07): The consolidator matches up to 10 articles at a time against topics in pages of 50, ordered by `created_at DESC` (newest first). The LLM reports which articles matched and which didn't; unmatched articles are retried against the next page of 50 topics. Articles still unmatched after all pages get new topics. This keeps prompt size bounded regardless of how many topics accumulate.

9. **Per-user front page intervals** (2026-04-07): Each user has their own `interval_ms` in the DB. The aggregator ticks every 30 seconds and checks each user's last generation time against their interval. This replaces the earlier single global interval, honoring the schema that was already there.
