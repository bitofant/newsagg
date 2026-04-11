import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface Config {
  dbPath: string
  ai: AiConfig
  feeds: string[]
  aggregator: AggregatorConfig
  server: ServerConfig
}

export interface AiConfig {
  url: string
  model: string
  thinkingEffort: 'low' | 'medium' | 'high'
  maxContextTokens: number
  apiKey?: string
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
}

function loadConfig(): Config {
  const configPath = resolve(process.env['CONFIG_PATH'] ?? './config.json')
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'))

  return {
    dbPath: raw.dbPath ?? './newsagg.db',
    ai: {
      url: raw.ai?.url ?? 'http://localhost:11434/v1',
      model: raw.ai?.model ?? 'llama3.2',
      thinkingEffort: raw.ai?.thinkingEffort ?? 'medium',
      maxContextTokens: raw.ai?.maxContextTokens ?? 8192,
      apiKey: raw.ai?.apiKey,
    },
    feeds: raw.feeds ?? [],
    aggregator: {
      intervalMs: raw.aggregator?.intervalMs ?? 15 * 60 * 1000,
      workers: raw.aggregator?.workers ?? 2,
    },
    server: {
      port: raw.server?.port ?? 3000,
      uiDir: raw.server?.uiDir ?? './ui/build',
    },
  }
}

export const config: Config = loadConfig()
