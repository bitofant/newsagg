import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import path from 'path'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ServerResponse } from 'http'
import type { Db } from '../db/index.js'
import { getAi } from '../ai/index.js'
import type { Aggregator } from '../aggregator/index.js'
import type { Consolidator } from '../consolidator/index.js'
import type { Profiler } from '../profiler/index.js'
import type { ServerConfig } from '../config.js'

const JWT_SECRET = loadJwtSecret()
const STARTED_AT = Date.now()
const BUILT_AT = statSync(fileURLToPath(import.meta.url)).mtimeMs

function loadJwtSecret(): string {
  if (process.env['JWT_SECRET']) return process.env['JWT_SECRET']

  const secretFile = '.jwt_secret'
  if (existsSync(secretFile)) {
    const secret = readFileSync(secretFile, 'utf-8').trim()
    if (secret) return secret
  }

  const secret = randomBytes(32).toString('hex')
  writeFileSync(secretFile, secret, { mode: 0o600 })
  console.log('Generated new JWT secret and saved to .jwt_secret')
  return secret
}

export interface ServerOptions {
  db: Db
  aggregator: Aggregator
  consolidator: Consolidator
  profiler: Profiler
  config: ServerConfig
}

// IMPLEMENTED: auth routes, front page API, voting endpoint, user preferences, SSE push for new front pages
export async function createServer({ db, aggregator, consolidator, profiler, config }: ServerOptions) {
  const app = Fastify({ logger: true })

  // SSE connections: userId -> set of active response streams
  const sseClients = new Map<number, Set<ServerResponse>>()

  function addSseClient(userId: number, res: ServerResponse) {
    if (!sseClients.has(userId)) sseClients.set(userId, new Set())
    sseClients.get(userId)!.add(res)
    res.on('close', () => {
      sseClients.get(userId)?.delete(res)
      if (sseClients.get(userId)?.size === 0) sseClients.delete(userId)
    })
  }

  function notifyUser(userId: number, generatedAt: number) {
    const clients = sseClients.get(userId)
    if (!clients) return
    const frame = `event: frontpage\ndata: ${JSON.stringify({ generatedAt })}\n\n`
    for (const res of clients) res.write(frame)
  }

  // Serve built SvelteKit UI
  await app.register(fastifyStatic, {
    root: path.resolve(config.uiDir),
    prefix: '/',
  })

  // --- Auth ---

  app.get('/api/registration-enabled', async () => {
    return { enabled: config.registrationEnabled }
  })

  app.post('/api/register', async (req, reply) => {
    if (!config.registrationEnabled) return reply.status(403).send({ error: 'registration is disabled' })
    const { email, password } = req.body as { email?: string; password?: string }
    if (!email || !password) return reply.status(400).send({ error: 'email and password required' })

    if (db.users.findUserByEmail(email)) {
      return reply.status(409).send({ error: 'email already registered' })
    }

    const passwordHash = await bcrypt.hash(password, 12)
    const user = db.users.createUser(email, passwordHash)
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' })
    return { token }
  })

  app.post('/api/login', async (req, reply) => {
    const { email, password } = req.body as { email?: string; password?: string }
    if (!email || !password) return reply.status(400).send({ error: 'email and password required' })

    const user = db.users.findUserByEmail(email)
    if (!user) return reply.status(401).send({ error: 'invalid credentials' })

    const valid = await bcrypt.compare(password, user.passwordHash)
    if (!valid) return reply.status(401).send({ error: 'invalid credentials' })

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' })
    return { token }
  })

  // --- Front page ---

  app.get('/api/frontpage', async (req, reply) => {
    const userId = authenticate(req)
    if (!userId) return reply.status(401).send({ error: 'unauthorized' })

    const page = aggregator.getLatestFrontPage(userId)
    if (!page) return reply.status(204).send()
    const readTopicIds = [...db.users.getReadTopicIds(userId)]
    return { ...page, readTopicIds }
  })

  app.post('/api/frontpage', async (req, reply) => {
    const userId = authenticate(req)
    if (!userId) return reply.status(401).send({ error: 'unauthorized' })
    aggregator.requestFrontPage(userId)
    return { ok: true }
  })

  app.post('/api/readtopics', async (req, reply) => {
    const userId = authenticate(req)
    if (!userId) return reply.status(401).send({ error: 'unauthorized' })
    const { topicIds } = req.body as { topicIds?: number[] }
    if (!Array.isArray(topicIds) || !topicIds.every((id) => typeof id === 'number')) {
      return reply.status(400).send({ error: 'topicIds must be an array of numbers' })
    }
    db.users.setReadTopics(userId, topicIds)
    return { ok: true }
  })

  app.put('/api/readtopics/:topicId', async (req, reply) => {
    const userId = authenticate(req)
    if (!userId) return reply.status(401).send({ error: 'unauthorized' })
    const topicId = parseInt((req.params as { topicId: string }).topicId, 10)
    if (isNaN(topicId)) return reply.status(400).send({ error: 'invalid topicId' })
    const { read } = req.body as { read?: boolean }
    if (typeof read !== 'boolean') return reply.status(400).send({ error: 'read (boolean) required' })
    db.users.setTopicRead(userId, topicId, read)
    return { ok: true }
  })

  // --- Voting ---
  app.post('/api/vote', async (req, reply) => {
    const userId = authenticate(req)
    if (!userId) return reply.status(401).send({ error: 'unauthorized' })

    const { articleId, vote } = req.body as { articleId?: number; vote?: number }
    if (!articleId || (vote !== 1 && vote !== -1 && vote !== 0)) {
      return reply.status(400).send({ error: 'articleId and vote (1, -1, or 0) required' })
    }

    db.users.recordVote(userId, articleId, vote as 1 | -1 | 0)
    profiler.onVote(userId)
    return { ok: true }
  })

  // --- Preferences ---

  app.get('/api/preferences', async (req, reply) => {
    const userId = authenticate(req)
    if (!userId) return reply.status(401).send({ error: 'unauthorized' })

    const user = db.users.getUserById(userId)
    if (!user) return reply.status(404).send({ error: 'user not found' })
    return { intervalMs: user.intervalMs, preferenceProfile: user.preferenceProfile ?? '' }
  })

  app.patch('/api/preferences', async (req, reply) => {
    const userId = authenticate(req)
    if (!userId) return reply.status(401).send({ error: 'unauthorized' })

    const { intervalMs, preferenceProfile } = req.body as { intervalMs?: number; preferenceProfile?: string }

    if (intervalMs !== undefined) {
      if (typeof intervalMs !== 'number' || intervalMs < 5 * 60 * 1000 || intervalMs > 24 * 60 * 60 * 1000) {
        return reply.status(400).send({ error: 'intervalMs must be between 5 minutes and 24 hours' })
      }
      db.users.updateUserInterval(userId, intervalMs)
    }

    if (preferenceProfile !== undefined) {
      if (typeof preferenceProfile !== 'string' || preferenceProfile.length > 10000) {
        return reply.status(400).send({ error: 'preferenceProfile must be a string under 10000 chars' })
      }
      db.users.updatePreferenceProfile(userId, preferenceProfile)
    }

    const user = db.users.getUserById(userId)
    return { intervalMs: user!.intervalMs, preferenceProfile: user!.preferenceProfile ?? '' }
  })

  // --- Topics ---

  app.get('/api/topics/:topicId', async (req, reply) => {
    const userId = authenticate(req)
    if (!userId) return reply.status(401).send({ error: 'unauthorized' })

    const topicId = parseInt((req.params as { topicId: string }).topicId, 10)
    if (isNaN(topicId)) return reply.status(400).send({ error: 'invalid topicId' })

    const topic = db.news.getTopic(topicId)
    if (!topic) return reply.status(404).send({ error: 'topic not found' })

    const articles = db.news.listArticlesByTopic(topicId).map(({ id, title, source, url, fetchedAt }) => ({
      id,
      title,
      source,
      url,
      fetchedAt,
    }))
    const isRead = db.users.getReadTopicIds(userId).has(topicId)

    return {
      id: topic.id,
      title: topic.title,
      summary: topic.summary,
      bullets: topic.bullets,
      newInfo: topic.newInfo,
      createdAt: topic.createdAt,
      updatedAt: topic.updatedAt,
      isRead,
      articles,
    }
  })

  app.get('/api/topics/:topicId/articles', async (req, reply) => {
    const userId = authenticate(req)
    if (!userId) return reply.status(401).send({ error: 'unauthorized' })

    const topicId = parseInt((req.params as { topicId: string }).topicId, 10)
    if (isNaN(topicId)) return reply.status(400).send({ error: 'invalid topicId' })

    const articles = db.news.listArticlesByTopic(topicId)
    return articles.map(({ id, title, source, url, fetchedAt }) => ({ id, title, source, url, fetchedAt }))
  })

  app.post('/api/topics/:topicId/articles/:articleId/ungroup', async (req, reply) => {
    const userId = authenticate(req)
    if (!userId) return reply.status(401).send({ error: 'unauthorized' })

    const topicId = parseInt((req.params as { topicId: string }).topicId, 10)
    const articleId = parseInt((req.params as { articleId: string }).articleId, 10)
    if (isNaN(topicId) || isNaN(articleId)) return reply.status(400).send({ error: 'invalid topicId or articleId' })

    try {
      const result = await consolidator.ungroupArticle(articleId, topicId)
      return result
    } catch (err) {
      req.log.error(err, 'ungroup failed')
      return reply.status(500).send({ error: 'ungroup failed' })
    }
  })

  // --- SSE: real-time front page push ---

  app.get('/api/events', async (req, reply) => {
    // Auth via query param — EventSource cannot send custom headers
    const token = (req.query as Record<string, string>).token
    let userId: number | null = null
    if (token) {
      try {
        userId = (jwt.verify(token, JWT_SECRET) as { userId: number }).userId
      } catch { /* invalid token */ }
    }
    if (!userId) return reply.status(401).send({ error: 'unauthorized' })

    const res = reply.raw
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 25_000)
    res.on('close', () => clearInterval(keepalive))

    addSseClient(userId, res)
    await reply.hijack()
  })

  // --- Status ---

  app.get('/api/status', async () => {
    const now = Date.now()
    const users = db.users.listAllUsers().map((user) => {
      const lastFrontPage = db.users.getLastFrontPageTime(user.id)
      const elapsed = lastFrontPage != null ? now - lastFrontPage : null
      const overdue = elapsed != null ? elapsed > user.intervalMs : true
      const signals = db.users.readSignalsInWindow(user.id, 14 * 24 * 60 * 60 * 1000)
      return {
        id: user.id,
        email: user.email,
        intervalMs: user.intervalMs,
        lastFrontPageAt: lastFrontPage ?? null,
        overdueBy: overdue ? (elapsed != null ? elapsed - user.intervalMs : null) : 0,
        recentSignalCount: signals.length,
      }
    })

    return {
      timestamp: now,
      startedAt: STARTED_AT,
      builtAt: BUILT_AT,
      llm: getAi().status(),
      consolidator: consolidator.status(),
      aggregator: aggregator.status(),
      db: { topicCount: db.news.topicCount(), totalArticles: db.news.totalArticleCount() },
      users,
    }
  })

  // Fallback: serve SvelteKit's index.html for client-side routing
  app.setNotFoundHandler((_req, reply) => {
    reply.sendFile('index.html')
  })

  return {
    async listen() {
      await app.listen({ port: config.port, host: '0.0.0.0' })
    },
    notifyFrontPageGenerated(userId: number, generatedAt: number) {
      notifyUser(userId, generatedAt)
    },
  }
}

function authenticate(req: { headers: { authorization?: string } }): number | null {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return null
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET) as { userId: number }
    return payload.userId
  } catch {
    return null
  }
}
