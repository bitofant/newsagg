# News Grabber (`src/grabber/`)

RSS feed follower. Single responsibility: poll feeds, push articles into the consolidator queue.

- Monitors configured RSS feeds via `rss-parser`.
- Per-feed poll interval: `config.rssPollInterval.default` with per-feed `overrides` matched as case-insensitive substrings of the feed URL (first match wins). Each feed gets its own `setInterval` and is polled once on `start()`.
- Pushes articles to consolidator queue via `consolidator.enqueue()` (sync, non-blocking).
- No dedup — that's the consolidator's job.

## Design decisions

### Grabber dedup is the consolidator's job (2026-04-07, updated 2026-04-17)
The grabber does not track seen URLs. It emits every article from every poll. The consolidator dedups at `enqueue()` time against both an in-memory `pendingUrls: Set<string>` (mirrors the buffer) AND `db.news.articleExistsByUrl()` (indexed SQL lookup, very cheap). When items are spliced out of the buffer in `drain()`, their URLs are removed from the pending set. Rationale for updating: without `enqueue`-time dedup, a slow drain combined with 5-minute RSS re-polling caused the buffer to fill with duplicates (e.g. 3000+ entries representing ~100-300 distinct URLs, each duplicated 10-30×). The in-memory Set is accepted as a tradeoff — yes, it's lost on restart, but so is the buffer itself, and the DB check at `enqueue()` + the safety-net filter in `drain()` cover the restart case correctly.

### Grabber → consolidator decoupled via async queue (2026-04-07)
The grabber calls `consolidator.enqueue()` synchronously (just pushes to a buffer). The consolidator has its own drain loop that processes articles in batches every 5 seconds. This prevents a slow Ollama response from blocking RSS polling.
