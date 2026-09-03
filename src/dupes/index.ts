import type { Db } from '../db/index.js'
import type { DupesConfig, EmbeddingConfig } from '../config.js'
import { dot } from '../embeddings/cosine.js'

export interface DupeFinderStatus {
  state: 'idle' | 'running' | 'done' | 'error' | 'cancelled'
  startedAt?: number
  completedAt?: number
  candidateCount?: number
  error?: string
}

export interface DupeFinder {
  /** Pairwise-cosine all topic embeddings, persist as candidates. Coalesces concurrent calls. */
  generate(): Promise<{ candidateCount: number }>
  /**
   * Request cancellation of the in-flight run. The run checks this at its periodic
   * yield points and aborts without persisting (leaving existing candidates intact).
   * Server-side state, so any client can cancel a run started by any other. No-op when idle.
   */
  cancel(): void
  status(): DupeFinderStatus
  /** Register a callback fired when the current run settles (done, error, or cancelled). Returns an unsubscribe fn. */
  onCompletion(fn: () => void): () => void
}

export function createDupeFinder({
  db,
  embedding,
  dupes,
}: {
  db: Db
  embedding: EmbeddingConfig
  dupes: DupesConfig
}): DupeFinder {
  let current: DupeFinderStatus = { state: 'idle' }
  let inflight: Promise<{ candidateCount: number }> | null = null
  let cancelRequested = false
  const listeners = new Set<() => void>()

  function notifyCompletion() {
    for (const fn of listeners) {
      try {
        fn()
      } catch {
        // ignore; listeners are best-effort
      }
    }
  }

  async function run(): Promise<{ candidateCount: number }> {
    cancelRequested = false
    const startedAt = Date.now()
    current = { state: 'running', startedAt }
    try {
      const topicEmbs = db.news.listAllTopicEmbeddings(embedding.model)
      const dismissed = new Set<string>()
      for (const d of db.news.listDupeDismissalPairs()) {
        dismissed.add(`${d.topicIdA}:${d.topicIdB}`)
      }

      // Bounded top-K: only `dupes.maxCandidates` pairs survive, so there is no point
      // materializing all n²/2 of them (at a few thousand topics that is millions of
      // objects and a multi-second, non-yielding final sort). Keep a working buffer,
      // trim it back to the cap whenever it grows, and skip anything that can no longer
      // beat the current K-th best. `cutoff` stays -Infinity until the first trim, and
      // becomes +Infinity if the cap is 0 (drop everything).
      const maxCandidates = Math.max(0, dupes.maxCandidates)
      const trimAt = Math.max(maxCandidates * 4, 1024)
      let cutoff = -Infinity
      const pairs: Array<{ topicIdA: number; topicIdB: number; similarity: number }> = []
      let lastYield = Date.now()
      for (let i = 0; i < topicEmbs.length; i++) {
        // The pairwise loop is otherwise one long synchronous block (seconds at
        // thousands of topics) that pins the event loop. Yield every ~50ms so the
        // server can service other requests — in particular a cancel — then honour it.
        if (Date.now() - lastYield > 50) {
          await new Promise((r) => setImmediate(r))
          lastYield = Date.now()
          if (cancelRequested) {
            current = { state: 'cancelled', startedAt, completedAt: Date.now() }
            return { candidateCount: 0 }
          }
        }
        const a = topicEmbs[i]!
        for (let j = i + 1; j < topicEmbs.length; j++) {
          const b = topicEmbs[j]!
          const sim = dot(a.embedding, b.embedding)
          if (sim <= cutoff) continue
          // Canonicalize: smaller id first.
          const lo = Math.min(a.id, b.id)
          const hi = Math.max(a.id, b.id)
          if (dismissed.has(`${lo}:${hi}`)) continue
          pairs.push({ topicIdA: lo, topicIdB: hi, similarity: sim })
          if (pairs.length >= trimAt) {
            pairs.sort((x, y) => y.similarity - x.similarity)
            pairs.length = maxCandidates
            cutoff = pairs.length > 0 ? pairs[pairs.length - 1]!.similarity : Infinity
          }
        }
      }

      pairs.sort((x, y) => y.similarity - x.similarity)
      const capped = pairs.slice(0, maxCandidates)
      db.news.replaceDupeCandidates(capped)

      current = {
        state: 'done',
        startedAt,
        completedAt: Date.now(),
        candidateCount: capped.length,
      }
      return { candidateCount: capped.length }
    } catch (err) {
      current = {
        state: 'error',
        startedAt,
        completedAt: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      }
      throw err
    } finally {
      notifyCompletion()
    }
  }

  return {
    generate() {
      if (inflight) return inflight
      const p = run()
      inflight = p
      // Clear the coalescing handle once the run settles (resolve or reject), so the
      // next generate() actually re-runs. Done off the returned promise rather than in
      // run()'s `finally` to avoid the reset being clobbered by the `inflight = p`
      // assignment above when run() happens to settle synchronously.
      const clear = () => {
        if (inflight === p) inflight = null
      }
      p.then(clear, clear)
      return p
    },
    cancel() {
      if (inflight) cancelRequested = true
    },
    status() {
      return { ...current }
    },
    onCompletion(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}
