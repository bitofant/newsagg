import Parser from 'rss-parser'
import type { RssPollIntervalConfig } from '../config.js'

export interface RawArticle {
  source: string
  url: string
  title: string
  text: string
}

export interface GrabberOptions {
  feeds: string[]
  pollInterval: RssPollIntervalConfig
  onArticle: (article: RawArticle) => void
}

export interface Grabber {
  start(): void
  stop(): void
}

function resolveIntervalMs(feedUrl: string, cfg: RssPollIntervalConfig): number {
  const lc = feedUrl.toLowerCase()
  for (const { pattern, intervalMs } of cfg.overrides) {
    if (lc.includes(pattern)) return intervalMs
  }
  return cfg.defaultMs
}

// IMPLEMENTED
// Dedup is handled by the consolidator via DB (articleExistsByUrl), not here.
export function createGrabber({ feeds, pollInterval, onArticle }: GrabberOptions): Grabber {
  const parser = new Parser()
  const timers: Array<ReturnType<typeof setInterval>> = []

  async function pollFeed(feedUrl: string) {
    try {
      const feed = await parser.parseURL(feedUrl)
      for (const item of feed.items) {
        const url = item.link
        if (!url) continue

        onArticle({
          source: feed.title ?? feedUrl,
          url,
          title: item.title ?? '(no title)',
          text: item.contentSnippet ?? item.content ?? item.summary ?? '',
        })
      }
    } catch (err) {
      console.error(`[grabber] error fetching feed ${feedUrl}:`, err)
    }
  }

  return {
    start() {
      for (const feedUrl of feeds) {
        const intervalMs = resolveIntervalMs(feedUrl, pollInterval)
        pollFeed(feedUrl)
        timers.push(setInterval(() => pollFeed(feedUrl), intervalMs))
      }
    },
    stop() {
      for (const timer of timers) clearInterval(timer)
      timers.length = 0
    },
  }
}
