import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import path from 'path'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import type { ServerResponse } from 'http'
import type { Db } from '../db/index.js'
import type { Aggregator } from '../aggregator/index.js'
import type { ServerConfig } from '../config.js'

const JWT_SECRET = process.env['JWT_SECRET'] ?? 'dev-secret-change-in-production'

export interface ServerOptions {
  db: Db
  aggregator: Aggregator
  config: ServerConfig
}

// IMPLEMENTED: auth routes, front page API, voting endpoint, user preferences, SSE push for new front pages
export async function createServer({ db, aggregator, config }: ServerOptions) {
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

  app.post('/api/register', async (req, reply) => {
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
    return page
  })

  // --- Voting ---
  app.post('/api/vote', async (req, reply) => {
    const userId = authenticate(req)
    if (!userId) return reply.status(401).send({ error: 'unauthorized' })

    const { articleId, vote } = req.body as { articleId?: number; vote?: number }
    if (!articleId || (vote !== 1 && vote !== -1)) {
      return reply.status(400).send({ error: 'articleId and vote (1 or -1) required' })
    }

    db.users.recordVote(userId, articleId, vote as 1 | -1)
    return { ok: true }
  })

  // --- Preferences ---

  app.get('/api/preferences', async (req, reply) => {
    const userId = authenticate(req)
    if (!userId) return reply.status(401).send({ error: 'unauthorized' })

    const user = db.users.getUserById(userId)
    if (!user) return reply.status(404).send({ error: 'user not found' })
    return { intervalMs: user.intervalMs }
  })

  app.patch('/api/preferences', async (req, reply) => {
    const userId = authenticate(req)
    if (!userId) return reply.status(401).send({ error: 'unauthorized' })

    const { intervalMs } = req.body as { intervalMs?: number }
    if (typeof intervalMs !== 'number' || intervalMs < 5 * 60 * 1000 || intervalMs > 24 * 60 * 60 * 1000) {
      return reply.status(400).send({ error: 'intervalMs must be between 5 minutes and 24 hours' })
    }

    db.users.updateUserInterval(userId, intervalMs)
    return { intervalMs }
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
