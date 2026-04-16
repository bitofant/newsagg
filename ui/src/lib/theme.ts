export type Theme = 'light' | 'dark'

export function getTheme(): Theme {
  try {
    const stored = localStorage.getItem('theme')
    if (stored === 'light' || stored === 'dark') return stored
  } catch {}
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function setTheme(t: Theme) {
  try { localStorage.setItem('theme', t) } catch {}
  document.documentElement.classList.toggle('dark', t === 'dark')
}

export function toggleTheme() {
  setTheme(getTheme() === 'dark' ? 'light' : 'dark')
}
