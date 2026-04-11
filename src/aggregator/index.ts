import type { AiClient } from '../ai/index.js'
import type { Db } from '../db/index.js'
import type { AggregatorConfig, AiConfig } from '../config.js'
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
  articleIds: number[]
}

export interface Aggregator {
  start(): void
  stop(): void
  /** Returns the latest front page for a user, or null if none generated yet */
  getLatestFrontPage(userId: number): FrontPage | null
}

// IMPLEMENTED: scheduling loop, worker pool, per-user intervals, SQLite-backed front pages,
//              AI-generated headlines/summaries, basic vote-based scoring, punt logic when overloaded
export function createAggregator({
  db,
  ai,
  config,
  aiConfig,
  onFrontPageGenerated,
}: {
  db: Db
  ai: AiClient
  config: AggregatorConfig
  aiConfig: AiConfig
  onFrontPageGenerated?: (userId: number, generatedAt: number) => void
}): Aggregator {
  const queue: (() => Promise<void>)[] = []
  let activeWorkers = 0
  let timer: ReturnType<typeof setInterval> | null = null

  // Check every 30 seconds which users are due for a front page
  const TICK_MS = 30_000

  function tick() {
    const users = db.users.listAllUsers()
    const now = Date.now()

    // If all workers are busy with a backlog, defer the entire tick.
    // Signals stay in DB and will be consumed next tick.
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

      const signals = db.users.consumePendingSignals(user.id)
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

  const MAX_SECTIONS = 8
  const MAX_ARTICLES_PER_SECTION = 3
  const PROMPT_OVERHEAD_TOKENS = 500

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

    // Score topics: signal priority + vote-based
    const votes = db.users.getVotesByUser(userId)
    const topicVoteScores = new Map<number, number>()
    for (const v of votes) {
      topicVoteScores.set(v.topicId, (topicVoteScores.get(v.topicId) ?? 0) + v.vote)
    }

    const scored = [...topicSignals.entries()]
      .map(([topicId, sigs]) => {
        const maxPriority = Math.max(...sigs.map((s) => SIGNAL_PRIORITY[s.type] ?? 1))
        const rawVoteScore = topicVoteScores.get(topicId) ?? 0
        const voteScore = Math.max(-3, Math.min(3, rawVoteScore))
        return { topicId, sigs, score: maxPriority * 2 + voteScore, voteScore }
      })
      .filter((s) => s.voteScore > -2)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SECTIONS)

    if (scored.length === 0) {
      return { userId, generatedAt: Date.now(), sections: [] }
    }

    // Prepare article context with token budget
    const charBudget = (aiConfig.maxContextTokens - PROMPT_OVERHEAD_TOKENS) * 4
    const charsPerSection = Math.floor(charBudget / scored.length)

    const sectionData = scored.map(({ topicId, sigs }) => {
      const topic = topicMap.get(topicId)!
      const signalArticleIds = new Set(sigs.map((s) => s.articleId))
      const articles = db.news
        .listArticlesByTopic(topicId)
        .filter((a) => signalArticleIds.has(a.id))
        .slice(0, MAX_ARTICLES_PER_SECTION)

      const charsPerArticle = articles.length > 0 ? Math.floor(charsPerSection / articles.length) : 0
      const articleSnippets = articles.map((a) => {
        const text = a.text.length > charsPerArticle ? a.text.slice(0, charsPerArticle) + '…' : a.text
        return `- "${a.title}" (${a.source}): ${text}`
      })

      return {
        topicId,
        topicTitle: topic.title,
        topicDescription: topic.description,
        articleIds: sigs.map((s) => s.articleId),
        articleSnippets,
      }
    })

    // Single batched AI call for all sections
    const promptSections = sectionData
      .map(
        (s, i) =>
          `Section ${i + 1} - Topic: "${s.topicTitle}"\n` +
          `Background: ${s.topicDescription}\n` +
          `Articles:\n${s.articleSnippets.join('\n')}`,
      )
      .join('\n\n')

    const prompt =
      `Generate a newspaper-style headline and 2-3 sentence summary for each of the following ${sectionData.length} news sections.\n` +
      `Each section contains recent articles on a topic.\n\n` +
      `${promptSections}\n\n` +
      `Reply with ONLY a JSON array with exactly ${sectionData.length} entries, one per section in order:\n` +
      `[{"headline": "...", "summary": "..."}, ...]\n` +
      `Do not wrap in markdown code fences.`

    let aiResults: { headline: string; summary: string }[] | null = null
    try {
      const raw = await ai.complete(prompt, 'You are a newspaper editor. Write compelling headlines and concise summaries for a front page.')
      aiResults = JSON.parse(stripCodeFences(raw))
      if (!Array.isArray(aiResults) || aiResults.length !== sectionData.length) {
        aiResults = null
      }
    } catch {
      console.error('[aggregator] AI headline generation failed, falling back to topic titles')
    }

    const sections: FrontPageSection[] = sectionData.map((s, i) => ({
      topicId: s.topicId,
      topicTitle: s.topicTitle,
      headline: aiResults?.[i]?.headline ?? s.topicTitle,
      summary: aiResults?.[i]?.summary ?? s.topicDescription,
      articleIds: s.articleIds,
    }))

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
  }
}
