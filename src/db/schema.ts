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

    CREATE INDEX IF NOT EXISTS idx_articles_topic  ON articles(topic_id);
    CREATE INDEX IF NOT EXISTS idx_articles_url    ON articles(url);
    CREATE INDEX IF NOT EXISTS idx_signal_queue_user
      ON signal_queue(user_id, consumed, created_at);
    CREATE INDEX IF NOT EXISTS idx_front_pages_user
      ON front_pages(user_id, generated_at DESC);
  `)
}
