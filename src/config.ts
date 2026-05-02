import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

export interface Config {
  dbPath: string
  ai: AiConfig
  feeds: string[]
  rssPollInterval: RssPollIntervalConfig
  consolidator: ConsolidatorConfig
  aggregator: AggregatorConfig
  server: ServerConfig
}

export interface RssPollIntervalConfig {
  /** Poll interval (ms) used when no override matches a feed URL. */
  defaultMs: number
  /** Per-feed overrides; the first entry whose pattern is a case-insensitive substring of the feed URL wins. */
  overrides: Array<{ pattern: string; intervalMs: number }>
}

export interface AiConfig {
  /** Inference backend; selects which provider class is instantiated. */
  backend: 'ollama' | 'vllm'
  url: string
  /** Model name, or "auto" to fetch the first model from /v1/models (vLLM only). */
  model: string
  /** Context window size in tokens, or "auto" to fetch max_model_len from /v1/models (vLLM only). */
  maxContextTokens: number | 'auto'
  apiKey?: string
  /** Rolling window (ms) for LLM call metrics on /status. Default: 10 minutes. */
  statusWindowMs: number
  /** Per-request HTTP timeout in ms. Default: 5 minutes. */
  requestTimeoutMs: number
  /**
   * Max in-flight LLM requests across all priorities. Excess requests queue; low-priority calls
   * (topic matching) wait until the normal-priority queue is empty. Default: 12 (vLLM scheduler ceiling).
   */
  maxConcurrency: number
}

export interface ConsolidatorConfig {
  /** Rolling window (ms) for processing activity metrics on /status. Default: 10 minutes. */
  statusWindowMs: number
}

export interface AggregatorConfig {
  /** How often (ms) to schedule a front page generation per user */
  intervalMs: number
  /** Max concurrent front page generation workers */
  workers: number
}

export interface ServerConfig {
  port: number
  /** Directory where built SvelteKit UI is located */
  uiDir: string
  /** Whether new user registration is allowed. Set to true to open registration. */
  registrationEnabled: boolean
}

function parseDuration(s: string): number {
  const m = s.trim().match(/^(\d+)\s*(ms|s|m|h)$/)
  if (!m) throw new Error(`Invalid duration "${s}" — expected e.g. "500ms", "30s", "10m", "2h"`)
  const n = parseInt(m[1]!, 10)
  switch (m[2]) {
    case 'ms': return n
    case 's': return n * 1000
    case 'm': return n * 60 * 1000
    case 'h': return n * 60 * 60 * 1000
  }
  throw new Error('unreachable')
}

function loadRssPollInterval(raw: any): RssPollIntervalConfig {
  const defaultMs = raw?.default ? parseDuration(raw.default) : 5 * 60 * 1000
  const rawOverrides = raw?.overrides ?? {}
  const overrides = Object.entries(rawOverrides).map(([pattern, value]) => {
    if (typeof value !== 'string') throw new Error(`rssPollInterval.overrides[${pattern}] must be a duration string`)
    return { pattern: pattern.toLowerCase(), intervalMs: parseDuration(value) }
  })
  return { defaultMs, overrides }
}

function loadConfig(): Config {
  const configPath = resolve(process.env['CONFIG_PATH'] ?? './config.json')
  if (!existsSync(configPath)) {
    console.error(`Config file not found: ${configPath}`)
    console.error(`Create it from the template: cp config.example.json config.json`)
    process.exit(1)
  }
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'))

  return {
    dbPath: raw.dbPath ?? './newsagg.db',
    ai: {
      backend: raw.ai?.backend ?? 'ollama',
      url: raw.ai?.url ?? 'http://localhost:11434/v1',
      model: raw.ai?.model ?? 'llama3.2',
      maxContextTokens: raw.ai?.maxContextTokens ?? 8192,
      apiKey: raw.ai?.apiKey,
      statusWindowMs: raw.ai?.statusWindowMs ?? 10 * 60 * 1000,
      requestTimeoutMs: raw.ai?.requestTimeoutMs ?? 5 * 60 * 1000,
      maxConcurrency: raw.ai?.maxConcurrency ?? 12,
    },
    feeds: raw.feeds ?? [],
    rssPollInterval: loadRssPollInterval(raw.rssPollInterval),
    consolidator: {
      statusWindowMs: raw.consolidator?.statusWindowMs ?? 10 * 60 * 1000,
    },
    aggregator: {
      intervalMs: raw.aggregator?.intervalMs ?? 15 * 60 * 1000,
      workers: raw.aggregator?.workers ?? 2,
    },
    server: {
      port: raw.server?.port ?? 3000,
      uiDir: raw.server?.uiDir ?? './ui/build',
      registrationEnabled: raw.server?.registrationEnabled ?? false,
    },
  }
}

export const config: Config = loadConfig()
