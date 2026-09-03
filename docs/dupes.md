# Dupe finder (`src/dupes/`)

Manual scan that surfaces the **top-N most-similar topic pairs** by embedding cosine so the user can merge them from the `/dupes` UI page. There is no absolute similarity cutoff — the N highest-scoring pairs are always shown so the user can rank-walk down the list. Generation is button-triggered (never automatic). Candidates are persisted in SQLite and survive restarts. Pairs the user marks as "not a duplicate" are persisted permanently in a separate dismissals table and never resurface in future scans.

## Tables

Two new tables (see `src/db/schema.ts`). Both are keyed on a canonical pair where `topic_id_a < topic_id_b`, enforced by a `CHECK` constraint. This is what guarantees `(A,B)` and `(B,A)` cannot both exist; callers must normalize the pair before inserting (DB methods assert).

- `topic_dupe_candidates(topic_id_a, topic_id_b, similarity, created_at)` — ephemeral; the whole table is replaced on each generation run.
- `topic_dupe_dismissals(topic_id_a, topic_id_b, dismissed_at)` — permanent; one row per "not a duplicate" decision.

Both tables FK to `topics(id)`. The codebase doesn't use SQL `ON DELETE CASCADE` — instead `db.news.deleteTopic()` cascades manually. Two new lines were added there to clean up these tables when a topic is deleted (which happens on every merge loser, every unmerge source, and every other deletion path). This is the only place that ties dupe state to the rest of the topic lifecycle.

## Generation algorithm

`createDupeFinder({ db, embedding, dupes }).generate()`:

1. Coalesce concurrent calls: if a run is in flight, return the in-flight promise instead of starting a second. The in-flight handle is cleared off the returned promise (`p.then(clear, clear)`), **not** in `run()`'s `finally` — resetting it there would be clobbered by the `inflight = run()` assignment whenever `run()` settles synchronously, pinning the handle non-null and turning every later `generate()` into a silent no-op.
2. Load all topic embeddings via `db.news.listAllTopicEmbeddings(model)` (only topics whose stored embedding matches the current model are considered).
3. Load existing dismissals via `db.news.listDupeDismissalPairs()` into a `"a:b"` Set.
4. Pairwise loop (`i < j`): cosine via the shared `dot()` helper in `src/embeddings/cosine.ts`. Drop pairs in the dismissals set. The outer loop yields (`setImmediate`) roughly every 50ms so the run doesn't pin the event loop and so a cancel request can be received; at each yield it checks the cancel flag.
5. Bounded top-K, not sort-everything: a pair is skipped outright once its similarity can no longer beat the current K-th best, and the working buffer is trimmed back to `dupes.maxCandidates` whenever it grows past `max(4K, 1024)`. Peak memory is `O(K)` and the final sort is trivial. Selection is still "top `dupes.maxCandidates` by similarity desc, regardless of absolute score" — materializing all n²/2 pairs first would be millions of objects and a multi-second, non-yielding sort at a few thousand topics.
6. `db.news.replaceDupeCandidates(pairs)` runs in a single transaction: `DELETE FROM topic_dupe_candidates`, then `INSERT OR IGNORE` each pair guarded by `WHERE EXISTS (SELECT 1 FROM topics WHERE id = ?)` for both ids — so any topic deleted between the embedding-read and the insert is silently skipped instead of FK-erroring.

Brute-force `O(n²)` is fine at the documented "thousands of topics" scale; pure CPU on 384-dim normalized vectors. At ~4k topics (8M pairs) a full scan takes several seconds of CPU — hence the periodic yield — not sub-second. Memory stays flat regardless of `n` thanks to the top-K trim. If topic count grows past ~50k revisit with sqlite-vec.

### Cancellation (2026-06-10)
`DupeFinder.cancel()` sets a server-side flag the run checks at each yield point; on cancel the run aborts **before** `replaceDupeCandidates`, so existing candidates are left intact and status goes to `cancelled` (not `done`/`error`). Because the flag and `status()` are server-side, any client can cancel a run started by any other, and the UI shows the Cancel button purely off `status.state === 'running'` (no client-local "I started it" gating). One ordering caveat: the UI flips to `running` optimistically before `POST /api/dupes/generate` returns, so `cancel()` in the page first awaits that pending start request — otherwise a fast click sends the cancel while nothing is in flight yet, where it silently no-ops and the run then proceeds to completion. There is intentionally no parallelism — the existing coalescing keeps it to one run at a time.

## API surface

Server endpoints in `src/server/index.ts` (all auth-required except `/api/status`):

- `POST /api/dupes/generate` — kicks off a fire-and-forget run, returns `{ ok: true, alreadyRunning?: true }`.
- `POST /api/dupes/cancel` — requests cancellation of the in-flight run (server-side flag); no-op when idle. Returns `{ ok: true }`.
- `GET /api/dupes/status?wait=<seconds>` — current `DupeFinderStatus`. Long-polls up to 60s, settling on the next state transition (mirrors the unmerge-result waiter pattern). A cancel resolves waiters with state `cancelled`.
- `GET /api/dupes` — `{ candidates: DupeCandidate[]; status: DupeFinderStatus }`. Candidates joined with topic title + article counts, sorted by similarity desc.
- `POST /api/dupes/dismiss` body `{ topicIdA, topicIdB }` — normalizes to `a < b`, atomically inserts into dismissals + deletes any matching candidate row.

The actual merge action reuses the existing `POST /api/topics/:topicId/merge` (no new merge endpoint).

## Config

```jsonc
"dupes": {
  "maxCandidates": 10       // surface the N most-similar pairs per run
}
```

Both have sensible defaults so the section is optional.

## Design decisions

### Manual generation only (2026-05-03)
No automatic re-scan on topic create/update — the user explicitly asked for a manual button. New topics are not checked against existing topics on creation. This keeps the consolidator hot path free of extra work and makes the feature easy to reason about (one place that creates rows in `topic_dupe_candidates`).

### Cascade-on-delete is the consistency anchor (2026-05-03)
Every consistency-relevant edge case ultimately funnels through `db.news.deleteTopic()`: merging a loser, unmerging a source, future deletion paths. Adding two `DELETE FROM topic_dupe_*` lines there means the dupe tables can never end up referencing a deleted topic regardless of what triggered the deletion. The CHECK constraint plus the canonical-pair primary key cover the other half (no `(A,B)`/`(B,A)` duplication). Together those two mechanisms cover the consistency surface — no extra logic needed in `mergeTopic` / `unmergeTopic`.

### Whole-table replace per scan (2026-05-03)
Generation does `DELETE FROM topic_dupe_candidates` then re-inserts. Stale candidates from a previous run (which might no longer be in the top-N after summary regen / topic edits) are not preserved. Dismissals are unaffected since they live in a separate table. Single transaction — short, no risk of being seen mid-replace.
