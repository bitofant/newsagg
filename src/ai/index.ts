import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AiConfig } from '../config.js'

export interface AiClient {
  complete(prompt: string, systemPrompt?: string): Promise<string>
  /** Configured max input context tokens. Callers use this to size batched prompts. */
  readonly maxContextTokens: number
  /** Rolling-window metrics for /status. busyPct can exceed 100% if calls overlap. */
  status(): { busyPct: number; reqPerMin: number; tokPerSec: number; windowMs: number }
}

const LLM_LOG_DIR = './llm'

function logLlmCall(
  timestamp: number,
  req: { model: string; messages: { role: string; content: string }[] },
  content: string,
  reasoning?: string,
): void {
  const date = new Date(timestamp * 1000)
  const day = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
  const dir = join(LLM_LOG_DIR, day)
  const base = join(dir, String(timestamp))

  const work = async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(`${base}.req`, JSON.stringify(req, null, 2))
    await writeFile(`${base}.res`, content)
    if (reasoning) {
      await writeFile(`${base}.think`, reasoning)
    }
  }

  work().catch((err) => console.error('[ai] llm log write failed:', err))
}

// IMPLEMENTED
export function createAi(config: AiConfig): AiClient {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
  }

  const callHistory: { startedAt: number; endedAt: number; promptTokens: number; completionTokens: number }[] = []

  function pruneHistory(now: number) {
    const cutoff = now - config.statusWindowMs
    while (callHistory.length > 0 && callHistory[0].endedAt < cutoff) {
      callHistory.shift()
    }
  }

  async function complete(prompt: string, systemPrompt?: string): Promise<string> {
    const messages: { role: string; content: string }[] = []

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt })
    }
    messages.push({ role: 'user', content: prompt })

    const timestamp = Math.floor(Date.now() / 1000)
    const startedAt = Date.now()

    const response = await fetch(`${config.url}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        messages,
        max_tokens: 4096,
        // thinking_effort: config.thinkingEffort, // enable when model supports it
      }),
    })

    if (!response.ok) {
      throw new Error(`AI request failed: ${response.status} ${await response.text()}`)
    }

    const data = (await response.json()) as {
      choices: { message: { content: string; reasoning_content?: string } }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }

    const endedAt = Date.now()
    callHistory.push({
      startedAt,
      endedAt,
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
    })
    pruneHistory(endedAt)

    const msg = data.choices[0]!.message
    logLlmCall(timestamp, { model: config.model, messages }, msg.content, msg.reasoning_content)

    return msg.content
  }

  function status() {
    const now = Date.now()
    pruneHistory(now)
    if (callHistory.length === 0) {
      return { busyPct: 0, reqPerMin: 0, tokPerSec: 0, windowMs: config.statusWindowMs }
    }
    let totalDurationMs = 0
    let totalTokens = 0
    for (const c of callHistory) {
      totalDurationMs += c.endedAt - c.startedAt
      totalTokens += c.promptTokens + c.completionTokens
    }
    const windowMs = Math.min(now - callHistory[0].startedAt, config.statusWindowMs)
    const busyPct = windowMs > 0 ? Math.round((totalDurationMs / windowMs) * 100) : 0
    const reqPerMin = windowMs > 0 ? Math.round((callHistory.length / windowMs) * 60_000) : 0
    const tokPerSec = windowMs > 0 ? Math.round((totalTokens / windowMs) * 1000) : 0
    return { busyPct, reqPerMin, tokPerSec, windowMs: config.statusWindowMs }
  }

  return { complete, maxContextTokens: config.maxContextTokens, status }
}
