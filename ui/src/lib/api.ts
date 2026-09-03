import { goto } from '$app/navigation'

const BASE = '/api'

/** Thrown when the server rejects our token (401). The session has already been
 *  cleared and a redirect to /login kicked off by the time this surfaces. */
export class SessionExpiredError extends Error {
  constructor() {
    super('Your session has expired. Please sign in again.')
    this.name = 'SessionExpiredError'
  }
}

let redirectingToLogin = false

/** Clear the stale token and bounce to /login. Guarded so a burst of concurrent
 *  401s (e.g. front page + topic list firing together) only triggers one redirect. */
function handleSessionExpiry(): void {
  logout()
  if (redirectingToLogin) return
  redirectingToLogin = true
  void goto('/login')
}

/**
 * Single chokepoint for authenticated API calls. Injects the bearer token,
 * defaults JSON bodies to `Content-Type: application/json`, and turns a 401 into
 * a logout + redirect (throwing SessionExpiredError) instead of letting each
 * caller mis-report an expired session as its own specific failure.
 *
 * Auth-free endpoints (login/register, public /status) deliberately bypass this.
 */
async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const token = localStorage.getItem('token')
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body != null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const res = await fetch(`${BASE}${path}`, { ...init, headers })
  if (res.status === 401) {
    handleSessionExpiry()
    throw new SessionExpiredError()
  }
  return res
}

export async function login(email: string, password: string): Promise<void> {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw new Error((await res.json() as { error: string }).error)
  const { token } = await res.json() as { token: string }
  localStorage.setItem('token', token)
  redirectingToLogin = false
}

export async function register(email: string, password: string): Promise<void> {
  const res = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw new Error((await res.json() as { error: string }).error)
  const { token } = await res.json() as { token: string }
  localStorage.setItem('token', token)
  redirectingToLogin = false
}

export function logout(): void {
  localStorage.removeItem('token')
}

export function isLoggedIn(): boolean {
  return !!localStorage.getItem('token')
}

export interface FrontPage {
  userId: number
  generatedAt: number
  readTopicIds: number[]
  sections: {
    topicId: number
    topicTitle: string
    headline: string
    summary: string
    bullets: string[] | null
    newInfo: string[] | null
    articleIds: number[]
  }[]
}

export async function getFrontPage(): Promise<FrontPage | null> {
  const res = await apiFetch('/frontpage')
  if (res.status === 204) return null
  if (!res.ok) throw new Error('Failed to load front page')
  return res.json() as Promise<FrontPage>
}

export async function requestFrontPage(): Promise<void> {
  const res = await apiFetch('/frontpage', { method: 'POST' })
  if (!res.ok) throw new Error('Failed to request front page')
}

export async function setReadTopics(topicIds: number[]): Promise<void> {
  await apiFetch('/readtopics', { method: 'POST', body: JSON.stringify({ topicIds }) })
}

export async function setTopicRead(topicId: number, read: boolean): Promise<void> {
  await apiFetch(`/readtopics/${topicId}`, { method: 'PUT', body: JSON.stringify({ read }) })
}

export async function vote(articleId: number, vote: 1 | -1 | 0): Promise<void> {
  await apiFetch('/vote', { method: 'POST', body: JSON.stringify({ articleId, vote }) })
}

export interface TopicArticle {
  id: number
  title: string
  source: string
  url: string
  fetchedAt: number
}

export async function getTopicArticles(topicId: number): Promise<TopicArticle[]> {
  const res = await apiFetch(`/topics/${topicId}/articles`)
  if (!res.ok) throw new Error('Failed to load articles')
  return res.json() as Promise<TopicArticle[]>
}

export interface TopicDetail {
  id: number
  title: string
  summary: string | null
  bullets: string[] | null
  newInfo: string[] | null
  createdAt: number
  updatedAt: number
  isRead: boolean
  articles: TopicArticle[]
}

export async function getTopicDetail(topicId: number): Promise<TopicDetail | null> {
  const res = await apiFetch(`/topics/${topicId}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error('Failed to load topic')
  return res.json() as Promise<TopicDetail>
}

export interface TopicListEntry {
  id: number
  title: string
  updatedAt: number
  articleCount: number
}

export async function listTopics(limit = 200): Promise<TopicListEntry[]> {
  const res = await apiFetch(`/topics?limit=${limit}`)
  if (!res.ok) throw new Error('Failed to load topics')
  return res.json() as Promise<TopicListEntry[]>
}

export async function mergeTopic(topicId: number, intoTopicId: number): Promise<{ winnerId: number; winnerTitle: string }> {
  const res = await apiFetch(`/topics/${topicId}/merge`, {
    method: 'POST',
    body: JSON.stringify({ intoTopicId }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: 'merge failed' })) as { error: string }).error)
  return res.json() as Promise<{ winnerId: number; winnerTitle: string }>
}

export async function ungroupArticle(topicId: number, articleId: number): Promise<{ newTopicIds: number[] }> {
  const res = await apiFetch(`/topics/${topicId}/articles/${articleId}/ungroup`, { method: 'POST' })
  if (!res.ok) throw new Error('Failed to ungroup article')
  return res.json() as Promise<{ newTopicIds: number[] }>
}

export async function startUnmerge(topicId: number): Promise<{ ok: boolean; alreadyRunning?: boolean }> {
  const res = await apiFetch(`/topics/${topicId}/unmerge`, { method: 'POST' })
  if (!res.ok) throw new Error('Failed to start unmerge')
  return res.json() as Promise<{ ok: boolean; alreadyRunning?: boolean }>
}

export interface UnmergeResult {
  status: 'pending' | 'done' | 'error'
  newTopics?: { id: number; title: string }[]
  error?: string
}

export async function pollUnmergeResult(topicId: number, waitSec = 30): Promise<UnmergeResult> {
  const res = await apiFetch(`/topics/${topicId}/unmerge-result?wait=${waitSec}`)
  if (!res.ok) throw new Error('Failed to fetch unmerge result')
  return res.json() as Promise<UnmergeResult>
}

export type RegenSummaryResult =
  | { mode: 'short'; summary: string }
  | { mode: 'long'; summary: string; bullets: string[]; newInfo: string[] }

export interface RegenStreamCallbacks {
  onReasoning?: (delta: string) => void
  onContent?: (delta: string) => void
}

export async function regenerateTopicSummary(
  topicId: number,
  callbacks: RegenStreamCallbacks,
): Promise<RegenSummaryResult> {
  const res = await apiFetch(`/topics/${topicId}/regenerate-summary`, { method: 'POST' })
  if (!res.ok || !res.body) {
    throw new Error(`Regenerate failed: ${res.status}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: RegenSummaryResult | null = null
  let errorMessage: string | null = null

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let sep
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      let event = 'message'
      const dataLines: string[] = []
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
      }
      if (dataLines.length === 0) continue
      let payload: unknown
      try {
        payload = JSON.parse(dataLines.join('\n'))
      } catch { continue }

      if (event === 'reasoning') {
        callbacks.onReasoning?.((payload as { delta: string }).delta)
      } else if (event === 'content') {
        callbacks.onContent?.((payload as { delta: string }).delta)
      } else if (event === 'done') {
        result = payload as RegenSummaryResult
      } else if (event === 'error') {
        errorMessage = (payload as { error?: string }).error ?? 'regenerate failed'
      }
    }
  }

  if (errorMessage) throw new Error(errorMessage)
  if (!result) throw new Error('regenerate stream ended without result')
  return result
}

export interface DupeCandidate {
  topicIdA: number
  topicIdB: number
  similarity: number
  createdAt: number
  titleA: string
  titleB: string
  articleCountA: number
  articleCountB: number
}

export interface DupeFinderStatus {
  state: 'idle' | 'running' | 'done' | 'error' | 'cancelled'
  startedAt?: number
  completedAt?: number
  candidateCount?: number
  error?: string
}

export async function listDupeCandidates(): Promise<{ candidates: DupeCandidate[]; status: DupeFinderStatus }> {
  const res = await apiFetch('/dupes')
  if (!res.ok) throw new Error('Failed to load dupe candidates')
  return res.json() as Promise<{ candidates: DupeCandidate[]; status: DupeFinderStatus }>
}

export async function startDupeGeneration(): Promise<{ ok: boolean; alreadyRunning?: boolean }> {
  const res = await apiFetch('/dupes/generate', { method: 'POST' })
  if (!res.ok) throw new Error('Failed to start dupe generation')
  return res.json() as Promise<{ ok: boolean; alreadyRunning?: boolean }>
}

export async function cancelDupeGeneration(): Promise<void> {
  const res = await apiFetch('/dupes/cancel', { method: 'POST' })
  if (!res.ok) throw new Error('Failed to cancel dupe generation')
}

export async function pollDupeStatus(waitSec = 30): Promise<DupeFinderStatus> {
  const res = await apiFetch(`/dupes/status?wait=${waitSec}`)
  if (!res.ok) throw new Error('Failed to poll dupe status')
  return res.json() as Promise<DupeFinderStatus>
}

export async function dismissDupePair(topicIdA: number, topicIdB: number): Promise<void> {
  const res = await apiFetch('/dupes/dismiss', {
    method: 'POST',
    body: JSON.stringify({ topicIdA, topicIdB }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: 'dismiss failed' })) as { error: string }).error)
}

export interface Preferences {
  intervalMs: number
  preferenceProfile: string
  manualPreferences: string
  preferenceGeneratedAt: number | null
}

export interface PreferencesUpdate {
  intervalMs?: number
  manualPreferences?: string
}

export async function getPreferences(): Promise<Preferences> {
  const res = await apiFetch('/preferences')
  if (!res.ok) throw new Error('Failed to load preferences')
  return res.json() as Promise<Preferences>
}

export async function updatePreferences(update: PreferencesUpdate): Promise<Preferences> {
  const res = await apiFetch('/preferences', { method: 'PATCH', body: JSON.stringify(update) })
  if (!res.ok) throw new Error((await res.json() as { error: string }).error)
  return res.json() as Promise<Preferences>
}

export interface Status {
  timestamp: number
  startedAt: number
  builtAt: number
  llm: {
    busyPct: number; reqPerMin: number; tokPerSec: number; reasoningTokPerSec: number;
    cacheHitPct: number; windowMs: number;
    inFlight: number; queueDepthNormal: number; queueDepthLow: number; maxConcurrency: number
  }
  consolidator: { bufferDepth: number; processing: boolean; pendingRegens: number; estimatedBehindMs: number | null }
  aggregator: { queueLength: number; activeWorkers: number }
  db: { topicCount: number; totalArticles: number }
  users: {
    id: number
    email: string
    intervalMs: number
    lastFrontPageAt: number | null
    overdueBy: number | null
    recentSignalCount: number
  }[]
}

export async function getStatus(): Promise<Status> {
  const res = await fetch(`${BASE}/status`)
  if (!res.ok) throw new Error('Failed to load status')
  return res.json() as Promise<Status>
}

export function subscribeToFrontPage(
  onUpdate: (generatedAt: number) => void,
): () => void {
  const token = localStorage.getItem('token')
  if (!token) return () => {}

  let es: EventSource | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryDelay = 3_000

  function connect() {
    es = new EventSource(`${BASE}/events?token=${encodeURIComponent(token!)}`)
    es.addEventListener('frontpage', (e: MessageEvent) => {
      retryDelay = 3_000
      onUpdate((JSON.parse(e.data) as { generatedAt: number }).generatedAt)
    })
    es.onerror = () => {
      if (es?.readyState === EventSource.CLOSED) {
        es = null
        // EventSource doesn't expose the HTTP status, so we can't tell a 401 from a
        // dropped connection here. But a session expiry on any other call clears the
        // token (see handleSessionExpiry); if it's gone, stop reconnecting instead of
        // hammering the 401'd endpoint forever.
        if (!localStorage.getItem('token')) return
        retryTimer = setTimeout(() => {
          retryDelay = Math.min(retryDelay * 2, 30_000)
          connect()
        }, retryDelay)
      }
    }
  }

  connect()
  return () => {
    es?.close()
    if (retryTimer) clearTimeout(retryTimer)
  }
}
