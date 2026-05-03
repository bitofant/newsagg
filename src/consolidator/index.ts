import { getAi, type InferenceProvider } from '../ai/index.js'
import { MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS_REASONING } from '../ai/provider.js'
import type { ConsolidatorConfig, EmbeddingConfig } from '../config.js'
import type { Db } from '../db/index.js'
import type { RawArticle } from '../grabber/index.js'
import type { Article, Topic } from '../db/news.js'
import type { FrontPage, FrontPageSection } from '../aggregator/index.js'
import { getEmbedder, type Embedder } from '../embeddings/index.js'

const ARTICLE_BATCH_SIZE = 10
const DRAIN_INTERVAL_MS = 5_000
/** A topic switches from prose-only summary to summary+bullets format once it has had this many `substantial_new_info` events. */
const BULLETS_THRESHOLD = 2

/** Canonical text used to embed a topic. Must be deterministic across create-time and regen-time so the same topic content always embeds the same way. */
function topicEmbedSource(t: Topic): string {
  const parts = [t.title, t.description]
  if (t.summary) parts.push(t.summary)
  if (t.bullets && t.bullets.length > 0) parts.push(t.bullets.join('. '))
  return parts.join('. ')
}

/** Canonical text used to embed an article at match time. The model truncates around 256 tokens internally. */
function articleEmbedSource(a: RawArticle): string {
  return `${a.title}. ${a.text.slice(0, 500)}`
}

/** Cosine similarity for L2-normalized vectors. */
function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!
  return s
}

/** Slack for tokenization inaccuracy and unexpected prompt expansion. */
const BUDGET_SAFETY_MARGIN = 256
/** Minimum input budget: even a tiny context window should fit something. */
const MIN_INPUT_BUDGET = 512

/** Rough estimate: ~4 chars per token. Good enough for prompt sizing (failure mode is a smaller chunk, not a rejected call). */
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4)
}

/** Tokens available for dynamic prompt content, given the fixed instruction overhead for a call. */
function inputBudget(ai: InferenceProvider, fixedOverheadTokens: number, reasoningEnabled = false): number {
  const outputReserve = reasoningEnabled ? MAX_OUTPUT_TOKENS_REASONING : MAX_OUTPUT_TOKENS
  return Math.max(
    MIN_INPUT_BUDGET,
    ai.maxContextTokens - outputReserve - fixedOverheadTokens - BUDGET_SAFETY_MARGIN,
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
  /** Split a topic's articles into 2+ new topics via LLM, rewrite affected front pages in place. */
  unmergeTopic(topicId: number): Promise<{ newTopicIds: number[]; affectedUserIds: number[] }>
  /** Merge `loserId` into `winnerId`: rewire articles, rewrite affected front pages, enqueue summary regen, delete loser. */
  mergeTopic(loserId: number, winnerId: number): Promise<{ winnerId: number; affectedUserIds: number[] }>
  /** Queue a topic for background summary regeneration on the next drain. Deduped via a Set. */
  enqueueRegen(topicId: number): void
  status(): {
    bufferDepth: number
    processing: boolean
    pendingRegens: number
    estimatedBehindMs: number | null
  }
  start(): void
  stop(): void
}

// IMPLEMENTED: batched topic matching with embedding pre-filter, internal queue, concluded_issue detection
export function createConsolidator({
  db,
  config,
  embedding,
}: {
  db: Db
  config: ConsolidatorConfig
  embedding: EmbeddingConfig
}): Consolidator {
  const buffer: RawArticle[] = []
  const pendingUrls = new Set<string>()
  const pendingRegenTopicIds = new Set<number>()
  let timer: ReturnType<typeof setInterval> | null = null
  let processing = false
  /** First-pass embedding backfill for topics missing/mismatched embeddings. The very first drain awaits this; subsequent drains read freely. */
  let backfillReady: Promise<void> | null = null
  const batchHistory: { startedAt: number; endedAt: number; articleCount: number }[] = []

  function enqueue(article: RawArticle) {
    // Dedup: skip if already queued, or already saved to DB
    if (pendingUrls.has(article.url)) return
    if (db.news.articleExistsByUrl(article.url)) return
    buffer.push(article)
    pendingUrls.add(article.url)
  }

  function enqueueRegen(topicId: number) {
    pendingRegenTopicIds.add(topicId)
  }

  async function embedAndStoreTopicsByIds(embedder: Embedder, ids: number[]): Promise<void> {
    if (ids.length === 0) return
    const topics = db.news.listTopicsByIds(ids)
    if (topics.length === 0) return
    const vecs = await embedder.embed(topics.map(topicEmbedSource))
    for (let i = 0; i < topics.length; i++) {
      db.news.updateTopicEmbedding(topics[i]!.id, vecs[i]!, embedding.model)
    }
  }

  /**
   * Wraps `regenerateTopicSummaries` with a re-embed of every touched topic. Keeps stored embeddings
   * in sync with the topic's current summary/bullets, since `topicEmbedSource` includes both.
   */
  async function regenerateAndEmbed(ai: InferenceProvider, ids: number[]): Promise<void> {
    if (ids.length === 0) return
    await regenerateTopicSummaries(ai, db, ids)
    await embedAndStoreTopicsByIds(getEmbedder(), ids)
  }

  /**
   * Per-batch pre-filter. For each article, score every topic embedding by cosine and pick:
   *   - all topics with `cosine >= candidateThreshold`, capped at `candidateMaxK`, OR
   *   - if fewer than `candidateMinK` clear the threshold, the top-`candidateMinK` regardless of score
   *     (safety net so genuinely-novel-story articles still get a fair LLM look).
   * Per-article picks are unioned across the batch and sorted by topic id ASC for partial vLLM
   * prefix-cache benefit on consecutive batches whose unions overlap.
   */
  async function preFilterCandidates(articles: RawArticle[], excludeTopicId?: number): Promise<Topic[]> {
    if (articles.length === 0) return []
    const embedder = getEmbedder()
    const articleVecs = await embedder.embed(articles.map(articleEmbedSource))
    const topicEmbs = db.news.listAllTopicEmbeddings(embedding.model)
    if (topicEmbs.length === 0) return []

    const candidateIds = new Set<number>()
    for (const av of articleVecs) {
      const scored: Array<{ id: number; score: number }> = []
      for (const { id, embedding: tv } of topicEmbs) {
        if (excludeTopicId !== undefined && id === excludeTopicId) continue
        scored.push({ id, score: dot(av, tv) })
      }
      scored.sort((a, b) => b.score - a.score)
      const above = scored.filter((s) => s.score >= embedding.candidateThreshold)
      const taken =
        above.length >= embedding.candidateMinK
          ? above.slice(0, embedding.candidateMaxK)
          : scored.slice(0, embedding.candidateMinK)
      for (const t of taken) candidateIds.add(t.id)
    }
    if (candidateIds.size === 0) return []
    const ids = [...candidateIds].sort((a, b) => a - b)
    return db.news.listTopicsByIds(ids)
  }

  async function backfillEmbeddings(): Promise<void> {
    const total = db.news.topicsMissingEmbeddingCount(embedding.model)
    if (total === 0) {
      console.log(`[embed] backfill: 0 topics need embeddings (model ${embedding.model})`)
      return
    }
    console.log(`[embed] backfill: ${total} topic(s) need embeddings (model ${embedding.model})`)
    const embedder = getEmbedder()
    const startedAt = Date.now()
    let done = 0
    while (true) {
      const page = db.news.listTopicsMissingEmbedding(embedding.model, embedding.batchSize, 0)
      if (page.length === 0) break
      const vecs = await embedder.embed(page.map(topicEmbedSource))
      for (let i = 0; i < page.length; i++) {
        db.news.updateTopicEmbedding(page[i]!.id, vecs[i]!, embedding.model)
      }
      done += page.length
      console.log(`[embed] backfilled ${done}/${total}`)
    }
    console.log(`[embed] backfill complete: ${done} topic(s) in ${Date.now() - startedAt}ms`)
  }

  async function drain() {
    if (processing) return
    if (buffer.length === 0 && pendingRegenTopicIds.size === 0) return
    if (backfillReady) {
      // Block the first drain on initial embedding backfill so the pre-filter runs against complete
      // topic coverage. Subsequent drains see a resolved promise (effectively a no-op await) and we
      // null it out so the cost is paid exactly once.
      const ready = backfillReady
      backfillReady = null
      await ready
    }
    processing = true
    try {
      if (buffer.length > 0) {
        const batch = buffer.splice(0, ARTICLE_BATCH_SIZE)
        for (const a of batch) pendingUrls.delete(a.url)

        // Safety net: filter out anything that landed in DB between enqueue and drain
        const fresh = batch.filter((a) => !db.news.articleExistsByUrl(a.url))
        if (fresh.length > 0) {
          const ai = getAi()
          // Resolve "auto" config (max_model_len) before any chunking — `inputBudget` reads
          // `ai.maxContextTokens`, which returns 0 until `doInit()` has run. Without this prime
          // step, the very first batch on a cold process chunks against MIN_INPUT_BUDGET (512)
          // and produces tiny topic-chunks that can't fill a vLLM prefix-cache block.
          await ai.ensureInitialized()
          const startedAt = Date.now()
          await processBatch(ai, fresh)
          const endedAt = Date.now()

          batchHistory.push({ startedAt, endedAt, articleCount: fresh.length })
          const cutoff = endedAt - config.statusWindowMs
          while (batchHistory.length > 0 && batchHistory[0].endedAt < cutoff) {
            batchHistory.shift()
          }
        }
      }

      if (pendingRegenTopicIds.size > 0) {
        const ids = [...pendingRegenTopicIds]
        pendingRegenTopicIds.clear()
        try {
          const ai = getAi()
          await ai.ensureInitialized()
          const startedAt = Date.now()
          await regenerateAndEmbed(ai, ids)
          console.log(`[consolidator] background regen for ${ids.length} topic(s) in ${Date.now() - startedAt}ms`)
        } catch (err) {
          console.error('[consolidator] background regen error:', err)
        }
      }
    } catch (err) {
      console.error('[consolidator] batch processing error:', err)
    } finally {
      processing = false
    }
  }

  async function processBatch(ai: InferenceProvider, articles: RawArticle[]): Promise<void> {
    // Embedding pre-filter: rank all topics by cosine vs each article's embedding, keep the union of
    // per-article candidates, hand a single small candidate set to the LLM matcher. Replaces the
    // previous "page through every topic 50 at a time" loop. The token-budget chunker inside
    // `matchBatchAgainstTopics` will further split if the union somehow grows past one prompt.
    const candidates = await preFilterCandidates(articles)
    console.log(
      `[match] candidates for batch of ${articles.length} article(s): ${candidates.length} unique topic(s)`,
    )

    // Accumulate matched topics per article. With zero candidates we skip the LLM entirely and route
    // every article to new-topic creation (the genuine-novel-story path).
    const matchesByIndex = new Map<number, Topic[]>()
    if (candidates.length > 0) {
      const results = await matchBatchAgainstTopics(ai, articles, candidates)
      for (const { articleIndex, topics } of results) {
        const existing = matchesByIndex.get(articleIndex) ?? []
        existing.push(...topics)
        matchesByIndex.set(articleIndex, existing)
      }
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
        db.news.appendSubstantialEventTimestamp(pair.topic.id, Date.now())
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

    // Build the unmatched-article list for Phase 5 up front so Phase 4 + Phase 5
    // can run their LLM-bound work in parallel (they touch disjoint topics).
    const unmatchedArticles: RawArticle[] = []
    for (let i = 0; i < articles.length; i++) {
      const topics = matchesByIndex.get(i)
      if (!topics || topics.length === 0) {
        unmatchedArticles.push(articles[i])
      }
    }

    const [, newTopicInfos] = await Promise.all([
      topicsNeedingSummary.length > 0
        ? regenerateAndEmbed(ai, topicsNeedingSummary)
        : Promise.resolve(),
      unmatchedArticles.length > 0
        ? generateTopicSummaries(ai, unmatchedArticles)
        : Promise.resolve<{ title: string; description: string }[]>([]),
    ])

    if (unmatchedArticles.length > 0) {
      // Create all new topics first, then embed them in a single batched call before linking
      // articles + signals. Embedding at create-time (rather than waiting for first regen at 2+
      // articles) means novel-story articles in the *next* batch can find these as candidates.
      const newTopics: Topic[] = newTopicInfos.map((info) => db.news.createTopic(info.title, info.description))
      await embedAndStoreTopicsByIds(getEmbedder(), newTopics.map((t) => t.id))
      for (let i = 0; i < unmatchedArticles.length; i++) {
        const topic = newTopics[i]!
        const saved = db.news.addArticle({
          topicIds: [topic.id],
          source: unmatchedArticles[i]!.source,
          url: unmatchedArticles[i]!.url,
          title: unmatchedArticles[i]!.title,
          text: unmatchedArticles[i]!.text,
        })
        db.users.enqueueSignalForAllUsers({ type: 'new_topic', topicId: topic.id, articleId: saved.id })
      }
    }
  }

  async function ungroupArticle(articleId: number, topicId: number): Promise<{ newTopicIds: number[] }> {
    const article = db.news.getArticleById(articleId)
    if (!article) throw new Error(`Article ${articleId} not found`)

    const ai = getAi()
    await ai.ensureInitialized()
    db.news.unlinkArticleFromTopic(articleId, topicId)

    // Re-classify: pre-filter by embedding similarity, then one LLM matching call against the
    // candidate set (excluding the source topic).
    const asRaw: RawArticle = { title: article.title, text: article.text, source: article.source, url: article.url }
    const candidates = await preFilterCandidates([asRaw], topicId)
    const matchedTopics: Topic[] = []
    if (candidates.length > 0) {
      const results = await matchBatchAgainstTopics(ai, [asRaw], candidates)
      for (const { topics } of results) {
        matchedTopics.push(...topics)
      }
    }

    const newTopicIds: number[] = []

    if (matchedTopics.length > 0) {
      for (const topic of matchedTopics) {
        db.news.linkArticleToTopic(articleId, topic.id)
        db.news.updateTopicTimestamp(topic.id)
        db.users.enqueueSignalForAllUsers({ type: 'added_to_topic', topicId: topic.id, articleId })
        const count = db.news.getArticleCountByTopic(topic.id)
        if (count >= 2 && !topic.summary) {
          await regenerateAndEmbed(ai, [topic.id])
        }
        newTopicIds.push(topic.id)
      }
    } else {
      // No match — create standalone topic and embed it so future batches can find it.
      const { title, description } = await generateTopicSummary(ai, asRaw)
      const newTopic = db.news.createTopic(title, description)
      await embedAndStoreTopicsByIds(getEmbedder(), [newTopic.id])
      db.news.linkArticleToTopic(articleId, newTopic.id)
      db.users.enqueueSignalForAllUsers({ type: 'new_topic', topicId: newTopic.id, articleId })
      newTopicIds.push(newTopic.id)
    }

    // Update legacy topic_id to first new topic
    if (newTopicIds.length > 0) {
      db.news.linkArticleToTopic(articleId, newTopicIds[0]!)
    }

    // Clean up old topic
    const oldCount = db.news.getArticleCountByTopic(topicId)
    if (oldCount === 0) {
      db.news.deleteTopic(topicId)
    } else if (oldCount >= 2) {
      await regenerateAndEmbed(ai, [topicId])
    }

    return { newTopicIds }
  }

  async function unmergeTopic(topicId: number): Promise<{ newTopicIds: number[]; affectedUserIds: number[] }> {
    const oldTopic = db.news.getTopic(topicId)
    if (!oldTopic) throw new Error(`Topic ${topicId} not found`)
    const articles = db.news.listArticlesByTopic(topicId)
    if (articles.length < 2) throw new Error('Cannot unmerge a topic with fewer than 2 articles')

    console.log(`[unmerge] start topic ${topicId} "${oldTopic.title}" (${articles.length} articles)`)
    const startedAt = Date.now()

    const ai = getAi()
    await ai.ensureInitialized()
    const llmStart = Date.now()
    const groups = await splitTopicViaLlm(ai, oldTopic, articles)
    console.log(`[unmerge] split (phase 1 + phase 2) returned ${groups.length} groups total in ${Date.now() - llmStart}ms`)

    // Validate + sanitize: keep only valid in-range indices, dedup across groups, then drop empties.
    const seen = new Set<number>()
    const sanitized: { title: string; description: string; localIndices: number[] }[] = []
    for (const g of groups) {
      const indices = (Array.isArray(g.articleIndices) ? g.articleIndices : [])
        .filter((i): i is number => typeof i === 'number' && i >= 0 && i < articles.length && !seen.has(i))
      for (const i of indices) seen.add(i)
      const title = (g.title ?? '').trim()
      const description = (g.description ?? '').trim()
      if (indices.length > 0 && title && description) {
        sanitized.push({ title, description, localIndices: indices })
      }
    }
    // Assign any unassigned articles to the first group (LLM-omitted entries).
    if (sanitized.length > 0) {
      for (let i = 0; i < articles.length; i++) {
        if (!seen.has(i)) {
          sanitized[0].localIndices.push(i)
          seen.add(i)
        }
      }
    }
    if (sanitized.length < 2) {
      throw new Error('LLM split did not produce 2+ non-empty groups')
    }
    console.log(`[unmerge] after sanitize: ${sanitized.length} groups, sizes=[${sanitized.map((g) => g.localIndices.length).join(', ')}]`)

    // Create new topics, link articles
    const newTopics: { id: number; title: string; description: string; articleIds: number[] }[] = []
    for (const g of sanitized) {
      const articleIds = g.localIndices.map((i) => articles[i].id)
      const t = db.news.createTopic(g.title, g.description)
      for (const aid of articleIds) {
        db.news.linkArticleToTopic(aid, t.id)
      }
      newTopics.push({ id: t.id, title: g.title, description: g.description, articleIds })
    }
    console.log(`[unmerge] created ${newTopics.length} new topics: ${newTopics.map((t) => `${t.id}="${t.title}"`).join('; ')}`)

    // Generate summaries for new topics with 2+ articles
    const topicIdsNeedingSummary = newTopics.filter((t) => t.articleIds.length >= 2).map((t) => t.id)
    if (topicIdsNeedingSummary.length > 0) {
      const regenStart = Date.now()
      await regenerateTopicSummaries(ai, db, topicIdsNeedingSummary)
      console.log(`[unmerge] regenerated summaries for ${topicIdsNeedingSummary.length} topics in ${Date.now() - regenStart}ms`)
    } else {
      console.log(`[unmerge] no summaries to regenerate (all new topics single-article)`)
    }

    // Embed every new topic in one batched call. Multi-article topics pick up the regenerated summary
    // (via topicEmbedSource), single-article ones embed off title+description.
    await embedAndStoreTopicsByIds(getEmbedder(), newTopics.map((t) => t.id))

    // Migrate read state and rewrite affected front pages BEFORE deleting the old topic.
    db.users.replaceReadTopic(topicId, newTopics.map((t) => t.id))

    // Build the section template for each new topic (re-read to pick up regenerated summary/bullets).
    const newTopicById = new Map(newTopics.map((t) => [t.id, t] as const))
    function buildSection(newTopicId: number, originalArticleIds: number[]): FrontPageSection {
      const fresh = db.news.getTopic(newTopicId)!
      const meta = newTopicById.get(newTopicId)!
      const articleIdSet = new Set(meta.articleIds)
      const carried = originalArticleIds.filter((id) => articleIdSet.has(id))
      // Fall back to the topic's own article ids if the original section had none in this group.
      const articleIds = carried.length > 0 ? carried : meta.articleIds
      const summary = fresh.summary ?? articles.find((a) => articleIdSet.has(a.id))?.text.slice(0, 300) ?? meta.description
      return {
        topicId: fresh.id,
        topicTitle: fresh.title,
        headline: fresh.title,
        summary,
        bullets: fresh.bullets,
        newInfo: fresh.newInfo,
        articleIds,
      }
    }

    const affectedUserIds: number[] = []
    for (const user of db.users.listAllUsers()) {
      const latest = db.users.getLatestFrontPage(user.id)
      if (!latest) continue
      let page: FrontPage
      try {
        page = JSON.parse(latest.data) as FrontPage
      } catch {
        continue
      }
      const idx = page.sections.findIndex((s) => s.topicId === topicId)
      if (idx === -1) continue
      const originalArticleIds = page.sections[idx].articleIds
      const replacements = newTopics.map((t) => buildSection(t.id, originalArticleIds))
      page.sections.splice(idx, 1, ...replacements)
      page.generatedAt = Date.now()
      db.users.saveFrontPage(user.id, JSON.stringify(page))
      affectedUserIds.push(user.id)
    }
    console.log(`[unmerge] rewrote front pages for ${affectedUserIds.length} user(s)`)

    // Enqueue new_topic signals so future aggregator runs see the new topics
    for (const t of newTopics) {
      if (t.articleIds.length > 0) {
        db.users.enqueueSignalForAllUsers({ type: 'new_topic', topicId: t.id, articleId: t.articleIds[0] })
      }
    }

    // Delete old topic last — this clears its signal queue rows, read-topic rows, and article_topics links
    db.news.deleteTopic(topicId)
    console.log(`[unmerge] done topic ${topicId} → [${newTopics.map((t) => t.id).join(', ')}] in ${Date.now() - startedAt}ms`)

    return { newTopicIds: newTopics.map((t) => t.id), affectedUserIds }
  }

  async function mergeTopic(loserId: number, winnerId: number): Promise<{ winnerId: number; affectedUserIds: number[] }> {
    if (loserId === winnerId) throw new Error('Cannot merge a topic with itself')
    const loser = db.news.getTopic(loserId)
    if (!loser) throw new Error(`Topic ${loserId} not found`)
    const winner = db.news.getTopic(winnerId)
    if (!winner) throw new Error(`Topic ${winnerId} not found`)

    const loserArticles = db.news.listArticlesByTopic(loserId)
    console.log(`[merge] start: ${loserId} "${loser.title}" (${loserArticles.length} articles) → ${winnerId} "${winner.title}"`)
    const startedAt = Date.now()

    // 1. Rewire article links onto winner (idempotent for articles already in both topics)
    for (const a of loserArticles) {
      db.news.linkArticleToTopic(a.id, winnerId)
    }

    // 2. Combine substantial-event timestamps so the threshold-gated long-form mode reflects total history
    const combinedTs = [...winner.substantialEventTimestamps, ...loser.substantialEventTimestamps].sort((a, b) => a - b)
    db.news.setSubstantialEventTimestamps(winnerId, combinedTs)
    db.news.updateTopicTimestamp(winnerId)

    // 3. Read-state union: if a user had loser read, treat winner as read too (don't resurface)
    db.users.unionReadTopic(loserId, winnerId)

    // 4. Queue summary regen for the next drain rather than blocking the request — long-mode regen
    //    on a freshly-merged 30+ article topic can take minutes and HTTP/proxy clients time out.
    //    The aggregator will pick up the fresh summary on its next per-user tick; in the meantime
    //    the front-page rewrite below uses the winner's current (pre-merge) summary.
    if (loserArticles.length > 0) {
      enqueueRegen(winnerId)
    }

    // 5. Rewrite affected front pages in place. If a user's page has only the loser section,
    //    swap in a fresh winner section at the same index. If both are present, drop the loser
    //    section and merge its articleIds into the winner section so nothing is lost.
    const fresh = db.news.getTopic(winnerId)!
    const affectedUserIds: number[] = []
    for (const user of db.users.listAllUsers()) {
      const latest = db.users.getLatestFrontPage(user.id)
      if (!latest) continue
      let page: FrontPage
      try {
        page = JSON.parse(latest.data) as FrontPage
      } catch {
        continue
      }
      const loserIdx = page.sections.findIndex((s) => s.topicId === loserId)
      if (loserIdx === -1) continue
      const loserSection = page.sections[loserIdx]
      const winnerIdx = page.sections.findIndex((s) => s.topicId === winnerId)

      if (winnerIdx === -1) {
        const newSection: FrontPageSection = {
          topicId: fresh.id,
          topicTitle: fresh.title,
          headline: fresh.title,
          summary: fresh.summary ?? loserSection.summary,
          bullets: fresh.bullets,
          newInfo: fresh.newInfo,
          articleIds: loserSection.articleIds,
        }
        page.sections.splice(loserIdx, 1, newSection)
      } else {
        const winnerSection = page.sections[winnerIdx]
        const merged = Array.from(new Set([...winnerSection.articleIds, ...loserSection.articleIds]))
        page.sections[winnerIdx] = {
          ...winnerSection,
          topicTitle: fresh.title,
          headline: fresh.title,
          summary: fresh.summary ?? winnerSection.summary,
          bullets: fresh.bullets,
          newInfo: fresh.newInfo,
          articleIds: merged,
        }
        page.sections.splice(loserIdx, 1)
      }
      page.generatedAt = Date.now()
      db.users.saveFrontPage(user.id, JSON.stringify(page))
      affectedUserIds.push(user.id)
    }
    console.log(`[merge] rewrote front pages for ${affectedUserIds.length} user(s)`)

    // 6. Delete loser last — clears its article_topics, signal_queue, user_read_topics rows,
    //    and repoints articles whose legacy topic_id pointed to loser to a remaining linked topic.
    db.news.deleteTopic(loserId)
    console.log(`[merge] done ${loserId} → ${winnerId} in ${Date.now() - startedAt}ms`)

    return { winnerId, affectedUserIds }
  }

  return {
    enqueue,
    enqueueRegen,
    ungroupArticle,
    unmergeTopic,
    mergeTopic,
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

      return { bufferDepth: buffer.length, processing, pendingRegens: pendingRegenTopicIds.size, estimatedBehindMs }
    },
    start() {
      // Kick off the embedding backfill in the background. The first drain awaits this; we don't
      // block server.listen() or other startup work behind it.
      backfillReady = backfillEmbeddings().catch((err) => {
        console.error('[embed] backfill failed:', err)
      })
      timer = setInterval(drain, DRAIN_INTERVAL_MS)
    },
    stop() {
      if (timer) clearInterval(timer)
    },
  }
}

interface SplitGroup {
  title: string
  description: string
  articleIndices: number[]
}

interface IdentifiedTopic {
  title: string
  description: string
}

/**
 * Two-phase LLM split:
 *   Phase 1 (reasoning) — read all titles, identify the 2-5 distinct sub-topics.
 *   Phase 2 (classification, parallelizable) — assign each article to one of those sub-topics.
 *
 * Splits the partition decision (small, reasoning-shaped) from the article-by-article assignment
 * (large, mechanical), keeping each call's prompt + reasoning chain bounded regardless of how
 * many articles the merged topic contains.
 */
async function splitTopicViaLlm(
  ai: InferenceProvider,
  topic: Topic,
  articles: Article[],
): Promise<SplitGroup[]> {
  console.log(`[unmerge] phase 1: identifying sub-topics from ${articles.length} article titles`)
  const phase1Start = Date.now()
  const identified = await identifyNewTopics(ai, topic, articles)
  console.log(
    `[unmerge] phase 1 returned ${identified.length} sub-topic(s) in ${Date.now() - phase1Start}ms: ${identified
      .map((t) => `"${t.title}"`)
      .join(', ')}`,
  )
  if (identified.length < 2) {
    throw new Error(`Phase 1 produced ${identified.length} sub-topic(s); need at least 2`)
  }

  console.log(`[unmerge] phase 2: assigning ${articles.length} articles to ${identified.length} sub-topics`)
  const phase2Start = Date.now()
  const assignments = await assignArticlesToTopics(ai, articles, identified)
  const assignedCount = assignments.filter((a) => a >= 0).length
  console.log(`[unmerge] phase 2 assigned ${assignedCount}/${articles.length} articles in ${Date.now() - phase2Start}ms`)

  const groups: SplitGroup[] = identified.map((t) => ({
    title: t.title,
    description: t.description,
    articleIndices: [],
  }))
  for (let i = 0; i < articles.length; i++) {
    const idx = assignments[i]
    if (typeof idx === 'number' && idx >= 0 && idx < groups.length) {
      groups[idx].articleIndices.push(i)
    } else {
      // Unassigned (parse failure or out-of-range) → put in the first group; the downstream
      // sanitizer will then drop empty groups and flag <2 non-empty as an error.
      groups[0].articleIndices.push(i)
    }
  }
  return groups
}

/** Phase 1: read all article titles + the original (incorrect) topic, output sub-topic descriptors (default 2). */
async function identifyNewTopics(
  ai: InferenceProvider,
  topic: Topic,
  articles: Article[],
): Promise<IdentifiedTopic[]> {
  const titleList = articles.map((a, i) => `${i}: ${a.title}`).join('\n')
  const prompt = `You are a news editor. The articles below were grouped under one topic, but a user has flagged that the merge was incorrect. Figure out the actual sub-topics they should be split into.

Original (incorrect) topic: ${topic.title} — ${topic.description}

Article titles (${articles.length} total):
${titleList}

CRITICAL: default to EXACTLY 2 sub-topics. The typical wrong-merge looks like one main topic with a smaller unrelated group that got pulled in by accident — expect the split to be very unbalanced (e.g. 50 articles vs 5). Returning 2 is almost always the right answer.

Only return 3 (or at most 4) sub-topics if the articles genuinely cover that many unrelated stories. Do NOT split into more buckets just because you can find different angles, regional variants, or sub-themes of the same story — those belong together. Aspects of one ongoing situation are ONE topic.

For each sub-topic, give a short newspaper-style title and a one-sentence terse description.

Reply with ONLY JSON: { "topics": [{ "title": "...", "description": "..." }, ...] }
At least 2 entries are required.`

  const response = await ai.complete(prompt, { reasoningEffort: 'high' })
  const parsed = JSON.parse(stripCodeFences(response)) as { topics?: IdentifiedTopic[] }
  if (!parsed || !Array.isArray(parsed.topics)) {
    throw new Error('Phase 1 response missing topics array')
  }
  return parsed.topics
    .map((t) => ({ title: (t.title ?? '').trim(), description: (t.description ?? '').trim() }))
    .filter((t) => t.title && t.description)
}

const UNMERGE_ASSIGN_SYSTEM = `You are a news editor. Assign each article in the user's message to exactly one of the candidate topics by index.

Reply with ONLY JSON: { "assignments": [<topicIndex>, <topicIndex>, ...] }
Output exactly one topicIndex per article in the order given.`

/**
 * Phase 2: classify each article into one of the identified sub-topics by index.
 * Token-budget chunked, fans chunks out in parallel via Promise.all. Returns an array of length
 * `articles.length` where each entry is the chosen topic index, or -1 if assignment failed.
 */
async function assignArticlesToTopics(
  ai: InferenceProvider,
  articles: Article[],
  topics: IdentifiedTopic[],
): Promise<number[]> {
  const topicOptions = topics.map((t, i) => `${i}: ${t.title} — ${t.description}`).join('\n')
  // topicOptions is per-unmerge dynamic, kept in user prompt; only the static rules go in systemPrompt.
  const userPrefix = `Topics:\n${topicOptions}\n\nArticles:\n`
  const fixedOverhead = estimateTokens(UNMERGE_ASSIGN_SYSTEM) + estimateTokens(userPrefix)

  const renderedItems = articles.map((a, i) => `${i}: ${a.title} — ${a.text.slice(0, 200)}`)
  const indexes = articles.map((_, i) => i)
  const chunks = chunkByTokens(indexes, renderedItems, inputBudget(ai, fixedOverhead))
  console.log(`[unmerge] phase 2: ${chunks.length} chunk(s), sizes=[${chunks.map((c) => c.length).join(', ')}]`)

  const assignments: number[] = articles.map(() => -1)

  await Promise.all(
    chunks.map(async (chunkIndexes) => {
      const articleList = chunkIndexes
        .map((origIdx, localIdx) => `${localIdx}: ${articles[origIdx].title} — ${articles[origIdx].text.slice(0, 200)}`)
        .join('\n')

      // Per-article output: 1 integer in JSON array ≈ ~5 tokens; pad to 16.
      const response = await ai.complete(userPrefix + articleList, {
        systemPrompt: UNMERGE_ASSIGN_SYSTEM,
        reasoningEffort: 'off',
        maxTokens: Math.min(MAX_OUTPUT_TOKENS, 64 + chunkIndexes.length * 16),
      })

      try {
        const parsed = JSON.parse(stripCodeFences(response)) as { assignments?: unknown }
        if (!Array.isArray(parsed?.assignments)) {
          console.error('[unmerge] phase 2 chunk: assignments missing or not an array, leaving unassigned')
          return
        }
        for (let i = 0; i < chunkIndexes.length && i < parsed.assignments.length; i++) {
          const v = parsed.assignments[i]
          if (typeof v === 'number' && v >= 0 && v < topics.length) {
            assignments[chunkIndexes[i]] = v
          }
        }
      } catch {
        console.error('[unmerge] phase 2 chunk: failed to parse response, leaving unassigned')
      }
    }),
  )

  return assignments
}

interface BatchMatchEntry {
  articleIndex: number
  topics: Topic[]
}

// Versioned constant — keep byte-identical across calls so vLLM prefix caching can reuse the system block.
const TOPIC_MATCH_SYSTEM = `You are a news editor. Match new articles to existing topics. For each article, decide which existing topics it belongs to. An article may match multiple topics if it covers multiple subjects. Only match if the article contains substantial information about that topic — a passing mention is not enough.

Reply with a JSON array. Each entry has "article" (the article index number) and "topicIds" (an array of matching topic ID numbers, or an empty array if no match).

Example: [{"article": 0, "topicIds": [5, 12]}, {"article": 1, "topicIds": []}]

Reply with ONLY the JSON array, no other text.`

async function matchBatchAgainstTopics(
  ai: InferenceProvider,
  articles: RawArticle[],
  topics: Topic[],
): Promise<BatchMatchEntry[]> {
  if (topics.length === 0 || articles.length === 0) return []

  const articleList = articles
    .map((a, i) => `${i}: ${a.title} — ${a.text.slice(0, 200)}`)
    .join('\n')
  const articleSuffix = `\n\nNew articles:\n${articleList}`

  const renderedTopics = topics.map((t) => `${t.id}: ${t.title} — ${t.description}`)
  // Matching uses reasoningEffort: 'high' — reserve the larger output budget so chunking accounts for it.
  const fixedOverhead = estimateTokens(TOPIC_MATCH_SYSTEM) + estimateTokens(articleSuffix) + 8 // "Existing topics:\n"
  const chunks = chunkByTokens(topics, renderedTopics, inputBudget(ai, fixedOverhead, true))

  // Fan out chunks in parallel; merge sequentially after.
  // Topic page goes first: `processBatch` re-runs every batch in a drain against the same paginated
  // topic pages, so the rendered topic chunk is byte-identical across batches. On vLLM block sizes
  // ≥ ~1500 tokens (e.g. hybrid attention/Mamba models like Qwen3.6 → 1568), only a >=1-block stable
  // prefix produces cache hits; an article-first layout never fills one block. See docs/ai.md.
  const chunkResults = await Promise.all(
    chunks.map(async (chunk): Promise<BatchMatchEntry[]> => {
      const topicList = chunk.map((t) => `${t.id}: ${t.title} — ${t.description}`).join('\n')
      const response = await ai.complete(`Existing topics:\n${topicList}${articleSuffix}`, {
        systemPrompt: TOPIC_MATCH_SYSTEM,
        reasoningEffort: 'high',
        priority: 'low',
      })

      try {
        const results = JSON.parse(stripCodeFences(response)) as { article: number; topicIds: number[] }[]
        const out: BatchMatchEntry[] = []
        for (const result of results) {
          if (!result.topicIds || result.topicIds.length === 0) continue
          const matchedTopics = result.topicIds
            .map((id) => chunk.find((t) => t.id === id))
            .filter((t): t is Topic => !!t)
          if (matchedTopics.length > 0) {
            out.push({ articleIndex: result.article, topics: matchedTopics })
          }
        }
        return out
      } catch {
        console.error('[consolidator] failed to parse batch match response, treating chunk as unmatched:', response)
        return []
      }
    }),
  )

  const entries: BatchMatchEntry[] = []
  for (const chunkEntries of chunkResults) {
    for (const entry of chunkEntries) {
      const existing = entries.find((e) => e.articleIndex === entry.articleIndex)
      if (existing) {
        existing.topics.push(...entry.topics)
      } else {
        entries.push(entry)
      }
    }
  }

  return entries
}

async function generateTopicSummary(ai: InferenceProvider, article: RawArticle): Promise<{ title: string; description: string }> {
  const response = await ai.complete(
    `You are a news editor. Create a topic entry for this new article.

Article:
Title: ${article.title}
Text: ${article.text.slice(0, 500)}

Reply with JSON only: { "title": "short topic title", "description": "one sentence terse description" }`,
    { reasoningEffort: 'off', maxTokens: 256 },
  )

  try {
    const json = JSON.parse(stripCodeFences(response)) as { title: string; description: string }
    return { title: json.title, description: json.description }
  } catch {
    return { title: article.title.slice(0, 80), description: article.text.slice(0, 120) }
  }
}

const TOPIC_SUMMARY_SYSTEM = `You are a news editor. Create topic entries for each of the articles in the user's message. For each article, create a topic with a short title and a one-sentence terse description.

Reply with a JSON array where each entry has "index" (the article number), "title", and "description".

Example: [{"index": 0, "title": "...", "description": "..."}, {"index": 1, "title": "...", "description": "..."}]

Reply with ONLY the JSON array, no other text.`

/** Batch-generate topic summaries for multiple unmatched articles in one or more LLM calls */
async function generateTopicSummaries(
  ai: InferenceProvider,
  articles: RawArticle[],
): Promise<{ title: string; description: string }[]> {
  if (articles.length === 0) return []
  if (articles.length === 1) {
    return [await generateTopicSummary(ai, articles[0])]
  }

  const userPrefix = `Articles:\n`
  const fixedOverhead = estimateTokens(TOPIC_SUMMARY_SYSTEM) + estimateTokens(userPrefix)

  // Build results with fallbacks (overridden on successful parse)
  const results: { title: string; description: string }[] = articles.map((a) => ({
    title: a.title.slice(0, 80),
    description: a.text.slice(0, 120),
  }))

  // Render with placeholder index; we'll renumber per chunk to keep LLM indices 0-based per call
  const renderedItems = articles.map((a) => `"${a.title}" — ${a.text.slice(0, 300)}`)
  const indexes = articles.map((_, i) => i)
  const chunks = chunkByTokens(indexes, renderedItems, inputBudget(ai, fixedOverhead))

  await Promise.all(chunks.map(async (chunk) => {
    // Single-item chunk: use simpler prompt for better results
    if (chunk.length === 1) {
      results[chunk[0]] = await generateTopicSummary(ai, articles[chunk[0]])
      return
    }

    const articleList = chunk
      .map((originalIndex, localIndex) => `${localIndex}: "${articles[originalIndex].title}" — ${articles[originalIndex].text.slice(0, 300)}`)
      .join('\n\n')

    // Per-item output ≈ 80 tokens (`{"index":N,"title":"...","description":"..."}`); pad to 200 for safety.
    const response = await ai.complete(userPrefix + articleList, {
      systemPrompt: TOPIC_SUMMARY_SYSTEM,
      reasoningEffort: 'off',
      maxTokens: Math.min(MAX_OUTPUT_TOKENS, 64 + chunk.length * 200),
    })

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
  }))

  return results
}

interface TopicContext {
  topicId: number
  topic: Topic
  articleContext: string
}

/**
 * Regenerate summaries for the given topics. Each topic is dispatched to short-mode (prose only)
 * or long-mode (summary + bullets + newInfo) based on its substantial-event timestamp count.
 * Both groups run in parallel.
 */
async function regenerateTopicSummaries(ai: InferenceProvider, db: Db, topicIds: number[]): Promise<void> {
  const shortContexts: TopicContext[] = []
  const longContexts: TopicContext[] = []

  for (const topicId of topicIds) {
    const articles = db.news.listRecentArticlesByTopic(topicId, 10)
    if (articles.length < 2) continue
    const topic = db.news.getTopic(topicId)
    if (!topic) continue
    const articleContext = articles
      .map((a) => `- "${a.title}" (${a.source}): ${a.text.slice(0, 200)}`)
      .join('\n')
    const ctx: TopicContext = { topicId, topic, articleContext }
    if (topic.substantialEventTimestamps.length >= BULLETS_THRESHOLD) {
      longContexts.push(ctx)
    } else {
      shortContexts.push(ctx)
    }
  }

  await Promise.all([
    shortContexts.length > 0 ? regenerateShortMode(ai, db, shortContexts) : Promise.resolve(),
    longContexts.length > 0 ? regenerateLongMode(ai, db, longContexts) : Promise.resolve(),
  ])
}

const SHORT_MODE_SINGLE_SYSTEM = `You are a news editor. Write a concise 2-3 sentence summary of the news topic in the user's message based on the latest articles.
Some articles may cover multiple topics — focus ONLY on aspects relevant to this specific topic.
Prefer concrete facts (who/what/when) over mood or analysis. Skip emotional content unless paired with a real event.

Reply with ONLY the summary text, no JSON, no formatting.`

const SHORT_MODE_BATCH_SYSTEM = `You are a news editor. Write concise 2-3 sentence summaries for each of the news topics in the user's message based on their latest articles.
Some articles may cover multiple topics — focus ONLY on aspects relevant to each specific topic.
Prefer concrete facts (who/what/when) over mood or analysis. Skip emotional content unless paired with a real event.

Reply with a JSON array where each entry has "topicId" (the topic ID number) and "summary" (the 2-3 sentence summary text).

Example: [{"topicId": 5, "summary": "..."}, {"topicId": 12, "summary": "..."}]

Reply with ONLY the JSON array, no other text.`

async function regenerateShortMode(ai: InferenceProvider, db: Db, contexts: TopicContext[]): Promise<void> {
  if (contexts.length === 1) {
    const ctx = contexts[0]
    try {
      const response = await ai.complete(
        `Topic: ${ctx.topic.title}\n` +
          `Background: ${ctx.topic.description}\n\n` +
          `Recent articles:\n${ctx.articleContext}`,
        { systemPrompt: SHORT_MODE_SINGLE_SYSTEM, reasoningEffort: 'off', maxTokens: 256 },
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

  // Sort for deterministic prefix across re-runs over the same topic set.
  contexts = [...contexts].sort((a, b) => a.topicId - b.topicId)

  const userPrefix = `Topics:\n`
  const fixedOverhead = estimateTokens(SHORT_MODE_BATCH_SYSTEM) + estimateTokens(userPrefix)

  const renderedContexts = contexts.map(
    (ctx) =>
      `Topic ${ctx.topicId}: "${ctx.topic.title}"\nBackground: ${ctx.topic.description}\nRecent articles:\n${ctx.articleContext}`,
  )
  const chunks = chunkByTokens(contexts, renderedContexts, inputBudget(ai, fixedOverhead))

  await Promise.all(chunks.map(async (chunk) => {
    if (chunk.length === 1) {
      await regenerateShortMode(ai, db, chunk)
      return
    }

    const topicList = chunk
      .map(
        (ctx) =>
          `Topic ${ctx.topicId}: "${ctx.topic.title}"\nBackground: ${ctx.topic.description}\nRecent articles:\n${ctx.articleContext}`,
      )
      .join('\n\n---\n\n')

    try {
      // Per-topic output ≈ 200 tokens (2-3 sentences + JSON wrap); pad to 300.
      const response = await ai.complete(userPrefix + topicList, {
        systemPrompt: SHORT_MODE_BATCH_SYSTEM,
        reasoningEffort: 'off',
        maxTokens: Math.min(MAX_OUTPUT_TOKENS, 128 + chunk.length * 300),
      })

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
  }))
}

const LONG_MODE_STYLE_RULES = `CRITICAL — bullet style: extremely terse, half-sentence headlines, like a newspaper ticker. Aim for 3-7 words per bullet. Drop articles, conjunctions, hedging.
  GOOD: "Trump insults Pope"
  GOOD: "Russia advances on Pokrovsk"
  GOOD: "EU drafts Article 7 motion"
  BAD:  "Trump made critical remarks about the Pope at a rally yesterday." (too long)
  BAD:  "Discussions are ongoing about the situation." (vague)

CRITICAL — facts over emotion: every bullet must convey concrete information (who did what, what happened, what was decided, what changed). Reactions and emotional states are only acceptable when paired with the underlying fact.
  GOOD pair: "Ukraine/Russia peace talks failed" then "Trump venting on social media"
  BAD: "Trump frustrated with recent events" (no information, just mood)
  BAD: "Tensions rising in the region" (vague, no event)
If a development is purely emotional with no underlying fact, omit it. The same fact-first rule applies to the summary: prefer concrete facts over mood-setting prose.

Bullets must be factual and non-overlapping. Do NOT duplicate content between "bullets" and "newInfo".`

interface LongModeResult {
  summary: string
  bullets: string[]
  newInfo: string[]
}

function renderLongModeContext(ctx: TopicContext): string {
  const bulletsList = ctx.topic.bullets && ctx.topic.bullets.length > 0
    ? ctx.topic.bullets.map((b) => `- ${b}`).join('\n')
    : '(none yet)'
  const newInfoList = ctx.topic.newInfo && ctx.topic.newInfo.length > 0
    ? ctx.topic.newInfo.map((b) => `- ${b}`).join('\n')
    : '(none yet)'
  return `Topic: ${ctx.topic.title}
Background: ${ctx.topic.description}

Current summary: ${ctx.topic.summary ?? '(none yet)'}
Current bullets:
${bulletsList}
Current NEW info (from previous regeneration):
${newInfoList}

Recent articles (newest first):
${ctx.articleContext}`
}

function parseLongModeResult(raw: unknown): LongModeResult | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as { summary?: unknown; bullets?: unknown; newInfo?: unknown }
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : ''
  if (!summary) return null
  const bullets = Array.isArray(obj.bullets)
    ? obj.bullets.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((s) => s.trim())
    : []
  const newInfo = Array.isArray(obj.newInfo)
    ? obj.newInfo.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((s) => s.trim())
    : []
  return { summary, bullets, newInfo }
}

const LONG_MODE_SINGLE_SYSTEM = `You are a news editor maintaining a running brief for an ongoing situation.

Produce an updated brief with three fields:
- "summary": 2-3 sentences capturing the stable overall situation. This is the running context — avoid restating individual events.
- "bullets": array of bullets (max 8) covering material developments to date, oldest-relevant first. Fold previously-NEW items in here if still relevant; drop ones that have been superseded or are no longer material.
- "newInfo": array (0-3) of bullets that are materially new since the previous regeneration — i.e. introduced by the latest articles. Empty array if nothing meaningfully new.

${LONG_MODE_STYLE_RULES}

Reply with ONLY JSON: { "summary": "...", "bullets": ["..."], "newInfo": ["..."] }`

const LONG_MODE_BATCH_SYSTEM = `You are a news editor maintaining running briefs for several ongoing situations.

For each topic in the user's message, produce an updated brief with: a stable 2-3 sentence "summary", a "bullets" array (max 8) of material developments to date oldest-relevant first, and a "newInfo" array (0-3) of bullets that are materially new since the previous regeneration. Empty newInfo array if nothing meaningfully new. Fold previously-NEW items into "bullets" if still relevant; drop superseded ones.

${LONG_MODE_STYLE_RULES}

Reply with a JSON array, one entry per topic, each having "topicId", "summary", "bullets" (array of strings), "newInfo" (array of strings).

Example: [{"topicId": 5, "summary": "...", "bullets": ["..."], "newInfo": ["..."]}, ...]

Reply with ONLY the JSON array, no other text.`

async function regenerateLongMode(ai: InferenceProvider, db: Db, contexts: TopicContext[]): Promise<void> {
  if (contexts.length === 1) {
    const ctx = contexts[0]
    try {
      // Output: summary + ≤8 bullets + ≤3 newInfo + JSON wrap ≈ ~600 tokens; pad to 1024.
      const response = await ai.complete(renderLongModeContext(ctx), {
        systemPrompt: LONG_MODE_SINGLE_SYSTEM,
        reasoningEffort: 'off',
        maxTokens: 1024,
      })
      const parsed = parseLongModeResult(JSON.parse(stripCodeFences(response)))
      if (parsed) {
        db.news.updateTopicLongForm(ctx.topicId, parsed)
      } else {
        console.error(`[consolidator] long-mode regen produced empty/invalid result for topic ${ctx.topicId}`)
      }
    } catch (err) {
      console.error(`[consolidator] failed to regenerate long-mode summary for topic ${ctx.topicId}:`, err)
    }
    return
  }

  // Sort for deterministic prefix across re-runs over the same topic set.
  contexts = [...contexts].sort((a, b) => a.topicId - b.topicId)

  const userPrefix = `Topics:\n`
  const fixedOverhead = estimateTokens(LONG_MODE_BATCH_SYSTEM) + estimateTokens(userPrefix)

  const renderedContexts = contexts.map((ctx) => `Topic ${ctx.topicId}\n${renderLongModeContext(ctx)}`)
  const chunks = chunkByTokens(contexts, renderedContexts, inputBudget(ai, fixedOverhead))

  await Promise.all(chunks.map(async (chunk) => {
    if (chunk.length === 1) {
      await regenerateLongMode(ai, db, chunk)
      return
    }

    const topicList = chunk
      .map((ctx) => `Topic ${ctx.topicId}\n${renderLongModeContext(ctx)}`)
      .join('\n\n---\n\n')

    try {
      // Per-topic output ≈ 600 tokens; pad to 1000.
      const response = await ai.complete(userPrefix + topicList, {
        systemPrompt: LONG_MODE_BATCH_SYSTEM,
        reasoningEffort: 'off',
        maxTokens: Math.min(MAX_OUTPUT_TOKENS, 256 + chunk.length * 1000),
      })
      const parsed = JSON.parse(stripCodeFences(response)) as { topicId: number; summary: string; bullets: string[]; newInfo: string[] }[]
      if (!Array.isArray(parsed)) {
        console.error('[consolidator] long-mode batch response was not an array, skipping chunk')
        return
      }
      for (const entry of parsed) {
        const ctx = chunk.find((c) => c.topicId === entry.topicId)
        if (!ctx) continue
        const result = parseLongModeResult(entry)
        if (result) {
          db.news.updateTopicLongForm(entry.topicId, result)
        }
      }
    } catch {
      console.error('[consolidator] failed to parse long-mode batch chunk, skipping')
    }
  }))
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

const ASSESS_BATCH_SYSTEM = `You are a news editor. Assess each new article in the context of its topic.

For each pair in the user's message, determine:
- "isSubstantial": Is this a major new development (not just a routine update or minor rehash)?
- "isConcluded": Does this article indicate the story has reached a conclusion or resolution?

Reply with a JSON array, one entry per pair in order:
[{"index": 0, "isSubstantial": true/false, "isConcluded": true/false}, ...]

Reply with ONLY the JSON array, no other text.`

/** Batch-assess multiple article-topic pairs in one LLM call */
async function assessArticleBatch(
  ai: InferenceProvider,
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
      { reasoningEffort: 'off', maxTokens: 128 },
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
  const userPrefix = `Pairs:\n`
  const fixedOverhead = estimateTokens(ASSESS_BATCH_SYSTEM) + estimateTokens(userPrefix)

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

  await Promise.all(chunks.map(async (chunk) => {
    // Single-pair chunk: recurse into the single-pair fast path above
    if (chunk.length === 1) {
      const single = await assessArticleBatch(ai, [pairs[chunk[0]]])
      results[chunk[0]] = single[0]
      return
    }

    const pairList = chunk
      .map((originalIndex, localIndex) => renderPair(pairs[originalIndex], localIndex))
      .join('\n\n')

    // Per-pair output ≈ 50 tokens (`{"index":N,"isSubstantial":true,"isConcluded":false}`); pad to 80.
    const response = await ai.complete(userPrefix + pairList, {
      systemPrompt: ASSESS_BATCH_SYSTEM,
      reasoningEffort: 'off',
      maxTokens: Math.min(MAX_OUTPUT_TOKENS, 64 + chunk.length * 80),
    })

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
  }))

  return results
}
