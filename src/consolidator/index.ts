import type { AiClient } from '../ai/index.js'
import type { Db } from '../db/index.js'
import type { RawArticle } from '../grabber/index.js'
import type { Topic } from '../db/news.js'

const TOPIC_PAGE_SIZE = 50
const ARTICLE_BATCH_SIZE = 10
const DRAIN_INTERVAL_MS = 5_000

/** Strip markdown code fences (```json ... ```) that LLMs often wrap around JSON responses */
function stripCodeFences(text: string): string {
  const trimmed = text.trim()
  const match = trimmed.match(/^```(?:\w*)\n([\s\S]*?)\n```$/)
  return match ? match[1].trim() : trimmed
}

export interface Consolidator {
  /** Push an article into the internal queue (sync, non-blocking) */
  enqueue(article: RawArticle): void
  start(): void
  stop(): void
}

// IMPLEMENTED: batched topic matching with paginated topics, internal queue, concluded_issue detection
// PLANNED: embedding-based pre-filter
export function createConsolidator({ db, ai }: { db: Db; ai: AiClient }): Consolidator {
  const buffer: RawArticle[] = []
  let timer: ReturnType<typeof setInterval> | null = null
  let processing = false

  function enqueue(article: RawArticle) {
    buffer.push(article)
  }

  async function drain() {
    if (processing || buffer.length === 0) return
    processing = true
    try {
      // Take up to ARTICLE_BATCH_SIZE from the buffer
      const batch = buffer.splice(0, ARTICLE_BATCH_SIZE)

      // Filter out articles already in DB
      const fresh = batch.filter((a) => !db.news.articleExistsByUrl(a.url))
      if (fresh.length === 0) return

      await processBatch(fresh)
    } catch (err) {
      console.error('[consolidator] batch processing error:', err)
    } finally {
      processing = false
    }
  }

  async function processBatch(articles: RawArticle[]): Promise<void> {
    let unmatched = articles
    const totalTopics = db.news.topicCount()
    let offset = 0

    // Page through topics, matching unmatched articles against each page
    while (unmatched.length > 0 && offset < totalTopics) {
      const topicPage = db.news.listTopicsPaginated(TOPIC_PAGE_SIZE, offset)
      if (topicPage.length === 0) break

      const { matched, remaining } = await matchBatchAgainstTopics(ai, unmatched, topicPage)

      // Process matched articles
      for (const { article, topic } of matched) {
        await saveMatchedArticle(article, topic)
      }

      unmatched = remaining
      offset += TOPIC_PAGE_SIZE
    }

    // Anything still unmatched gets a new topic
    for (const article of unmatched) {
      await saveNewTopic(article)
    }
  }

  async function saveMatchedArticle(article: RawArticle, topic: Topic): Promise<void> {
    db.news.updateTopicTimestamp(topic.id)
    const saved = db.news.addArticle({
      topicId: topic.id,
      source: article.source,
      url: article.url,
      title: article.title,
      text: article.text,
    })

    const recentArticleTitles = db.news
      .listRecentArticlesByTopic(topic.id, 6)
      .filter((a) => a.id !== saved.id)
      .slice(0, 5)
      .map((a) => a.title)

    const assessment = await assessArticle(ai, article, topic, recentArticleTitles)

    if (assessment.isSubstantial) {
      db.users.enqueueSignalForAllUsers({ type: 'substantial_new_info', topicId: topic.id, articleId: saved.id })
    } else {
      db.users.enqueueSignalForAllUsers({ type: 'added_to_topic', topicId: topic.id, articleId: saved.id })
    }

    if (assessment.isConcluded) {
      db.users.enqueueSignalForAllUsers({ type: 'concluded_issue', topicId: topic.id, articleId: saved.id })
    }
  }

  async function saveNewTopic(article: RawArticle): Promise<void> {
    const { title, description } = await generateTopicSummary(ai, article)
    const topic = db.news.createTopic(title, description)
    const saved = db.news.addArticle({
      topicId: topic.id,
      source: article.source,
      url: article.url,
      title: article.title,
      text: article.text,
    })
    db.users.enqueueSignalForAllUsers({ type: 'new_topic', topicId: topic.id, articleId: saved.id })
  }

  return {
    enqueue,
    start() {
      timer = setInterval(drain, DRAIN_INTERVAL_MS)
    },
    stop() {
      if (timer) clearInterval(timer)
    },
  }
}

interface BatchMatchResult {
  matched: { article: RawArticle; topic: Topic }[]
  remaining: RawArticle[]
}

async function matchBatchAgainstTopics(
  ai: AiClient,
  articles: RawArticle[],
  topics: Topic[],
): Promise<BatchMatchResult> {
  const topicList = topics.map((t) => `${t.id}: ${t.title} — ${t.description}`).join('\n')

  const articleList = articles
    .map((a, i) => `${i}: ${a.title} — ${a.text.slice(0, 200)}`)
    .join('\n')

  const response = await ai.complete(
    `You are a news editor. Match new articles to existing topics.

Existing topics:
${topicList}

New articles:
${articleList}

For each article, decide if it belongs to one of the existing topics.
Reply with a JSON array. Each entry has "article" (the article index number) and "topicId" (the matching topic ID number, or "none" if no match).

Example: [{"article": 0, "topicId": 5}, {"article": 1, "topicId": "none"}]

Reply with ONLY the JSON array, no other text.`,
  )

  const matched: { article: RawArticle; topic: Topic }[] = []
  const matchedIndices = new Set<number>()

  try {
    const results = JSON.parse(stripCodeFences(response)) as { article: number; topicId: number | 'none' }[]
    for (const result of results) {
      if (result.topicId === 'none') continue
      const article = articles[result.article]
      const topic = topics.find((t) => t.id === result.topicId)
      if (article && topic) {
        matched.push({ article, topic })
        matchedIndices.add(result.article)
      }
    }
  } catch {
    console.error('[consolidator] failed to parse batch match response, treating all as unmatched:', response)
  }

  const remaining = articles.filter((_, i) => !matchedIndices.has(i))
  return { matched, remaining }
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

interface ArticleAssessment {
  isSubstantial: boolean
  isConcluded: boolean
}

async function assessArticle(
  ai: AiClient,
  article: RawArticle,
  topic: Topic,
  recentArticleTitles: string[],
): Promise<ArticleAssessment> {
  const recentContext =
    recentArticleTitles.length > 0
      ? `Recent articles on this topic:\n${recentArticleTitles.map((t) => `- ${t}`).join('\n')}`
      : 'This is the first follow-up article on this topic.'

  const response = await ai.complete(
    `You are a news editor. Assess this new article in the context of an ongoing topic.

Topic: ${topic.title}
Background: ${topic.description}

${recentContext}

New article:
Title: ${article.title}
Text: ${article.text.slice(0, 300)}

Determine:
1. "isSubstantial": Is this a major new development (not just a routine update or minor rehash)?
2. "isConcluded": Does this article indicate the issue/story has reached a conclusion or resolution (e.g., final verdict, deal closed, crisis resolved, investigation completed)?

Reply with ONLY JSON: {"isSubstantial": true/false, "isConcluded": true/false}`,
  )

  try {
    const json = JSON.parse(stripCodeFences(response)) as ArticleAssessment
    return {
      isSubstantial: !!json.isSubstantial,
      isConcluded: !!json.isConcluded,
    }
  } catch {
    console.error('[consolidator] failed to parse article assessment, defaulting to non-substantial/non-concluded:', response)
    return { isSubstantial: false, isConcluded: false }
  }
}
