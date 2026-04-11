import { DatabaseSync } from 'node:sqlite'
import { applySchema } from './schema.js'
import type { NewsDb } from './news.js'
import type { UserDb } from './users.js'
import { createNewsDb } from './news.js'
import { createUserDb } from './users.js'

export interface Db {
  news: NewsDb
  users: UserDb
}

// IMPLEMENTED
export function createDb(path: string): Db {
  const sqlite = new DatabaseSync(path)
  applySchema(sqlite)
  return {
    news: createNewsDb(sqlite),
    users: createUserDb(sqlite),
  }
}
