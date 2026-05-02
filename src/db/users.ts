import type { DatabaseSync } from 'node:sqlite'

export interface User {
  id: number
  email: string
  passwordHash: string
  createdAt: number
  intervalMs: number
  preferenceProfile: string | null
  preferenceGeneratedAt: number | null
  manualPreferences: string | null
  lastViewedAt: number | null
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
  updatePreferenceProfile(userId: number, profile: string): void
  updateManualPreferences(userId: number, text: string): void
  recordVote(userId: number, articleId: number, vote: 1 | -1 | 0): void
  getVotesByUser(userId: number): { articleId: number; topicId: number; vote: number }[]
  getVotesWithContext(userId: number): { articleTitle: string; topicTitle: string; topicDescription: string; vote: number }[]
  enqueueSignalForAllUsers(signal: Signal): void
  readSignalsInWindow(userId: number, windowMs: number): Signal[]
  getReadTopicIds(userId: number): Set<number>
  setReadTopics(userId: number, topicIds: number[]): void
  setTopicRead(userId: number, topicId: number, read: boolean): void
  unreadTopicForNonDownvoters(topicId: number): void
  /** For every user that had `oldTopicId` marked as read, mark each of `newTopicIds` as read with the same `read_at`. */
  replaceReadTopic(oldTopicId: number, newTopicIds: number[]): void
  /** Used by mergeTopic: for every user that had `loserTopicId` read but not `winnerTopicId`, mark winner as read with loser's read_at. Existing winner read_at is preserved. */
  unionReadTopic(loserTopicId: number, winnerTopicId: number): void
  cleanupOldSignals(maxAgeMs: number): void
  saveFrontPage(userId: number, data: string): void
  getLatestFrontPage(userId: number): { generatedAt: number; data: string } | undefined
  getLastFrontPageTime(userId: number): number | undefined
}

type UserRow = {
  id: number
  email: string
  password_hash: string
  created_at: number
  interval_ms: number
  preference_profile: string | null
  preference_generated_at: number | null
  manual_preferences: string | null
  last_viewed_at: number | null
}

function mapUserRow(r: UserRow): User {
  return {
    id: r.id,
    email: r.email,
    passwordHash: r.password_hash,
    createdAt: r.created_at,
    intervalMs: r.interval_ms,
    preferenceProfile: r.preference_profile,
    preferenceGeneratedAt: r.preference_generated_at,
    manualPreferences: r.manual_preferences,
    lastViewedAt: r.last_viewed_at,
  }
}

// IMPLEMENTED
export function createUserDb(db: DatabaseSync): UserDb {
  return {
    createUser(email, passwordHash) {
      const now = Date.now()
      const result = db
        .prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)')
        .run(email, passwordHash, now)
      return { id: Number(result.lastInsertRowid), email, passwordHash, createdAt: now, intervalMs: 15 * 60 * 1000, preferenceProfile: null, preferenceGeneratedAt: null, manualPreferences: null, lastViewedAt: null }
    },

    findUserByEmail(email) {
      const row = db
        .prepare('SELECT id, email, password_hash, created_at, interval_ms, preference_profile, preference_generated_at, manual_preferences, last_viewed_at FROM users WHERE email = ?')
        .get(email) as UserRow | undefined
      if (!row) return undefined
      return mapUserRow(row)
    },

    listAllUsers() {
      return (
        db.prepare('SELECT id, email, password_hash, created_at, interval_ms, preference_profile, preference_generated_at, manual_preferences, last_viewed_at FROM users').all() as UserRow[]
      ).map(mapUserRow)
    },

    getUserById(userId) {
      const row = db
        .prepare('SELECT id, email, password_hash, created_at, interval_ms, preference_profile, preference_generated_at, manual_preferences, last_viewed_at FROM users WHERE id = ?')
        .get(userId) as UserRow | undefined
      if (!row) return undefined
      return mapUserRow(row)
    },

    updateUserInterval(userId, intervalMs) {
      db.prepare('UPDATE users SET interval_ms = ? WHERE id = ?').run(intervalMs, userId)
    },

    updatePreferenceProfile(userId, profile) {
      db.prepare('UPDATE users SET preference_profile = ?, preference_generated_at = ? WHERE id = ?').run(profile, Date.now(), userId)
    },

    updateManualPreferences(userId, text) {
      db.prepare('UPDATE users SET manual_preferences = ? WHERE id = ?').run(text, userId)
    },

    recordVote(userId, articleId, vote) {
      if (vote === 0) {
        db.prepare('DELETE FROM user_votes WHERE user_id = ? AND article_id = ?').run(userId, articleId)
      } else {
        db.prepare(
          'INSERT INTO user_votes (user_id, article_id, vote) VALUES (?, ?, ?) ON CONFLICT(user_id, article_id) DO UPDATE SET vote = excluded.vote',
        ).run(userId, articleId, vote)
      }
    },

    getVotesByUser(userId) {
      const rows = db
        .prepare(
          `SELECT uv.article_id, at.topic_id, uv.vote
           FROM user_votes uv
           JOIN article_topics at ON uv.article_id = at.article_id
           WHERE uv.user_id = ?`,
        )
        .all(userId) as { article_id: number; topic_id: number; vote: number }[]
      return rows.map((r) => ({ articleId: r.article_id, topicId: r.topic_id, vote: r.vote }))
    },

    getVotesWithContext(userId) {
      const rows = db
        .prepare(
          `SELECT a.title AS article_title, t.title AS topic_title, t.description AS topic_description, uv.vote
           FROM user_votes uv
           JOIN articles a ON a.id = uv.article_id
           JOIN article_topics at ON a.id = at.article_id
           JOIN topics t ON t.id = at.topic_id
           WHERE uv.user_id = ?
           ORDER BY uv.rowid DESC`,
        )
        .all(userId) as { article_title: string; topic_title: string; topic_description: string; vote: number }[]
      return rows.map((r) => ({ articleTitle: r.article_title, topicTitle: r.topic_title, topicDescription: r.topic_description, vote: r.vote }))
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

    readSignalsInWindow(userId, windowMs) {
      const since = Date.now() - windowMs
      const rows = db
        .prepare(
          'SELECT type, topic_id, article_id FROM signal_queue WHERE user_id = ? AND created_at >= ? ORDER BY created_at ASC',
        )
        .all(userId, since) as { type: string; topic_id: number; article_id: number }[]
      return rows.map((r) => ({ type: r.type, topicId: r.topic_id, articleId: r.article_id }) as Signal)
    },

    getReadTopicIds(userId) {
      const rows = db
        .prepare('SELECT topic_id FROM user_read_topics WHERE user_id = ?')
        .all(userId) as { topic_id: number }[]
      return new Set(rows.map((r) => r.topic_id))
    },

    setReadTopics(userId, topicIds) {
      db.exec('BEGIN')
      try {
        db.prepare('DELETE FROM user_read_topics WHERE user_id = ?').run(userId)
        if (topicIds.length > 0) {
          const now = Date.now()
          const insert = db.prepare('INSERT INTO user_read_topics (user_id, topic_id, read_at) VALUES (?, ?, ?)')
          for (const topicId of topicIds) {
            insert.run(userId, topicId, now)
          }
        }
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },

    setTopicRead(userId, topicId, read) {
      if (read) {
        db.prepare(
          'INSERT OR REPLACE INTO user_read_topics (user_id, topic_id, read_at) VALUES (?, ?, ?)',
        ).run(userId, topicId, Date.now())
      } else {
        db.prepare('DELETE FROM user_read_topics WHERE user_id = ? AND topic_id = ?').run(userId, topicId)
      }
    },

    replaceReadTopic(oldTopicId, newTopicIds) {
      if (newTopicIds.length === 0) return
      const rows = db
        .prepare('SELECT user_id, read_at FROM user_read_topics WHERE topic_id = ?')
        .all(oldTopicId) as { user_id: number; read_at: number }[]
      if (rows.length === 0) return
      const insert = db.prepare(
        'INSERT OR REPLACE INTO user_read_topics (user_id, topic_id, read_at) VALUES (?, ?, ?)',
      )
      db.exec('BEGIN')
      try {
        for (const row of rows) {
          for (const newId of newTopicIds) {
            insert.run(row.user_id, newId, row.read_at)
          }
        }
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },

    unionReadTopic(loserTopicId, winnerTopicId) {
      // For every user that had loser read, ensure winner is read too.
      // INSERT OR IGNORE preserves an existing winner read_at; otherwise loser's read_at is copied.
      db.prepare(
        `INSERT OR IGNORE INTO user_read_topics (user_id, topic_id, read_at)
         SELECT user_id, ?, read_at FROM user_read_topics WHERE topic_id = ?`,
      ).run(winnerTopicId, loserTopicId)
    },

    unreadTopicForNonDownvoters(topicId) {
      db.prepare(
        `DELETE FROM user_read_topics
         WHERE topic_id = ?
           AND user_id NOT IN (
             SELECT DISTINCT uv.user_id
             FROM user_votes uv
             JOIN article_topics at ON uv.article_id = at.article_id
             WHERE at.topic_id = ? AND uv.vote = -1
           )`,
      ).run(topicId, topicId)
    },

    cleanupOldSignals(maxAgeMs) {
      const cutoff = Date.now() - maxAgeMs
      db.prepare('DELETE FROM signal_queue WHERE created_at < ?').run(cutoff)
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
