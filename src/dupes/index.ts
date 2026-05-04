import type { Db } from '../db/index.js'
import type { DupesConfig, EmbeddingConfig } from '../config.js'
import { dot } from '../embeddings/cosine.js'

export interface DupeFinderStatus {
  state: 'idle' | 'running' | 'done' | 'error'
  startedAt?: number
  completedAt?: number
  candidateCount?: number
  error?: string
}

export interface DupeFinder {
  /** Pairwise-cosine all topic embeddings, persist as candidates. Coalesces concurrent calls. */
  generate(): Promise<{ candidateCount: number }>
  status(): DupeFinderStatus
  /** Register a callback fired when the current run completes (success or error). Returns an unsubscribe fn. */
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
    const startedAt = Date.now()
    current = { state: 'running', startedAt }
    try {
      const topicEmbs = db.news.listAllTopicEmbeddings(embedding.model)
      const dismissed = new Set<string>()
      for (const d of db.news.listDupeDismissalPairs()) {
        dismissed.add(`${d.topicIdA}:${d.topicIdB}`)
      }

      const pairs: Array<{ topicIdA: number; topicIdB: number; similarity: number }> = []
      for (let i = 0; i < topicEmbs.length; i++) {
        const a = topicEmbs[i]!
        for (let j = i + 1; j < topicEmbs.length; j++) {
          const b = topicEmbs[j]!
          const sim = dot(a.embedding, b.embedding)
          // Canonicalize: smaller id first.
          const lo = Math.min(a.id, b.id)
          const hi = Math.max(a.id, b.id)
          if (dismissed.has(`${lo}:${hi}`)) continue
          pairs.push({ topicIdA: lo, topicIdB: hi, similarity: sim })
        }
      }

      pairs.sort((x, y) => y.similarity - x.similarity)
      const capped = pairs.slice(0, dupes.maxCandidates)
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
      inflight = null
      notifyCompletion()
    }
  }

  return {
    generate() {
      if (inflight) return inflight
      inflight = run()
      return inflight
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
