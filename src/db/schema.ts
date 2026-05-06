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
  // For users that exist before this column was added, any hand-edited content in
  // preference_profile will be overwritten on the next profiler regeneration.
  // To preserve it, copy it into manual_preferences via /settings.
  if (!userColNames.has('manual_preferences')) {
    db.exec('ALTER TABLE users ADD COLUMN manual_preferences TEXT')
  }

  // Topics summary column
  const topicCols = db.prepare("PRAGMA table_info(topics)").all() as { name: string }[]
  const topicColNames = new Set(topicCols.map((c) => c.name))
  if (!topicColNames.has('summary')) {
    db.exec('ALTER TABLE topics ADD COLUMN summary TEXT')
  }
  if (!topicColNames.has('bullets')) {
    db.exec('ALTER TABLE topics ADD COLUMN bullets TEXT')
  }
  if (!topicColNames.has('new_info')) {
    db.exec('ALTER TABLE topics ADD COLUMN new_info TEXT')
  }
  if (!topicColNames.has('substantial_event_timestamps')) {
    db.exec('ALTER TABLE topics ADD COLUMN substantial_event_timestamps TEXT')
  }
  if (!topicColNames.has('embedding')) {
    db.exec('ALTER TABLE topics ADD COLUMN embedding BLOB')
  }
  if (!topicColNames.has('embedding_model')) {
    db.exec('ALTER TABLE topics ADD COLUMN embedding_model TEXT')
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

  // Pre-consolidation ingest queue: grabber writes here synchronously, consolidator drains.
  // Decouples grabber → consolidator durability from in-memory state so a kill mid-drain or
  // an LLM outage does not lose articles. Unique on `url` so re-polling the same RSS feed is
  // a no-op; rows are deleted only after the consolidator has fully processed them.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ingest_queue (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      source     TEXT NOT NULL,
      url        TEXT NOT NULL UNIQUE,
      title      TEXT NOT NULL,
      text       TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ingest_queue_id ON ingest_queue(id);
  `)

  // Duplicate-topic candidates (regenerated on demand) and permanent dismissals.
  // Pair is canonicalized so topic_id_a < topic_id_b — prevents (A,B) and (B,A) both existing.
  // FK to topics(id) plus a manual cascade in deleteTopic() keep these in sync with the topic
  // lifecycle (merges/unmerges all funnel through deleteTopic).
  db.exec(`
    CREATE TABLE IF NOT EXISTS topic_dupe_candidates (
      topic_id_a INTEGER NOT NULL REFERENCES topics(id),
      topic_id_b INTEGER NOT NULL REFERENCES topics(id),
      similarity REAL    NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (topic_id_a, topic_id_b),
      CHECK (topic_id_a < topic_id_b)
    );
    CREATE INDEX IF NOT EXISTS idx_topic_dupe_candidates_sim
      ON topic_dupe_candidates(similarity DESC);

    CREATE TABLE IF NOT EXISTS topic_dupe_dismissals (
      topic_id_a   INTEGER NOT NULL REFERENCES topics(id),
      topic_id_b   INTEGER NOT NULL REFERENCES topics(id),
      dismissed_at INTEGER NOT NULL,
      PRIMARY KEY (topic_id_a, topic_id_b),
      CHECK (topic_id_a < topic_id_b)
    );
  `)
}
