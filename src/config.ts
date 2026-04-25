import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

export interface Config {
  dbPath: string
  ai: AiConfig
  feeds: string[]
  consolidator: ConsolidatorConfig
  aggregator: AggregatorConfig
  server: ServerConfig
}

export interface AiConfig {
  url: string
  /** Model name, or "auto" to fetch the first model from /v1/models (vLLM) */
  model: string
  thinkingEffort: 'low' | 'medium' | 'high'
  /** Context window size in tokens, or "auto" to fetch max_model_len from /v1/models (vLLM) */
  maxContextTokens: number | 'auto'
  apiKey?: string
  /** Rolling window (ms) for LLM call metrics on /status. Default: 10 minutes. */
  statusWindowMs: number
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
      url: raw.ai?.url ?? 'http://localhost:11434/v1',
      model: raw.ai?.model ?? 'llama3.2',
      thinkingEffort: raw.ai?.thinkingEffort ?? 'medium',
      maxContextTokens: raw.ai?.maxContextTokens ?? 8192,
      apiKey: raw.ai?.apiKey,
      statusWindowMs: raw.ai?.statusWindowMs ?? 10 * 60 * 1000,
    },
    feeds: raw.feeds ?? [],
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
