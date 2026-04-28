const BASE = '/api'

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('token')
  return token ? { Authorization: `Bearer ${token}` } : {}
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
  const res = await fetch(`${BASE}/frontpage`, { headers: authHeaders() })
  if (res.status === 204) return null
  if (!res.ok) throw new Error('Failed to load front page')
  return res.json() as Promise<FrontPage>
}

export async function requestFrontPage(): Promise<void> {
  const res = await fetch(`${BASE}/frontpage`, { method: 'POST', headers: authHeaders() })
  if (!res.ok) throw new Error('Failed to request front page')
}

export async function setReadTopics(topicIds: number[]): Promise<void> {
  await fetch(`${BASE}/readtopics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ topicIds }),
  })
}

export async function setTopicRead(topicId: number, read: boolean): Promise<void> {
  await fetch(`${BASE}/readtopics/${topicId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ read }),
  })
}

export async function vote(articleId: number, vote: 1 | -1 | 0): Promise<void> {
  await fetch(`${BASE}/vote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ articleId, vote }),
  })
}

export interface TopicArticle {
  id: number
  title: string
  source: string
  url: string
  fetchedAt: number
}

export async function getTopicArticles(topicId: number): Promise<TopicArticle[]> {
  const res = await fetch(`${BASE}/topics/${topicId}/articles`, { headers: authHeaders() })
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
  const res = await fetch(`${BASE}/topics/${topicId}`, { headers: authHeaders() })
  if (res.status === 404) return null
  if (!res.ok) throw new Error('Failed to load topic')
  return res.json() as Promise<TopicDetail>
}

export async function ungroupArticle(topicId: number, articleId: number): Promise<{ newTopicIds: number[] }> {
  const res = await fetch(`${BASE}/topics/${topicId}/articles/${articleId}/ungroup`, {
    method: 'POST',
    headers: authHeaders(),
  })
  if (!res.ok) throw new Error('Failed to ungroup article')
  return res.json() as Promise<{ newTopicIds: number[] }>
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
  const res = await fetch(`${BASE}/preferences`, { headers: authHeaders() })
  if (!res.ok) throw new Error('Failed to load preferences')
  return res.json() as Promise<Preferences>
}

export async function updatePreferences(update: PreferencesUpdate): Promise<Preferences> {
  const res = await fetch(`${BASE}/preferences`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(update),
  })
  if (!res.ok) throw new Error((await res.json() as { error: string }).error)
  return res.json() as Promise<Preferences>
}

export interface Status {
  timestamp: number
  startedAt: number
  builtAt: number
  llm: { busyPct: number; reqPerMin: number; tokPerSec: number; reasoningTokPerSec: number; windowMs: number }
  consolidator: { bufferDepth: number; processing: boolean; estimatedBehindMs: number | null }
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
