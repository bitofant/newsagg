# newsagg - Custom News Aggregator

> **Primary AI agent context. Keep in sync with the codebase.** A stale CLAUDE.md is worse than none — it causes agents to make incorrect assumptions and propose already-rejected approaches. When you change a component, update its own doc file (links below). When you change cross-cutting structure (config, commands, tech stack, top-level architecture decisions), update this file. Don't defer doc updates to a separate step.

## Project Overview

Personal news aggregator: collects RSS articles, consolidates them into topics via LLM, generates per-user newspaper-style front pages. Single-process: one Node.js process + one SQLite file + one LLM backend (Ollama or vLLM).

**Public GitHub repo.** Never commit user data, secrets, or personal config — these live in gitignored files (`config.json`, `.jwt_secret`, `*.db`). Committed code is templates (`config.example.json`) and defaults only.

## Components

Each file is self-contained: spec + design decisions for that component. Read only what's relevant to your task.

| Component | Path | Doc |
| --- | --- | --- |
| AI / LLM wrapper | `src/ai/` | `@docs/ai.md` |
| Embeddings (CPU ONNX, topic pre-filter) | `src/embeddings/` | `@docs/embeddings.md` |
| Databases (news + users + signals + read state) | `src/db/` | `@docs/db.md` |
| RSS grabber | `src/grabber/` | `@docs/grabber.md` |
| Consolidator (topic matching, summaries, ungroup/unmerge) | `src/consolidator/` | `@docs/consolidator.md` |
| Aggregator (per-user front pages) | `src/aggregator/` | `@docs/aggregator.md` |
| Profiler (preference profile generation) | `src/profiler/` | `@docs/profiler.md` |
| UI + HTTP server (SvelteKit SPA, Fastify, SSE) | `ui/`, `src/server/` | `@docs/ui.md` |

Cross-component flows worth knowing about up-front:

- Grabber → Consolidator (sync `enqueue()`, async drain).
- Consolidator → Embeddings: every topic create/regen embeds via `getEmbedder()`, stored on `topics.embedding`. Article→topic matching pre-filters via cosine before any LLM call.
- Consolidator → Aggregator via `signal_queue` table; consolidator also rewrites users' latest `front_pages` row directly when topic-unmerging.
- Profiler reads `users.manual_preferences` + votes, writes `users.preference_profile`. Aggregator reads `preference_profile` only.

Code-comment status markers: `// IMPLEMENTED`, `// MOCKED`, `// PLANNED`. None outstanding.

## Cross-cutting design decisions

These constrain every component. Component-local decisions live in each component's doc.

### Config file, not env vars (2026-04-07)
All configuration (RSS feeds, AI settings, aggregator tuning, server config) lives in `config.json`, not environment variables. Env vars are only used for `CONFIG_PATH` (to locate the config file) and `JWT_SECRET`. Rationale: env vars are clunky for list-valued config like feeds, and a single JSON file is easier to version, diff, and hand-edit for a hobby project.

### Single process, no distributed anything (2026-04-07)
The entire backend runs as one Node.js process. No message queues (Redis/RabbitMQ), no separate database processes (Postgres), no job queue frameworks (Bull). SQLite is embedded via `node:sqlite`, events are in-memory, the worker pool is just an async counter. Ollama/vLLM is the only external process and that's intentional (it's the LLM). This keeps ops trivial for a hobby project — don't reach for distributed infra without revisiting this decision.

## Tech Stack

Node.js v22.5+ (uses `node:sqlite`), TypeScript strict + ES modules. Fastify backend serves a SvelteKit SPA (adapter-static) with Tailwind v4 + `lucide-svelte`. Auth: bcrypt + JWT. Real-time push: SSE via Fastify `reply.hijack()`. LLM via OpenAI-compatible API (Ollama or vLLM). Everything in-process: in-memory queues, EventEmitter.

## Configuration

`config.json` at project root (override path via `CONFIG_PATH` env var).

```jsonc
{
  "feeds": ["https://..."],
  "rssPollInterval": { "default": "10m", "overrides": { "<url substring>": "<dur>" } },
  "ai": { "backend", "url", "model", "maxContextTokens", "apiKey?", "statusWindowMs", "requestTimeoutMs" },
  "embedding": { "model", "batchSize", "candidateThreshold", "candidateMinK", "candidateMaxK" },
  "consolidator": { "statusWindowMs" },
  "aggregator": { "intervalMs", "workers" },
  "server": { "port", "uiDir" },
  "dbPath": "./newsagg.db"
}
```

`ai.model` and `ai.maxContextTokens` accept `"auto"` on vLLM (fetched from `/v1/models` at startup); not supported on Ollama. Duration units in `rssPollInterval`: `ms`/`s`/`m`/`h`.

## Commands

```bash
# Dev
npm run dev               # backend, hot reload (tsx watch)
cd ui && npm run dev      # UI dev server (proxies /api → :3000)

# Build / run / verify
npm run build             # build UI then compile backend
npm start                 # run compiled output
npx tsc --noEmit          # type check
npm run llm-test          # diagnose LLM backend (30s timeout)

# Production ops (survive SSH disconnect; pidfile = newsagg.pid, log = newsagg.log)
./start.sh   ./stop.sh   ./status.sh   ./rebuild.sh   ./restart.sh
```

## Code Style

- TypeScript strict, ES modules (`"type": "module"`).
- Functional factories (`createX()`) with interfaces exported alongside.
- Exception: AI inference providers use abstract base + subclasses, with a lazy singleton via `Singletons` (`src/singletons.ts`); tests pre-populate with mocks. See `@docs/ai.md`. Other modules keep `createX()` factories.
- Column mapping snake_case (SQL) → camelCase (TS) at the DB layer boundary.
