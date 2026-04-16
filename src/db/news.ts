import type { DatabaseSync } from 'node:sqlite'

export interface Topic {
  id: number
  title: string
  description: string
  summary: string | null
  createdAt: number
  updatedAt: number
}

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
  /** Paginated topics ordered by created_at DESC, for batched consolidator matching */
  listTopicsPaginated(limit: number, offset: number): Topic[]
  topicCount(): number
  createTopic(title: string, description: string): Topic
  updateTopicTimestamp(id: number): void
  articleExistsByUrl(url: string): boolean
  addArticle(article: NewArticle): Article
  linkArticleToTopic(articleId: number, topicId: number): void
  listArticlesByTopic(topicId: number): Article[]
  listRecentArticlesByTopic(topicId: number, limit: number): Article[]
  updateTopicSummary(topicId: number, summary: string): void
  getArticleCountByTopic(topicId: number): number
  getArticleById(id: number): Article | undefined
  unlinkArticleFromTopic(articleId: number, topicId: number): void
  deleteTopic(id: number): void
}

// IMPLEMENTED
export function createNewsDb(db: DatabaseSync): NewsDb {
  return {
    listTopics() {
      return (
        db.prepare('SELECT id, title, description, summary, created_at, updated_at FROM topics ORDER BY updated_at DESC').all() as {
          id: number
          title: string
          description: string
          summary: string | null
          created_at: number
          updated_at: number
        }[]
      ).map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        summary: r.summary,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }))
    },

    listTopicsPaginated(limit, offset) {
      return (
        db.prepare('SELECT id, title, description, summary, created_at, updated_at FROM topics ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset) as {
          id: number
          title: string
          description: string
          summary: string | null
          created_at: number
          updated_at: number
        }[]
      ).map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        summary: r.summary,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }))
    },

    topicCount() {
      const row = db.prepare('SELECT COUNT(*) as count FROM topics').get() as { count: number }
      return row.count
    },

    createTopic(title, description) {
      const now = Date.now()
      const result = db
        .prepare('INSERT INTO topics (title, description, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(title, description, now, now)
      return { id: Number(result.lastInsertRowid), title, description, summary: null, createdAt: now, updatedAt: now }
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

    deleteTopic(id) {
      db.prepare('DELETE FROM signal_queue WHERE topic_id = ?').run(id)
      db.prepare('DELETE FROM user_read_topics WHERE topic_id = ?').run(id)
      db.prepare('DELETE FROM article_topics WHERE topic_id = ?').run(id)
      // Update legacy topic_id for any articles that still reference this topic
      db.prepare('UPDATE articles SET topic_id = 0 WHERE topic_id = ?').run(id)
      db.prepare('DELETE FROM topics WHERE id = ?').run(id)
    },
  }
}
