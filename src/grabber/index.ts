import Parser from 'rss-parser'

export interface RawArticle {
  source: string
  url: string
  title: string
  text: string
}

export interface GrabberOptions {
  feeds: string[]
  pollIntervalMs?: number
  onArticle: (article: RawArticle) => void
}

export interface Grabber {
  start(): void
  stop(): void
}

// IMPLEMENTED
// Dedup is handled by the consolidator via DB (articleExistsByUrl), not here.
export function createGrabber({ feeds, pollIntervalMs = 5 * 60 * 1000, onArticle }: GrabberOptions): Grabber {
  const parser = new Parser()
  let timer: ReturnType<typeof setInterval> | null = null

  async function poll() {
    for (const feedUrl of feeds) {
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
  }

  return {
    start() {
      poll()
      timer = setInterval(poll, pollIntervalMs)
    },
    stop() {
      if (timer) clearInterval(timer)
    },
  }
}
