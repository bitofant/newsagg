import type { DatabaseSync } from 'node:sqlite'

export interface User {
  id: number
  email: string
  passwordHash: string
  createdAt: number
  intervalMs: number
}

export type Signal =
  | { type: 'new_topic'; topicId: number; articleId: number }
  | { type: 'added_to_topic'; topicId: number; articleId: number }
  | { type: 'substantial_new_info'; topicId: number; articleId: number }
  | { type: 'concluded_issue'; topicId: number; articleId: number }

export interface UserDb {
  createUser(email: string, passwordHash: string): User
  findUserByEmail(email: string): User | undefined
  listAllUsers(): User[]
  getUserById(userId: number): User | undefined
  updateUserInterval(userId: number, intervalMs: number): void
  recordVote(userId: number, articleId: number, vote: 1 | -1): void
  getVotesByUser(userId: number): { articleId: number; topicId: number; vote: number }[]
  enqueueSignalForAllUsers(signal: Signal): void
  consumePendingSignals(userId: number): Signal[]
  saveFrontPage(userId: number, data: string): void
  getLatestFrontPage(userId: number): { generatedAt: number; data: string } | undefined
  getLastFrontPageTime(userId: number): number | undefined
}

// IMPLEMENTED
export function createUserDb(db: DatabaseSync): UserDb {
  return {
    createUser(email, passwordHash) {
      const now = Date.now()
      const result = db
        .prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)')
        .run(email, passwordHash, now)
      return { id: Number(result.lastInsertRowid), email, passwordHash, createdAt: now, intervalMs: 15 * 60 * 1000 }
    },

    findUserByEmail(email) {
      const row = db
        .prepare('SELECT id, email, password_hash, created_at, interval_ms FROM users WHERE email = ?')
        .get(email) as { id: number; email: string; password_hash: string; created_at: number; interval_ms: number } | undefined
      if (!row) return undefined
      return { id: row.id, email: row.email, passwordHash: row.password_hash, createdAt: row.created_at, intervalMs: row.interval_ms }
    },

    listAllUsers() {
      return (
        db.prepare('SELECT id, email, password_hash, created_at, interval_ms FROM users').all() as {
          id: number
          email: string
          password_hash: string
          created_at: number
          interval_ms: number
        }[]
      ).map((r) => ({
        id: r.id,
        email: r.email,
        passwordHash: r.password_hash,
        createdAt: r.created_at,
        intervalMs: r.interval_ms,
      }))
    },

    getUserById(userId) {
      const row = db
        .prepare('SELECT id, email, password_hash, created_at, interval_ms FROM users WHERE id = ?')
        .get(userId) as { id: number; email: string; password_hash: string; created_at: number; interval_ms: number } | undefined
      if (!row) return undefined
      return { id: row.id, email: row.email, passwordHash: row.password_hash, createdAt: row.created_at, intervalMs: row.interval_ms }
    },

    updateUserInterval(userId, intervalMs) {
      db.prepare('UPDATE users SET interval_ms = ? WHERE id = ?').run(intervalMs, userId)
    },

    recordVote(userId, articleId, vote) {
      db.prepare(
        'INSERT INTO user_votes (user_id, article_id, vote) VALUES (?, ?, ?) ON CONFLICT(user_id, article_id) DO UPDATE SET vote = excluded.vote',
      ).run(userId, articleId, vote)
    },

    getVotesByUser(userId) {
      const rows = db
        .prepare(
          'SELECT uv.article_id, a.topic_id, uv.vote FROM user_votes uv JOIN articles a ON a.id = uv.article_id WHERE uv.user_id = ?',
        )
        .all(userId) as { article_id: number; topic_id: number; vote: number }[]
      return rows.map((r) => ({ articleId: r.article_id, topicId: r.topic_id, vote: r.vote }))
    },

    enqueueSignalForAllUsers(signal) {
      const users = db.prepare('SELECT id FROM users').all() as { id: number }[]
      const insert = db.prepare(
        'INSERT INTO signal_queue (user_id, type, topic_id, article_id, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      const now = Date.now()
      db.exec('BEGIN')
      try {
        for (const user of users) {
          insert.run(user.id, signal.type, signal.topicId, 'articleId' in signal ? signal.articleId : null, now)
        }
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },

    consumePendingSignals(userId) {
      const rows = db
        .prepare(
          'SELECT id, type, topic_id, article_id FROM signal_queue WHERE user_id = ? AND consumed = 0 ORDER BY created_at ASC',
        )
        .all(userId) as { id: number; type: string; topic_id: number; article_id: number }[]

      if (rows.length === 0) return []

      const ids = rows.map((r) => r.id)
      db.prepare(`UPDATE signal_queue SET consumed = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids)

      return rows.map((r) => ({ type: r.type, topicId: r.topic_id, articleId: r.article_id }) as Signal)
    },

    saveFrontPage(userId, data) {
      const now = Date.now()
      db.prepare('INSERT INTO front_pages (user_id, generated_at, data) VALUES (?, ?, ?)').run(userId, now, data)
    },

    getLatestFrontPage(userId) {
      const row = db
        .prepare('SELECT generated_at, data FROM front_pages WHERE user_id = ? ORDER BY generated_at DESC LIMIT 1')
        .get(userId) as { generated_at: number; data: string } | undefined
      if (!row) return undefined
      return { generatedAt: row.generated_at, data: row.data }
    },

    getLastFrontPageTime(userId) {
      const row = db
        .prepare('SELECT generated_at FROM front_pages WHERE user_id = ? ORDER BY generated_at DESC LIMIT 1')
        .get(userId) as { generated_at: number } | undefined
      return row?.generated_at
    },
  }
}
