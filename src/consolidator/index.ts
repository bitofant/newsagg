import type { AiClient } from '../ai/index.js'
import type { ConsolidatorConfig } from '../config.js'
import type { Db } from '../db/index.js'
import type { RawArticle } from '../grabber/index.js'
import type { Topic } from '../db/news.js'

const TOPIC_PAGE_SIZE = 50
const ARTICLE_BATCH_SIZE = 10
const DRAIN_INTERVAL_MS = 5_000

/** Hardcoded max_tokens in src/ai/index.ts — must match. */
const MAX_OUTPUT_TOKENS = 4096
/** Slack for tokenization inaccuracy and unexpected prompt expansion. */
const BUDGET_SAFETY_MARGIN = 256
/** Minimum input budget: even a tiny context window should fit something. */
const MIN_INPUT_BUDGET = 512

/** Rough estimate: ~4 chars per token. Good enough for prompt sizing (failure mode is a smaller chunk, not a rejected call). */
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4)
}

/** Tokens available for dynamic prompt content, given the fixed instruction overhead for a call. */
function inputBudget(ai: AiClient, fixedOverheadTokens: number): number {
  return Math.max(
    MIN_INPUT_BUDGET,
    ai.maxContextTokens - MAX_OUTPUT_TOKENS - fixedOverheadTokens - BUDGET_SAFETY_MARGIN,
  )
}

/** Split items into chunks such that each chunk's rendered tokens fit within `budget`. */
function chunkByTokens<T>(items: T[], rendered: string[], budget: number): T[][] {
  if (items.length === 0) return []
  const chunks: T[][] = []
  let current: T[] = []
  let currentTokens = 0
  for (let i = 0; i < items.length; i++) {
    const t = estimateTokens(rendered[i])
    if (current.length > 0 && currentTokens + t > budget) {
      chunks.push(current)
      current = []
      currentTokens = 0
    }
    current.push(items[i])
    currentTokens += t
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/** Strip markdown code fences (```json ... ```) that LLMs often wrap around JSON responses */
function stripCodeFences(text: string): string {
  const trimmed = text.trim()
  const match = trimmed.match(/^```(?:\w*)\n([\s\S]*?)\n```$/)
  return match ? match[1].trim() : trimmed
}

export interface Consolidator {
  /** Push an article into the internal queue (sync, non-blocking) */
  enqueue(article: RawArticle): void
  /** Remove an article from a topic and re-classify it against other topics */
  ungroupArticle(articleId: number, topicId: number): Promise<{ newTopicIds: number[] }>
  status(): {
    bufferDepth: number
    processing: boolean
    estimatedBehindMs: number | null
  }
  start(): void
  stop(): void
}

// IMPLEMENTED: batched topic matching with paginated topics, internal queue, concluded_issue detection
// PLANNED: embedding-based pre-filter
export function createConsolidator({ db, ai, config }: { db: Db; ai: AiClient; config: ConsolidatorConfig }): Consolidator {
  const buffer: RawArticle[] = []
  const pendingUrls = new Set<string>()
  let timer: ReturnType<typeof setInterval> | null = null
  let processing = false
  const batchHistory: { startedAt: number; endedAt: number; articleCount: number }[] = []

  function enqueue(article: RawArticle) {
    // Dedup: skip if already queued, or already saved to DB
    if (pendingUrls.has(article.url)) return
    if (db.news.articleExistsByUrl(article.url)) return
    buffer.push(article)
    pendingUrls.add(article.url)
  }

  async function drain() {
    if (processing || buffer.length === 0) return
    processing = true
    try {
      // Take up to ARTICLE_BATCH_SIZE from the buffer
      const batch = buffer.splice(0, ARTICLE_BATCH_SIZE)
      for (const a of batch) pendingUrls.delete(a.url)

      // Safety net: filter out anything that landed in DB between enqueue and drain
      const fresh = batch.filter((a) => !db.news.articleExistsByUrl(a.url))
      if (fresh.length === 0) return

      const startedAt = Date.now()
      await processBatch(fresh)
      const endedAt = Date.now()

      batchHistory.push({ startedAt, endedAt, articleCount: fresh.length })
      const cutoff = endedAt - config.statusWindowMs
      while (batchHistory.length > 0 && batchHistory[0].endedAt < cutoff) {
        batchHistory.shift()
      }
    } catch (err) {
      console.error('[consolidator] batch processing error:', err)
    } finally {
      processing = false
    }
  }

  async function processBatch(articles: RawArticle[]): Promise<void> {
    const totalTopics = db.news.topicCount()
    let offset = 0
    // Accumulate matched topics per article across all pages
    const matchesByIndex = new Map<number, Topic[]>()

    while (offset < totalTopics) {
      const topicPage = db.news.listTopicsPaginated(TOPIC_PAGE_SIZE, offset)
      if (topicPage.length === 0) break

      const results = await matchBatchAgainstTopics(ai, articles, topicPage)
      for (const { articleIndex, topics } of results) {
        const existing = matchesByIndex.get(articleIndex) ?? []
        existing.push(...topics)
        matchesByIndex.set(articleIndex, existing)
      }

      offset += TOPIC_PAGE_SIZE
    }

    // Phase 1: Save all matched articles to DB and collect assessment pairs
    interface AssessmentPair {
      article: RawArticle
      savedId: number
      topic: Topic
      recentArticleTitles: string[]
    }
    const assessmentPairs: AssessmentPair[] = []

    for (let i = 0; i < articles.length; i++) {
      const topics = matchesByIndex.get(i)
      if (topics && topics.length > 0) {
        const saved = db.news.addArticle({
          topicIds: topics.map((t) => t.id),
          source: articles[i].source,
          url: articles[i].url,
          title: articles[i].title,
          text: articles[i].text,
        })
        for (const topic of topics) {
          db.news.updateTopicTimestamp(topic.id)
          const recentArticleTitles = db.news
            .listRecentArticlesByTopic(topic.id, 6)
            .filter((a) => a.id !== saved.id)
            .slice(0, 5)
            .map((a) => a.title)
          assessmentPairs.push({ article: articles[i], savedId: saved.id, topic, recentArticleTitles })
        }
      }
    }

    // Phase 2: Batch-assess all article-topic pairs in one LLM call
    const assessments = assessmentPairs.length > 0
      ? await assessArticleBatch(ai, assessmentPairs)
      : []

    // Phase 3: Process assessment results (signals, summary regen)
    const topicsNeedingSummary: number[] = []
    for (let i = 0; i < assessmentPairs.length; i++) {
      const pair = assessmentPairs[i]
      const assessment = assessments[i] ?? { isSubstantial: false, isConcluded: false }

      if (assessment.isSubstantial) {
        db.users.enqueueSignalForAllUsers({ type: 'substantial_new_info', topicId: pair.topic.id, articleId: pair.savedId })
        db.users.unreadTopicForNonDownvoters(pair.topic.id)
      } else {
        db.users.enqueueSignalForAllUsers({ type: 'added_to_topic', topicId: pair.topic.id, articleId: pair.savedId })
      }

      if (assessment.isConcluded) {
        db.users.enqueueSignalForAllUsers({ type: 'concluded_issue', topicId: pair.topic.id, articleId: pair.savedId })
      }

      const articleCount = db.news.getArticleCountByTopic(pair.topic.id)
      if (assessment.isSubstantial || (articleCount >= 2 && !pair.topic.summary)) {
        if (!topicsNeedingSummary.includes(pair.topic.id)) {
          topicsNeedingSummary.push(pair.topic.id)
        }
      }
    }

    // Phase 4: Batch-regenerate summaries for all topics that need it
    if (topicsNeedingSummary.length > 0) {
      await regenerateTopicSummaries(ai, db, topicsNeedingSummary)
    }

    // Phase 5: Batch-create new topics for unmatched articles
    const unmatchedArticles: RawArticle[] = []
    for (let i = 0; i < articles.length; i++) {
      const topics = matchesByIndex.get(i)
      if (!topics || topics.length === 0) {
        unmatchedArticles.push(articles[i])
      }
    }

    if (unmatchedArticles.length > 0) {
      const newTopicInfos = await generateTopicSummaries(ai, unmatchedArticles)
      for (let i = 0; i < unmatchedArticles.length; i++) {
        const info = newTopicInfos[i]
        const topic = db.news.createTopic(info.title, info.description)
        const saved = db.news.addArticle({
          topicIds: [topic.id],
          source: unmatchedArticles[i].source,
          url: unmatchedArticles[i].url,
          title: unmatchedArticles[i].title,
          text: unmatchedArticles[i].text,
        })
        db.users.enqueueSignalForAllUsers({ type: 'new_topic', topicId: topic.id, articleId: saved.id })
      }
    }
  }

  async function ungroupArticle(articleId: number, topicId: number): Promise<{ newTopicIds: number[] }> {
    const article = db.news.getArticleById(articleId)
    if (!article) throw new Error(`Article ${articleId} not found`)

    db.news.unlinkArticleFromTopic(articleId, topicId)

    // Re-classify: run paginated matching excluding the old topic
    const asRaw: RawArticle = { title: article.title, text: article.text, source: article.source, url: article.url }
    const totalTopics = db.news.topicCount()
    let offset = 0
    const matchedTopics: Topic[] = []

    while (offset < totalTopics) {
      const topicPage = db.news.listTopicsPaginated(TOPIC_PAGE_SIZE, offset).filter((t) => t.id !== topicId)
      if (topicPage.length > 0) {
        const results = await matchBatchAgainstTopics(ai, [asRaw], topicPage)
        for (const { topics } of results) {
          matchedTopics.push(...topics)
        }
      }
      offset += TOPIC_PAGE_SIZE
    }

    const newTopicIds: number[] = []

    if (matchedTopics.length > 0) {
      for (const topic of matchedTopics) {
        db.news.linkArticleToTopic(articleId, topic.id)
        db.news.updateTopicTimestamp(topic.id)
        db.users.enqueueSignalForAllUsers({ type: 'added_to_topic', topicId: topic.id, articleId })
        const count = db.news.getArticleCountByTopic(topic.id)
        if (count >= 2 && !topic.summary) {
          await regenerateTopicSummary(ai, db, topic.id)
        }
        newTopicIds.push(topic.id)
      }
    } else {
      // No match — create standalone topic
      const { title, description } = await generateTopicSummary(ai, asRaw)
      const newTopic = db.news.createTopic(title, description)
      db.news.linkArticleToTopic(articleId, newTopic.id)
      db.users.enqueueSignalForAllUsers({ type: 'new_topic', topicId: newTopic.id, articleId })
      newTopicIds.push(newTopic.id)
    }

    // Update legacy topic_id to first new topic
    if (newTopicIds.length > 0) {
      db.news.linkArticleToTopic(articleId, newTopicIds[0])
    }

    // Clean up old topic
    const oldCount = db.news.getArticleCountByTopic(topicId)
    if (oldCount === 0) {
      db.news.deleteTopic(topicId)
    } else if (oldCount >= 2) {
      await regenerateTopicSummary(ai, db, topicId)
    }

    return { newTopicIds }
  }

  return {
    enqueue,
    ungroupArticle,
    status() {
      let estimatedBehindMs: number | null = null

      if (batchHistory.length > 0) {
        let totalProcessingMs = 0
        let totalArticles = 0
        for (const b of batchHistory) {
          totalProcessingMs += b.endedAt - b.startedAt
          totalArticles += b.articleCount
        }

        if (totalArticles > 0 && totalProcessingMs > 0) {
          const msPerArticle = totalProcessingMs / totalArticles
          estimatedBehindMs = Math.round(buffer.length * msPerArticle)
        }
      }

      return { bufferDepth: buffer.length, processing, estimatedBehindMs }
    },
    start() {
      timer = setInterval(drain, DRAIN_INTERVAL_MS)
    },
    stop() {
      if (timer) clearInterval(timer)
    },
  }
}

interface BatchMatchEntry {
  articleIndex: number
  topics: Topic[]
}

async function matchBatchAgainstTopics(
  ai: AiClient,
  articles: RawArticle[],
  topics: Topic[],
): Promise<BatchMatchEntry[]> {
  if (topics.length === 0 || articles.length === 0) return []

  const articleList = articles
    .map((a, i) => `${i}: ${a.title} — ${a.text.slice(0, 200)}`)
    .join('\n')

  // Fixed overhead = instructions + article list (articles are constant across topic sub-chunks)
  const instructionsPrefix = `You are a news editor. Match new articles to existing topics.\n\nExisting topics:\n`
  const instructionsSuffix = `\n\nNew articles:\n${articleList}\n\nFor each article, decide which existing topics it belongs to. An article may match multiple topics if it covers multiple subjects. Only match if the article contains substantial information about that topic — a passing mention is not enough.\nReply with a JSON array. Each entry has "article" (the article index number) and "topicIds" (an array of matching topic ID numbers, or an empty array if no match).\n\nExample: [{"article": 0, "topicIds": [5, 12]}, {"article": 1, "topicIds": []}]\n\nReply with ONLY the JSON array, no other text.`
  const fixedOverhead = estimateTokens(instructionsPrefix + instructionsSuffix)

  const renderedTopics = topics.map((t) => `${t.id}: ${t.title} — ${t.description}`)
  const chunks = chunkByTokens(topics, renderedTopics, inputBudget(ai, fixedOverhead))

  const entries: BatchMatchEntry[] = []

  for (const chunk of chunks) {
    const topicList = chunk.map((t) => `${t.id}: ${t.title} — ${t.description}`).join('\n')
    const response = await ai.complete(instructionsPrefix + topicList + instructionsSuffix)

    try {
      const results = JSON.parse(stripCodeFences(response)) as { article: number; topicIds: number[] }[]
      for (const result of results) {
        if (!result.topicIds || result.topicIds.length === 0) continue
        const matchedTopics = result.topicIds
          .map((id) => chunk.find((t) => t.id === id))
          .filter((t): t is Topic => !!t)
        if (matchedTopics.length > 0) {
          // Merge into existing entry if one exists for this article index
          const existing = entries.find((e) => e.articleIndex === result.article)
          if (existing) {
            existing.topics.push(...matchedTopics)
          } else {
            entries.push({ articleIndex: result.article, topics: matchedTopics })
          }
        }
      }
    } catch {
      console.error('[consolidator] failed to parse batch match response, treating chunk as unmatched:', response)
    }
  }

  return entries
}

async function generateTopicSummary(ai: AiClient, article: RawArticle): Promise<{ title: string; description: string }> {
  const response = await ai.complete(
    `You are a news editor. Create a topic entry for this new article.

Article:
Title: ${article.title}
Text: ${article.text.slice(0, 500)}

Reply with JSON only: { "title": "short topic title", "description": "one sentence terse description" }`,
  )

  try {
    const json = JSON.parse(stripCodeFences(response)) as { title: string; description: string }
    return { title: json.title, description: json.description }
  } catch {
    return { title: article.title.slice(0, 80), description: article.text.slice(0, 120) }
  }
}

/** Batch-generate topic summaries for multiple unmatched articles in one or more LLM calls */
async function generateTopicSummaries(
  ai: AiClient,
  articles: RawArticle[],
): Promise<{ title: string; description: string }[]> {
  if (articles.length === 0) return []
  if (articles.length === 1) {
    return [await generateTopicSummary(ai, articles[0])]
  }

  const instructionsPrefix = `You are a news editor. Create topic entries for each of these new articles.\n\nArticles:\n`
  const instructionsSuffix = `\n\nFor each article, create a topic with a short title and a one-sentence terse description.\nReply with a JSON array where each entry has "index" (the article number), "title", and "description".\n\nExample: [{"index": 0, "title": "...", "description": "..."}, {"index": 1, "title": "...", "description": "..."}]\n\nReply with ONLY the JSON array, no other text.`
  const fixedOverhead = estimateTokens(instructionsPrefix + instructionsSuffix)

  // Build results with fallbacks (overridden on successful parse)
  const results: { title: string; description: string }[] = articles.map((a) => ({
    title: a.title.slice(0, 80),
    description: a.text.slice(0, 120),
  }))

  // Render with placeholder index; we'll renumber per chunk to keep LLM indices 0-based per call
  const renderedItems = articles.map((a) => `"${a.title}" — ${a.text.slice(0, 300)}`)
  const indexes = articles.map((_, i) => i)
  const chunks = chunkByTokens(indexes, renderedItems, inputBudget(ai, fixedOverhead))

  for (const chunk of chunks) {
    // Single-item chunk: use simpler prompt for better results
    if (chunk.length === 1) {
      results[chunk[0]] = await generateTopicSummary(ai, articles[chunk[0]])
      continue
    }

    const articleList = chunk
      .map((originalIndex, localIndex) => `${localIndex}: "${articles[originalIndex].title}" — ${articles[originalIndex].text.slice(0, 300)}`)
      .join('\n\n')

    const response = await ai.complete(instructionsPrefix + articleList + instructionsSuffix)

    try {
      const parsed = JSON.parse(stripCodeFences(response)) as { index: number; title: string; description: string }[]
      for (const entry of parsed) {
        if (entry.index >= 0 && entry.index < chunk.length && entry.title && entry.description) {
          const originalIndex = chunk[entry.index]
          results[originalIndex] = { title: entry.title, description: entry.description }
        }
      }
    } catch {
      console.error('[consolidator] failed to parse batch topic summaries chunk, using fallbacks:', response)
    }
  }

  return results
}

/** Batch-regenerate summaries for multiple topics in one LLM call */
async function regenerateTopicSummaries(ai: AiClient, db: Db, topicIds: number[]): Promise<void> {
  // Gather context for each topic
  interface TopicContext {
    topicId: number
    topic: Topic
    articleContext: string
  }
  const contexts: TopicContext[] = []

  for (const topicId of topicIds) {
    const articles = db.news.listRecentArticlesByTopic(topicId, 10)
    if (articles.length < 2) continue
    const topic = db.news.listTopics().find((t) => t.id === topicId)
    if (!topic) continue
    const articleContext = articles
      .map((a) => `- "${a.title}" (${a.source}): ${a.text.slice(0, 200)}`)
      .join('\n')
    contexts.push({ topicId, topic, articleContext })
  }

  if (contexts.length === 0) return

  // Single topic — use simpler prompt
  if (contexts.length === 1) {
    const ctx = contexts[0]
    try {
      const response = await ai.complete(
        `You are a news editor. Write a concise 2-3 sentence summary of this news topic based on the latest articles.\n` +
          `Some articles may cover multiple topics — focus ONLY on aspects relevant to this specific topic.\n\n` +
          `Topic: ${ctx.topic.title}\n` +
          `Background: ${ctx.topic.description}\n\n` +
          `Recent articles:\n${ctx.articleContext}\n\n` +
          `Reply with ONLY the summary text, no JSON, no formatting.`,
      )
      const summary = response.trim()
      if (summary) {
        db.news.updateTopicSummary(ctx.topicId, summary)
      }
    } catch {
      console.error(`[consolidator] failed to generate summary for topic ${ctx.topicId}`)
    }
    return
  }

  // Multiple topics — split by token budget and batch each chunk
  const instructionsPrefix = `You are a news editor. Write concise 2-3 sentence summaries for each of the following news topics based on their latest articles.\nSome articles may cover multiple topics — focus ONLY on aspects relevant to each specific topic.\n\n`
  const instructionsSuffix = `\n\nReply with a JSON array where each entry has "topicId" (the topic ID number) and "summary" (the 2-3 sentence summary text).\n\nExample: [{"topicId": 5, "summary": "..."}, {"topicId": 12, "summary": "..."}]\n\nReply with ONLY the JSON array, no other text.`
  const fixedOverhead = estimateTokens(instructionsPrefix + instructionsSuffix)

  const renderedContexts = contexts.map(
    (ctx) =>
      `Topic ${ctx.topicId}: "${ctx.topic.title}"\nBackground: ${ctx.topic.description}\nRecent articles:\n${ctx.articleContext}`,
  )
  const chunks = chunkByTokens(contexts, renderedContexts, inputBudget(ai, fixedOverhead))

  for (const chunk of chunks) {
    // Single-context chunk: use simpler single-topic prompt path
    if (chunk.length === 1) {
      const ctx = chunk[0]
      try {
        const response = await ai.complete(
          `You are a news editor. Write a concise 2-3 sentence summary of this news topic based on the latest articles.\n` +
            `Some articles may cover multiple topics — focus ONLY on aspects relevant to this specific topic.\n\n` +
            `Topic: ${ctx.topic.title}\n` +
            `Background: ${ctx.topic.description}\n\n` +
            `Recent articles:\n${ctx.articleContext}\n\n` +
            `Reply with ONLY the summary text, no JSON, no formatting.`,
        )
        const summary = response.trim()
        if (summary) {
          db.news.updateTopicSummary(ctx.topicId, summary)
        }
      } catch {
        console.error(`[consolidator] failed to generate summary for topic ${ctx.topicId}`)
      }
      continue
    }

    const topicList = chunk
      .map(
        (ctx) =>
          `Topic ${ctx.topicId}: "${ctx.topic.title}"\nBackground: ${ctx.topic.description}\nRecent articles:\n${ctx.articleContext}`,
      )
      .join('\n\n---\n\n')

    try {
      const response = await ai.complete(instructionsPrefix + topicList + instructionsSuffix)

      const parsed = JSON.parse(stripCodeFences(response)) as { topicId: number; summary: string }[]
      for (const entry of parsed) {
        if (entry.topicId && entry.summary?.trim()) {
          const ctx = chunk.find((c) => c.topicId === entry.topicId)
          if (ctx) {
            db.news.updateTopicSummary(entry.topicId, entry.summary.trim())
          }
        }
      }
    } catch {
      console.error('[consolidator] failed to parse batch summary regeneration chunk, skipping')
    }
  }
}

/** Single-article assessment (used by ungroupArticle) */
async function regenerateTopicSummary(ai: AiClient, db: Db, topicId: number): Promise<void> {
  return regenerateTopicSummaries(ai, db, [topicId])
}

interface ArticleAssessment {
  isSubstantial: boolean
  isConcluded: boolean
}

interface AssessmentPairInput {
  article: RawArticle
  savedId: number
  topic: Topic
  recentArticleTitles: string[]
}

/** Batch-assess multiple article-topic pairs in one LLM call */
async function assessArticleBatch(
  ai: AiClient,
  pairs: AssessmentPairInput[],
): Promise<ArticleAssessment[]> {
  if (pairs.length === 1) {
    // Single pair — use simpler prompt
    const pair = pairs[0]
    const recentContext =
      pair.recentArticleTitles.length > 0
        ? `Recent articles on this topic:\n${pair.recentArticleTitles.map((t) => `- ${t}`).join('\n')}`
        : 'This is the first follow-up article on this topic.'

    const response = await ai.complete(
      `You are a news editor. Assess this new article in the context of an ongoing topic.

Topic: ${pair.topic.title}
Background: ${pair.topic.description}

${recentContext}

New article:
Title: ${pair.article.title}
Text: ${pair.article.text.slice(0, 300)}

Determine:
1. "isSubstantial": Is this a major new development (not just a routine update or minor rehash)?
2. "isConcluded": Does this article indicate the issue/story has reached a conclusion or resolution (e.g., final verdict, deal closed, crisis resolved, investigation completed)?

Reply with ONLY JSON: {"isSubstantial": true/false, "isConcluded": true/false}`,
    )

    try {
      const json = JSON.parse(stripCodeFences(response)) as ArticleAssessment
      return [{ isSubstantial: !!json.isSubstantial, isConcluded: !!json.isConcluded }]
    } catch {
      console.error('[consolidator] failed to parse article assessment, defaulting:', response)
      return [{ isSubstantial: false, isConcluded: false }]
    }
  }

  // Multiple pairs — split by token budget and batch each chunk
  const instructionsPrefix = `You are a news editor. Assess each new article in the context of its topic.\n\nFor each pair below, determine:\n- "isSubstantial": Is this a major new development (not just a routine update or minor rehash)?\n- "isConcluded": Does this article indicate the story has reached a conclusion or resolution?\n\nPairs:\n`
  const instructionsSuffix = `\n\nReply with a JSON array, one entry per pair in order:\n[{"index": 0, "isSubstantial": true/false, "isConcluded": true/false}, ...]\n\nReply with ONLY the JSON array, no other text.`
  const fixedOverhead = estimateTokens(instructionsPrefix + instructionsSuffix)

  function renderPair(pair: AssessmentPairInput, localIndex: number): string {
    const recentContext =
      pair.recentArticleTitles.length > 0
        ? `Recent: ${pair.recentArticleTitles.join('; ')}`
        : 'First follow-up.'
    return `${localIndex}. Topic: "${pair.topic.title}" (${pair.topic.description}). ${recentContext}\n   Article: "${pair.article.title}" — ${pair.article.text.slice(0, 200)}`
  }

  // Default all to non-substantial/non-concluded (overridden on successful parse)
  const results: ArticleAssessment[] = pairs.map(() => ({ isSubstantial: false, isConcluded: false }))

  // Render each pair once for budgeting (local index 0 — cheap enough, exact wording irrelevant for size)
  const renderedPairs = pairs.map((p, i) => renderPair(p, i))
  const pairIndexes = pairs.map((_, i) => i)
  const chunks = chunkByTokens(pairIndexes, renderedPairs, inputBudget(ai, fixedOverhead))

  for (const chunk of chunks) {
    // Single-pair chunk: recurse into the single-pair fast path above
    if (chunk.length === 1) {
      const single = await assessArticleBatch(ai, [pairs[chunk[0]]])
      results[chunk[0]] = single[0]
      continue
    }

    const pairList = chunk
      .map((originalIndex, localIndex) => renderPair(pairs[originalIndex], localIndex))
      .join('\n\n')

    const response = await ai.complete(instructionsPrefix + pairList + instructionsSuffix)

    try {
      const parsed = JSON.parse(stripCodeFences(response)) as { index: number; isSubstantial: boolean; isConcluded: boolean }[]
      for (const entry of parsed) {
        if (entry.index >= 0 && entry.index < chunk.length) {
          const originalIndex = chunk[entry.index]
          results[originalIndex] = {
            isSubstantial: !!entry.isSubstantial,
            isConcluded: !!entry.isConcluded,
          }
        }
      }
    } catch {
      console.error('[consolidator] failed to parse batch assessment chunk, defaulting to non-substantial/non-concluded:', response)
    }
  }

  return results
}
