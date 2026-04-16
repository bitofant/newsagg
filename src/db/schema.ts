import type { DatabaseSync } from 'node:sqlite'

export function applySchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS topics (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS articles (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id   INTEGER NOT NULL REFERENCES topics(id),
      source     TEXT NOT NULL,
      url        TEXT NOT NULL UNIQUE,
      title      TEXT NOT NULL,
      text       TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      interval_ms   INTEGER NOT NULL DEFAULT ${15 * 60 * 1000}
    );

    CREATE TABLE IF NOT EXISTS user_votes (
      user_id    INTEGER NOT NULL REFERENCES users(id),
      article_id INTEGER NOT NULL REFERENCES articles(id),
      vote       INTEGER NOT NULL CHECK(vote IN (-1, 1)),
      PRIMARY KEY (user_id, article_id)
    );

    CREATE TABLE IF NOT EXISTS signal_queue (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      type       TEXT NOT NULL,
      topic_id   INTEGER NOT NULL REFERENCES topics(id),
      article_id INTEGER REFERENCES articles(id),
      created_at INTEGER NOT NULL,
      consumed   INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS front_pages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id),
      generated_at INTEGER NOT NULL,
      data         TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS article_topics (
      article_id INTEGER NOT NULL REFERENCES articles(id),
      topic_id   INTEGER NOT NULL REFERENCES topics(id),
      PRIMARY KEY (article_id, topic_id)
    );

    CREATE INDEX IF NOT EXISTS idx_articles_topic  ON articles(topic_id);
    CREATE INDEX IF NOT EXISTS idx_articles_url    ON articles(url);
    CREATE INDEX IF NOT EXISTS idx_article_topics_topic   ON article_topics(topic_id);
    CREATE INDEX IF NOT EXISTS idx_article_topics_article ON article_topics(article_id);
    CREATE INDEX IF NOT EXISTS idx_signal_queue_user
      ON signal_queue(user_id, consumed, created_at);
    CREATE INDEX IF NOT EXISTS idx_front_pages_user
      ON front_pages(user_id, generated_at DESC);
  `)

  // Migrations for existing databases
  const userCols = db.prepare("PRAGMA table_info(users)").all() as { name: string }[]
  const userColNames = new Set(userCols.map((c) => c.name))
  if (!userColNames.has('preference_profile')) {
    db.exec('ALTER TABLE users ADD COLUMN preference_profile TEXT')
  }
  if (!userColNames.has('preference_generated_at')) {
    db.exec('ALTER TABLE users ADD COLUMN preference_generated_at INTEGER')
  }
  if (!userColNames.has('last_viewed_at')) {
    db.exec('ALTER TABLE users ADD COLUMN last_viewed_at INTEGER')
  }

  // Topics summary column
  const topicCols = db.prepare("PRAGMA table_info(topics)").all() as { name: string }[]
  const topicColNames = new Set(topicCols.map((c) => c.name))
  if (!topicColNames.has('summary')) {
    db.exec('ALTER TABLE topics ADD COLUMN summary TEXT')
  }

  // Backfill article_topics from legacy articles.topic_id column
  const atCount = (db.prepare('SELECT COUNT(*) as count FROM article_topics').get() as { count: number }).count
  if (atCount === 0) {
    const articleCount = (db.prepare('SELECT COUNT(*) as count FROM articles').get() as { count: number }).count
    if (articleCount > 0) {
      db.exec('INSERT OR IGNORE INTO article_topics (article_id, topic_id) SELECT id, topic_id FROM articles')
    }
  }

  // Read-topic tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_read_topics (
      user_id  INTEGER NOT NULL REFERENCES users(id),
      topic_id INTEGER NOT NULL REFERENCES topics(id),
      read_at  INTEGER NOT NULL,
      PRIMARY KEY (user_id, topic_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_read_topics_user ON user_read_topics(user_id);
  `)
}
