import type { DatabaseSync } from 'node:sqlite'

export interface Topic {
  id: number
  title: string
  description: string
  summary: string | null
  bullets: string[] | null
  newInfo: string[] | null
  substantialEventTimestamps: number[]
  createdAt: number
  updatedAt: number
}

interface TopicRow {
  id: number
  title: string
  description: string
  summary: string | null
  bullets: string | null
  new_info: string | null
  substantial_event_timestamps: string | null
  created_at: number
  updated_at: number
}

function parseStringArray(json: string | null): string[] | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : null
  } catch {
    return null
  }
}

function parseNumberArray(json: string | null): number[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((x): x is number => typeof x === 'number') : []
  } catch {
    return []
  }
}

function rowToTopic(r: TopicRow): Topic {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    summary: r.summary,
    bullets: parseStringArray(r.bullets),
    newInfo: parseStringArray(r.new_info),
    substantialEventTimestamps: parseNumberArray(r.substantial_event_timestamps),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

const TOPIC_COLUMNS = 'id, title, description, summary, bullets, new_info, substantial_event_timestamps, created_at, updated_at'

export interface Article {
  id: number
  topicId: number
  source: string
  url: string
  title: string
  text: string
  fetchedAt: number
}

export interface NewArticle {
  topicIds: number[]
  source: string
  url: string
  title: string
  text: string
}

export interface NewsDb {
  /** Returns all topics with terse descriptions — used by consolidator for matching */
  listTopics(): Topic[]
  topicCount(): number
  getTopic(id: number): Topic | null
  createTopic(title: string, description: string): Topic
  /** Look up topics by id list. Order of result follows the input order; missing ids are skipped. */
  listTopicsByIds(ids: number[]): Topic[]
  updateTopicTimestamp(id: number): void
  articleExistsByUrl(url: string): boolean
  addArticle(article: NewArticle): Article
  linkArticleToTopic(articleId: number, topicId: number): void
  listArticlesByTopic(topicId: number): Article[]
  listRecentArticlesByTopic(topicId: number, limit: number): Article[]
  updateTopicSummary(topicId: number, summary: string): void
  /** Long-form update for topics with bullets format. Writes summary + JSON-serialized arrays. */
  updateTopicLongForm(topicId: number, fields: { summary: string; bullets: string[]; newInfo: string[] }): void
  /** Append a substantial-event timestamp to the topic and return the updated array. */
  appendSubstantialEventTimestamp(topicId: number, ts: number): number[]
  /** Replace the substantial-event timestamp array on the topic. Used by mergeTopic to combine two topics' history. */
  setSubstantialEventTimestamps(topicId: number, ts: number[]): void
  getArticleCountByTopic(topicId: number): number
  getArticleById(id: number): Article | undefined
  unlinkArticleFromTopic(articleId: number, topicId: number): void
  deleteTopic(id: number): void
  totalArticleCount(): number
  /** Write the embedding bytes for a topic, tagged with the model name that produced it. */
  updateTopicEmbedding(topicId: number, embedding: Float32Array, model: string): void
  /** All topics that have an embedding from the given model. Brute-forced over for cosine pre-filter. */
  listAllTopicEmbeddings(model: string): Array<{ id: number; embedding: Float32Array }>
  /** Topics whose stored embedding is missing or was produced by a different model. Used by backfill. */
  listTopicsMissingEmbedding(model: string, limit: number, offset: number): Topic[]
  topicsMissingEmbeddingCount(model: string): number
}

function float32ArrayToBlob(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
}

function blobToFloat32Array(blob: Uint8Array): Float32Array {
  // Copy into a fresh, 4-byte-aligned ArrayBuffer. The Uint8Array we get back from node:sqlite is
  // not guaranteed to start at a 4-byte-aligned offset within its underlying ArrayBuffer, so wrapping
  // it directly as a Float32Array would throw on some inputs.
  const aligned = new ArrayBuffer(blob.byteLength)
  new Uint8Array(aligned).set(blob)
  return new Float32Array(aligned)
}

// IMPLEMENTED
export function createNewsDb(db: DatabaseSync): NewsDb {
  return {
    listTopics() {
      return (
        db.prepare(`SELECT ${TOPIC_COLUMNS} FROM topics ORDER BY updated_at DESC`).all() as unknown as TopicRow[]
      ).map(rowToTopic)
    },

    topicCount() {
      const row = db.prepare('SELECT COUNT(*) as count FROM topics').get() as { count: number }
      return row.count
    },

    getTopic(id) {
      const r = db.prepare(`SELECT ${TOPIC_COLUMNS} FROM topics WHERE id = ?`).get(id) as unknown as TopicRow | undefined
      if (!r) return null
      return rowToTopic(r)
    },

    totalArticleCount() {
      const row = db.prepare('SELECT COUNT(*) as count FROM articles').get() as { count: number }
      return row.count
    },

    createTopic(title, description) {
      const now = Date.now()
      const result = db
        .prepare('INSERT INTO topics (title, description, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(title, description, now, now)
      return {
        id: Number(result.lastInsertRowid),
        title,
        description,
        summary: null,
        bullets: null,
        newInfo: null,
        substantialEventTimestamps: [],
        createdAt: now,
        updatedAt: now,
      }
    },

    updateTopicTimestamp(id) {
      db.prepare('UPDATE topics SET updated_at = ? WHERE id = ?').run(Date.now(), id)
    },

    articleExistsByUrl(url) {
      return !!db.prepare('SELECT 1 FROM articles WHERE url = ?').get(url)
    },

    addArticle({ topicIds, source, url, title, text }) {
      const now = Date.now()
      const primaryTopicId = topicIds[0]
      const result = db
        .prepare('INSERT INTO articles (topic_id, source, url, title, text, fetched_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(primaryTopicId, source, url, title, text, now)
      const articleId = Number(result.lastInsertRowid)
      const linkStmt = db.prepare('INSERT OR IGNORE INTO article_topics (article_id, topic_id) VALUES (?, ?)')
      for (const topicId of topicIds) {
        linkStmt.run(articleId, topicId)
      }
      return { id: articleId, topicId: primaryTopicId, source, url, title, text, fetchedAt: now }
    },

    linkArticleToTopic(articleId, topicId) {
      db.prepare('INSERT OR IGNORE INTO article_topics (article_id, topic_id) VALUES (?, ?)').run(articleId, topicId)
    },

    listArticlesByTopic(topicId) {
      return (
        db
          .prepare(
            `SELECT a.id, a.source, a.url, a.title, a.text, a.fetched_at
             FROM articles a
             JOIN article_topics at ON a.id = at.article_id
             WHERE at.topic_id = ?
             ORDER BY a.fetched_at DESC`,
          )
          .all(topicId) as {
          id: number
          source: string
          url: string
          title: string
          text: string
          fetched_at: number
        }[]
      ).map((r) => ({
        id: r.id,
        topicId,
        source: r.source,
        url: r.url,
        title: r.title,
        text: r.text,
        fetchedAt: r.fetched_at,
      }))
    },

    listRecentArticlesByTopic(topicId, limit) {
      return (
        db
          .prepare(
            `SELECT a.id, a.source, a.url, a.title, a.text, a.fetched_at
             FROM articles a
             JOIN article_topics at ON a.id = at.article_id
             WHERE at.topic_id = ?
             ORDER BY a.fetched_at DESC LIMIT ?`,
          )
          .all(topicId, limit) as {
          id: number
          source: string
          url: string
          title: string
          text: string
          fetched_at: number
        }[]
      ).map((r) => ({
        id: r.id,
        topicId,
        source: r.source,
        url: r.url,
        title: r.title,
        text: r.text,
        fetchedAt: r.fetched_at,
      }))
    },

    updateTopicSummary(topicId, summary) {
      db.prepare('UPDATE topics SET summary = ? WHERE id = ?').run(summary, topicId)
    },

    updateTopicLongForm(topicId, { summary, bullets, newInfo }) {
      db.prepare('UPDATE topics SET summary = ?, bullets = ?, new_info = ?, updated_at = ? WHERE id = ?').run(
        summary,
        JSON.stringify(bullets),
        JSON.stringify(newInfo),
        Date.now(),
        topicId,
      )
    },

    appendSubstantialEventTimestamp(topicId, ts) {
      const row = db.prepare('SELECT substantial_event_timestamps FROM topics WHERE id = ?').get(topicId) as
        | { substantial_event_timestamps: string | null }
        | undefined
      const current = parseNumberArray(row?.substantial_event_timestamps ?? null)
      const updated = [...current, ts]
      db.prepare('UPDATE topics SET substantial_event_timestamps = ? WHERE id = ?').run(JSON.stringify(updated), topicId)
      return updated
    },

    setSubstantialEventTimestamps(topicId, ts) {
      db.prepare('UPDATE topics SET substantial_event_timestamps = ? WHERE id = ?').run(JSON.stringify(ts), topicId)
    },

    getArticleCountByTopic(topicId) {
      const row = db.prepare('SELECT COUNT(*) as count FROM article_topics WHERE topic_id = ?').get(topicId) as { count: number }
      return row.count
    },

    getArticleById(id) {
      const r = db.prepare('SELECT id, topic_id, source, url, title, text, fetched_at FROM articles WHERE id = ?').get(id) as {
        id: number
        topic_id: number
        source: string
        url: string
        title: string
        text: string
        fetched_at: number
      } | undefined
      if (!r) return undefined
      return { id: r.id, topicId: r.topic_id, source: r.source, url: r.url, title: r.title, text: r.text, fetchedAt: r.fetched_at }
    },

    unlinkArticleFromTopic(articleId, topicId) {
      db.prepare('DELETE FROM article_topics WHERE article_id = ? AND topic_id = ?').run(articleId, topicId)
      // Update legacy topic_id if it pointed to the unlinked topic
      const article = db.prepare('SELECT topic_id FROM articles WHERE id = ?').get(articleId) as { topic_id: number } | undefined
      if (article && article.topic_id === topicId) {
        const remaining = db.prepare('SELECT topic_id FROM article_topics WHERE article_id = ? LIMIT 1').get(articleId) as { topic_id: number } | undefined
        if (remaining) {
          db.prepare('UPDATE articles SET topic_id = ? WHERE id = ?').run(remaining.topic_id, articleId)
        }
      }
    },

    listTopicsByIds(ids) {
      if (ids.length === 0) return []
      const placeholders = ids.map(() => '?').join(',')
      const rows = db
        .prepare(`SELECT ${TOPIC_COLUMNS} FROM topics WHERE id IN (${placeholders})`)
        .all(...ids) as unknown as TopicRow[]
      const byId = new Map(rows.map((r) => [r.id, rowToTopic(r)] as const))
      const out: Topic[] = []
      for (const id of ids) {
        const t = byId.get(id)
        if (t) out.push(t)
      }
      return out
    },

    updateTopicEmbedding(topicId, embedding, model) {
      db.prepare('UPDATE topics SET embedding = ?, embedding_model = ? WHERE id = ?').run(
        float32ArrayToBlob(embedding),
        model,
        topicId,
      )
    },

    listAllTopicEmbeddings(model) {
      const rows = db
        .prepare('SELECT id, embedding FROM topics WHERE embedding IS NOT NULL AND embedding_model = ?')
        .all(model) as Array<{ id: number; embedding: Uint8Array }>
      return rows.map((r) => ({ id: r.id, embedding: blobToFloat32Array(r.embedding) }))
    },

    listTopicsMissingEmbedding(model, limit, offset) {
      return (
        db
          .prepare(
            `SELECT ${TOPIC_COLUMNS} FROM topics
             WHERE embedding IS NULL OR embedding_model IS NULL OR embedding_model != ?
             ORDER BY id ASC LIMIT ? OFFSET ?`,
          )
          .all(model, limit, offset) as unknown as TopicRow[]
      ).map(rowToTopic)
    },

    topicsMissingEmbeddingCount(model) {
      const row = db
        .prepare(
          `SELECT COUNT(*) as count FROM topics
           WHERE embedding IS NULL OR embedding_model IS NULL OR embedding_model != ?`,
        )
        .get(model) as { count: number }
      return row.count
    },

    deleteTopic(id) {
      // FK = ON and `articles.topic_id` is NOT NULL with REFERENCES topics(id),
      // so we can't blanket-set it to 0 — that violates the FK.
      // For each article whose legacy topic_id still points here, look up another linked
      // topic from article_topics and repoint. Articles with no remaining topic become
      // truly orphaned and get deleted along with their references.
      const stragglers = db.prepare('SELECT id FROM articles WHERE topic_id = ?').all(id) as { id: number }[]
      for (const a of stragglers) {
        const remaining = db
          .prepare('SELECT topic_id FROM article_topics WHERE article_id = ? AND topic_id != ? LIMIT 1')
          .get(a.id, id) as { topic_id: number } | undefined
        if (remaining) {
          db.prepare('UPDATE articles SET topic_id = ? WHERE id = ?').run(remaining.topic_id, a.id)
        } else {
          db.prepare('DELETE FROM user_votes WHERE article_id = ?').run(a.id)
          db.prepare('DELETE FROM signal_queue WHERE article_id = ?').run(a.id)
          db.prepare('DELETE FROM article_topics WHERE article_id = ?').run(a.id)
          db.prepare('DELETE FROM articles WHERE id = ?').run(a.id)
        }
      }
      db.prepare('DELETE FROM signal_queue WHERE topic_id = ?').run(id)
      db.prepare('DELETE FROM user_read_topics WHERE topic_id = ?').run(id)
      db.prepare('DELETE FROM article_topics WHERE topic_id = ?').run(id)
      db.prepare('DELETE FROM topics WHERE id = ?').run(id)
    },
  }
}
