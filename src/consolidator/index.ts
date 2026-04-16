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
  /** Remove an article from a topic and re-classify it against other topics */
  ungroupArticle(articleId: number, topicId: number): Promise<{ newTopicIds: number[] }>
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

    // Save matched articles, create new topics for unmatched
    for (let i = 0; i < articles.length; i++) {
      const topics = matchesByIndex.get(i)
      if (topics && topics.length > 0) {
        await saveMatchedArticle(articles[i], topics)
      } else {
        await saveNewTopic(articles[i])
      }
    }
  }

  async function saveMatchedArticle(article: RawArticle, topics: Topic[]): Promise<void> {
    const saved = db.news.addArticle({
      topicIds: topics.map((t) => t.id),
      source: article.source,
      url: article.url,
      title: article.title,
      text: article.text,
    })

    for (const topic of topics) {
      db.news.updateTopicTimestamp(topic.id)

      const recentArticleTitles = db.news
        .listRecentArticlesByTopic(topic.id, 6)
        .filter((a) => a.id !== saved.id)
        .slice(0, 5)
        .map((a) => a.title)

      const assessment = await assessArticle(ai, article, topic, recentArticleTitles)

      if (assessment.isSubstantial) {
        db.users.enqueueSignalForAllUsers({ type: 'substantial_new_info', topicId: topic.id, articleId: saved.id })
        db.users.unreadTopicForNonDownvoters(topic.id)
      } else {
        db.users.enqueueSignalForAllUsers({ type: 'added_to_topic', topicId: topic.id, articleId: saved.id })
      }

      if (assessment.isConcluded) {
        db.users.enqueueSignalForAllUsers({ type: 'concluded_issue', topicId: topic.id, articleId: saved.id })
      }

      // Generate or regenerate topic summary
      const articleCount = db.news.getArticleCountByTopic(topic.id)
      if (assessment.isSubstantial || (articleCount >= 2 && !topic.summary)) {
        await regenerateTopicSummary(ai, db, topic.id)
      }
    }
  }

  async function saveNewTopic(article: RawArticle): Promise<void> {
    const { title, description } = await generateTopicSummary(ai, article)
    const topic = db.news.createTopic(title, description)
    const saved = db.news.addArticle({
      topicIds: [topic.id],
      source: article.source,
      url: article.url,
      title: article.title,
      text: article.text,
    })
    db.users.enqueueSignalForAllUsers({ type: 'new_topic', topicId: topic.id, articleId: saved.id })
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

For each article, decide which existing topics it belongs to. An article may match multiple topics if it covers multiple subjects. Only match if the article contains substantial information about that topic — a passing mention is not enough.
Reply with a JSON array. Each entry has "article" (the article index number) and "topicIds" (an array of matching topic ID numbers, or an empty array if no match).

Example: [{"article": 0, "topicIds": [5, 12]}, {"article": 1, "topicIds": []}]

Reply with ONLY the JSON array, no other text.`,
  )

  const entries: BatchMatchEntry[] = []

  try {
    const results = JSON.parse(stripCodeFences(response)) as { article: number; topicIds: number[] }[]
    for (const result of results) {
      if (!result.topicIds || result.topicIds.length === 0) continue
      const matchedTopics = result.topicIds
        .map((id) => topics.find((t) => t.id === id))
        .filter((t): t is Topic => !!t)
      if (matchedTopics.length > 0) {
        entries.push({ articleIndex: result.article, topics: matchedTopics })
      }
    }
  } catch {
    console.error('[consolidator] failed to parse batch match response, treating all as unmatched:', response)
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

async function regenerateTopicSummary(ai: AiClient, db: Db, topicId: number): Promise<void> {
  const articles = db.news.listRecentArticlesByTopic(topicId, 10)
  if (articles.length < 2) return

  const articleContext = articles
    .map((a) => `- "${a.title}" (${a.source}): ${a.text.slice(0, 200)}`)
    .join('\n')

  const topic = db.news.listTopics().find((t) => t.id === topicId)
  if (!topic) return

  try {
    const response = await ai.complete(
      `You are a news editor. Write a concise 2-3 sentence summary of this news topic based on the latest articles.\n` +
        `Some articles may cover multiple topics — focus ONLY on aspects relevant to this specific topic.\n\n` +
        `Topic: ${topic.title}\n` +
        `Background: ${topic.description}\n\n` +
        `Recent articles:\n${articleContext}\n\n` +
        `Reply with ONLY the summary text, no JSON, no formatting.`,
    )
    const summary = response.trim()
    if (summary) {
      db.news.updateTopicSummary(topicId, summary)
    }
  } catch {
    console.error(`[consolidator] failed to generate summary for topic ${topicId}`)
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
