# Aggregator (`src/aggregator/`)

Per-user front page generation. Reads signals + topic summaries from the consolidator's output and assembles a personalized newspaper-style page per user.

- 14-day rolling signal window: reads all signals from the last 14 days (no consumption model).
- Excludes topics the user has marked as read via `user_read_topics`.
- Up to 100 topics per front page, scored by signal priority.
- Uses persistent topic summaries (from consolidator) or first-article text for single-article topics. Headline = `topic.title`.
- Per-user generation interval (`users.interval_ms`, checked every 30s tick).
- Manual on-demand generation: `aggregator.requestFrontPage(userId)` enqueues a job immediately, bypassing the interval check; reached from `POST /api/frontpage` and surfaced in the UI as a "Refresh" button next to the front-page date.
- In-memory async worker pool with N configurable workers (`config.aggregator.workers`) to avoid saturating the LLM backend.
- **Punt logic**: tick is skipped entirely when all workers are saturated; per-user queue depth cap (`workers * 2`) prevents queue bloat within a tick.
- If user has a `preference_profile`: single LLM call for relevance scoring (1-5) on topic titles, re-sorts by relevance.
- Front pages persisted in SQLite `front_pages` table.
- Optional `onFrontPageGenerated` callback for push notifications (used by SSE).
- Periodic cleanup: deletes signals older than 14 days (hourly).

## Design decisions

### Per-user front page intervals (2026-04-07)
Each user has their own `interval_ms` in the DB. The aggregator ticks every 30 seconds and checks each user's last generation time against their interval. Replaced an earlier single global interval, honoring the schema that was already there.

### Preference profile over raw vote scoring (2026-04-13)
Replaced direct vote-based topic scoring with an LLM-generated preference profile. Previously, the aggregator read all raw votes, aggregated them to per-topic numeric scores, and used those to rank sections. Now: votes trigger a debounced (15-min) LLM call (the profiler) that generates a markdown preference description, stored in the users table. The aggregator injects this profile into its relevance-scoring prompt and asks the LLM to return a relevance score (1-5) per section. Raw votes are retained in `user_votes` as source data for profile regeneration. Rationale: numeric vote aggregation has no semantic understanding — a profile description lets the LLM reason about *why* a user liked/disliked content.
