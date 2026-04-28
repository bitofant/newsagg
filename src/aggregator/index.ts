import { getAi } from '../ai/index.js'
import type { Db } from '../db/index.js'
import type { AggregatorConfig } from '../config.js'
import type { Signal } from '../db/users.js'

/** Strip markdown code fences (```json ... ```) that LLMs often wrap around JSON responses */
function stripCodeFences(text: string): string {
  const trimmed = text.trim()
  const match = trimmed.match(/^```(?:\w*)\n([\s\S]*?)\n```$/)
  return match ? match[1].trim() : trimmed
}

export interface FrontPage {
  userId: number
  generatedAt: number
  sections: FrontPageSection[]
}

export interface FrontPageSection {
  topicId: number
  topicTitle: string
  headline: string
  summary: string
  bullets: string[] | null
  newInfo: string[] | null
  articleIds: number[]
}

export interface Aggregator {
  start(): void
  stop(): void
  /** Returns the latest front page for a user, or null if none generated yet */
  getLatestFrontPage(userId: number): FrontPage | null
  status(): { queueLength: number; activeWorkers: number }
}

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000
const MAX_SECTIONS = 100
const MAX_SUMMARY_CHARS = 300

// IMPLEMENTED: scheduling loop, worker pool, per-user intervals, SQLite-backed front pages,
//              14-day rolling signal window, read-topic exclusion, persistent topic summaries,
//              preference-profile-based relevance ranking, punt logic when overloaded
export function createAggregator({
  db,
  config,
  onFrontPageGenerated,
}: {
  db: Db
  config: AggregatorConfig
  onFrontPageGenerated?: (userId: number, generatedAt: number) => void
}): Aggregator {
  const queue: (() => Promise<void>)[] = []
  let activeWorkers = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let lastCleanup = 0

  // Check every 30 seconds which users are due for a front page
  const TICK_MS = 30_000
  const CLEANUP_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

  function tick() {
    const users = db.users.listAllUsers()
    const now = Date.now()

    // Periodic signal cleanup — delete signals older than 14 days
    if (now - lastCleanup > CLEANUP_INTERVAL_MS) {
      try {
        db.users.cleanupOldSignals(FOURTEEN_DAYS_MS)
      } catch (e) {
        console.error('[aggregator] signal cleanup error:', e)
      }
      lastCleanup = now
    }

    // If all workers are busy with a backlog, defer the entire tick.
    if (activeWorkers >= config.workers && queue.length > 0) {
      console.log('[aggregator] all workers busy, punting tick')
      return
    }

    for (const user of users) {
      const lastGenerated = db.users.getLastFrontPageTime(user.id)
      const elapsed = lastGenerated ? now - lastGenerated : Infinity
      if (elapsed < user.intervalMs) continue

      // Stop enqueuing once the queue is deep enough relative to worker count.
      if (queue.length >= config.workers * 2) break

      const signals = db.users.readSignalsInWindow(user.id, FOURTEEN_DAYS_MS)
      if (signals.length === 0) continue

      enqueue(async () => {
        const page = await generateFrontPage(user.id, signals)
        db.users.saveFrontPage(user.id, JSON.stringify(page))
        onFrontPageGenerated?.(user.id, page.generatedAt)
      })
    }
  }

  function enqueue(task: () => Promise<void>) {
    queue.push(task)
    drainQueue()
  }

  function drainQueue() {
    while (activeWorkers < config.workers && queue.length > 0) {
      const task = queue.shift()!
      activeWorkers++
      task()
        .catch((err) => console.error('[aggregator] front page generation error:', err))
        .finally(() => {
          activeWorkers--
          drainQueue()
        })
    }
  }

  const SIGNAL_PRIORITY: Record<string, number> = {
    substantial_new_info: 3,
    new_topic: 2,
    concluded_issue: 2,
    added_to_topic: 1,
  }

  async function generateFrontPage(userId: number, signals: Signal[]): Promise<FrontPage> {
    const topics = db.news.listTopics()
    const topicMap = new Map(topics.map((t) => [t.id, t]))

    // Group signals by topic
    const topicSignals = new Map<number, Signal[]>()
    for (const s of signals) {
      const arr = topicSignals.get(s.topicId) ?? []
      arr.push(s)
      topicSignals.set(s.topicId, arr)
    }

    // Filter out topics the user has already read
    const readTopicIds = db.users.getReadTopicIds(userId)
    for (const topicId of readTopicIds) {
      topicSignals.delete(topicId)
    }

    // Score topics by signal priority
    const user = db.users.getUserById(userId)
    const preferenceProfile = user?.preferenceProfile ?? null

    const scored = [...topicSignals.entries()]
      .map(([topicId, sigs]) => {
        const maxPriority = Math.max(...sigs.map((s) => SIGNAL_PRIORITY[s.type] ?? 1))
        return { topicId, sigs, score: maxPriority * 2 }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SECTIONS)

    if (scored.length === 0) {
      return { userId, generatedAt: Date.now(), sections: [] }
    }

    // Build sections using persistent topic data
    const sectionsWithRelevance = scored.map(({ topicId, sigs }) => {
      const topic = topicMap.get(topicId)
      let summary: string
      if (topic?.summary) {
        summary = topic.summary
      } else if (topic) {
        // Single-article topic: use first article text as summary
        const articles = db.news.listRecentArticlesByTopic(topicId, 1)
        summary = articles.length > 0
          ? articles[0].text.slice(0, MAX_SUMMARY_CHARS) + (articles[0].text.length > MAX_SUMMARY_CHARS ? '…' : '')
          : topic.description
      } else {
        summary = ''
      }

      return {
        section: {
          topicId,
          topicTitle: topic?.title ?? 'Unknown topic',
          headline: topic?.title ?? 'Unknown topic',
          summary,
          bullets: topic?.bullets ?? null,
          newInfo: topic?.newInfo ?? null,
          articleIds: sigs.map((s) => s.articleId),
        } satisfies FrontPageSection,
        relevance: 3,
      }
    })

    // Relevance scoring via LLM if preference profile exists
    if (preferenceProfile && sectionsWithRelevance.length > 0) {
      try {
        const topicList = sectionsWithRelevance
          .map((s, i) => `${i + 1}. ${s.section.topicTitle}`)
          .join('\n')

        const prompt =
          `Rate the relevance of each topic to this reader's preferences on a scale of 1-5 (1=not relevant, 5=highly relevant).\n\n` +
          `Reader's preference profile:\n${preferenceProfile}\n\n` +
          `Topics:\n${topicList}\n\n` +
          `Reply with ONLY a JSON array of numbers, one per topic in order. Example: [3, 5, 1, 4, ...]\n` +
          `Do not wrap in markdown code fences.`

        const raw = await getAi().complete(prompt, { systemPrompt: 'You are a news relevance scorer.', reasoningEffort: 'off' })
        const scores = JSON.parse(stripCodeFences(raw)) as number[]
        if (Array.isArray(scores) && scores.length === sectionsWithRelevance.length) {
          for (let i = 0; i < scores.length; i++) {
            sectionsWithRelevance[i].relevance = scores[i] ?? 3
          }
          sectionsWithRelevance.sort((a, b) => b.relevance - a.relevance)
        }
      } catch {
        console.error('[aggregator] relevance scoring failed, falling back to signal priority order')
      }
    }

    const sections = sectionsWithRelevance.map((s) => s.section)
    return { userId, generatedAt: Date.now(), sections }
  }

  return {
    start() {
      tick()
      timer = setInterval(tick, TICK_MS)
    },
    stop() {
      if (timer) clearInterval(timer)
    },
    getLatestFrontPage(userId) {
      const row = db.users.getLatestFrontPage(userId)
      if (!row) return null
      return JSON.parse(row.data) as FrontPage
    },
    status() {
      return { queueLength: queue.length, activeWorkers }
    },
  }
}
