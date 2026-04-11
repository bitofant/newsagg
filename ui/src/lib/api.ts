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
  sections: {
    topicId: number
    topicTitle: string
    headline: string
    summary: string
    articleIds: number[]
  }[]
}

export async function getFrontPage(): Promise<FrontPage | null> {
  const res = await fetch(`${BASE}/frontpage`, { headers: authHeaders() })
  if (res.status === 204) return null
  if (!res.ok) throw new Error('Failed to load front page')
  return res.json() as Promise<FrontPage>
}

export async function vote(articleId: number, vote: 1 | -1): Promise<void> {
  await fetch(`${BASE}/vote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ articleId, vote }),
  })
}

export interface Preferences {
  intervalMs: number
}

export async function getPreferences(): Promise<Preferences> {
  const res = await fetch(`${BASE}/preferences`, { headers: authHeaders() })
  if (!res.ok) throw new Error('Failed to load preferences')
  return res.json() as Promise<Preferences>
}

export async function updatePreferences(prefs: Preferences): Promise<void> {
  const res = await fetch(`${BASE}/preferences`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(prefs),
  })
  if (!res.ok) throw new Error((await res.json() as { error: string }).error)
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
