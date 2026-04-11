import type { DatabaseSync } from 'node:sqlite'

export interface Topic {
  id: number
  title: string
  description: string
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
  topicId: number
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
  listArticlesByTopic(topicId: number): Article[]
  listRecentArticlesByTopic(topicId: number, limit: number): Article[]
}

// IMPLEMENTED
export function createNewsDb(db: DatabaseSync): NewsDb {
  return {
    listTopics() {
      return (
        db.prepare('SELECT id, title, description, created_at, updated_at FROM topics ORDER BY updated_at DESC').all() as {
          id: number
          title: string
          description: string
          created_at: number
          updated_at: number
        }[]
      ).map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }))
    },

    listTopicsPaginated(limit, offset) {
      return (
        db.prepare('SELECT id, title, description, created_at, updated_at FROM topics ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset) as {
          id: number
          title: string
          description: string
          created_at: number
          updated_at: number
        }[]
      ).map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
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
      return { id: Number(result.lastInsertRowid), title, description, createdAt: now, updatedAt: now }
    },

    updateTopicTimestamp(id) {
      db.prepare('UPDATE topics SET updated_at = ? WHERE id = ?').run(Date.now(), id)
    },

    articleExistsByUrl(url) {
      return !!db.prepare('SELECT 1 FROM articles WHERE url = ?').get(url)
    },

    addArticle({ topicId, source, url, title, text }) {
      const now = Date.now()
      const result = db
        .prepare('INSERT INTO articles (topic_id, source, url, title, text, fetched_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(topicId, source, url, title, text, now)
      return { id: Number(result.lastInsertRowid), topicId, source, url, title, text, fetchedAt: now }
    },

    listArticlesByTopic(topicId) {
      return (
        db
          .prepare('SELECT id, topic_id, source, url, title, text, fetched_at FROM articles WHERE topic_id = ? ORDER BY fetched_at DESC')
          .all(topicId) as {
          id: number
          topic_id: number
          source: string
          url: string
          title: string
          text: string
          fetched_at: number
        }[]
      ).map((r) => ({
        id: r.id,
        topicId: r.topic_id,
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
          .prepare('SELECT id, topic_id, source, url, title, text, fetched_at FROM articles WHERE topic_id = ? ORDER BY fetched_at DESC LIMIT ?')
          .all(topicId, limit) as {
          id: number
          topic_id: number
          source: string
          url: string
          title: string
          text: string
          fetched_at: number
        }[]
      ).map((r) => ({
        id: r.id,
        topicId: r.topic_id,
        source: r.source,
        url: r.url,
        title: r.title,
        text: r.text,
        fetchedAt: r.fetched_at,
      }))
    },
  }
}
