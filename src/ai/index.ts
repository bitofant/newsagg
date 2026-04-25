import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AiConfig } from '../config.js'

export interface CompleteOptions {
  systemPrompt?: string
  /** Reasoning effort. Sent as `reasoning_effort` (OpenAI-compatible). Omit to leave at backend default. */
  reasoningEffort?: 'low' | 'medium' | 'high'
}

export interface AiClient {
  complete(prompt: string, opts?: CompleteOptions): Promise<string>
  /** Configured max input context tokens. Callers use this to size batched prompts. */
  readonly maxContextTokens: number
  /** Rolling-window metrics for /status. busyPct can exceed 100% if calls overlap. */
  status(): {
    busyPct: number
    reqPerMin: number
    tokPerSec: number
    reasoningTokPerSec: number
    windowMs: number
  }
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

async function fetchModelInfo(
  url: string,
  headers: Record<string, string>,
): Promise<{ id: string; max_model_len?: number }> {
  const res = await fetch(`${url}/models`, { headers })
  if (!res.ok) throw new Error(`[ai] GET /models failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { data: Array<{ id: string; max_model_len?: number }> }
  const first = body.data[0]
  if (!first) throw new Error('[ai] /v1/models returned an empty list')
  return first
}

// IMPLEMENTED
export async function createAi(config: AiConfig): Promise<AiClient> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
  }

  let resolvedModel = config.model
  let resolvedMaxContextTokens: number =
    typeof config.maxContextTokens === 'number' ? config.maxContextTokens : 0

  if (config.model === 'auto' || config.maxContextTokens === 'auto') {
    const info = await fetchModelInfo(config.url, headers)
    if (config.model === 'auto') {
      resolvedModel = info.id
      console.log(`[ai] auto-detected model: ${resolvedModel}`)
    }
    if (config.maxContextTokens === 'auto') {
      if (info.max_model_len == null) {
        throw new Error(
          `[ai] maxContextTokens is "auto" but /v1/models did not return max_model_len for "${resolvedModel}". Set it explicitly in config.json.`,
        )
      }
      resolvedMaxContextTokens = info.max_model_len
      console.log(`[ai] auto-detected maxContextTokens: ${resolvedMaxContextTokens}`)
    }
  }

  const callHistory: {
    startedAt: number
    endedAt: number
    promptTokens: number
    completionTokens: number
    reasoningTokens: number
  }[] = []

  function pruneHistory(now: number) {
    const cutoff = now - config.statusWindowMs
    while (callHistory.length > 0 && callHistory[0].endedAt < cutoff) {
      callHistory.shift()
    }
  }

  async function complete(prompt: string, opts?: CompleteOptions): Promise<string> {
    const messages: { role: string; content: string }[] = []

    if (opts?.systemPrompt) {
      messages.push({ role: 'system', content: opts.systemPrompt })
    }
    messages.push({ role: 'user', content: prompt })

    const timestamp = Math.floor(Date.now() / 1000)
    const startedAt = Date.now()

    const body: Record<string, unknown> = {
      model: resolvedModel,
      messages,
      max_tokens: 4096,
    }
    if (opts?.reasoningEffort) {
      body['reasoning_effort'] = opts.reasoningEffort
    }

    const response = await fetch(`${config.url}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      throw new Error(`AI request failed: ${response.status} ${await response.text()}`)
    }

    const data = (await response.json()) as {
      choices: { message: { content: string; reasoning_content?: string } }[]
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        completion_tokens_details?: { reasoning_tokens?: number }
      }
    }

    const endedAt = Date.now()
    callHistory.push({
      startedAt,
      endedAt,
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    })
    pruneHistory(endedAt)

    const msg = data.choices[0]!.message
    logLlmCall(timestamp, { model: resolvedModel, messages }, msg.content, msg.reasoning_content)

    return msg.content
  }

  function status() {
    const now = Date.now()
    pruneHistory(now)
    if (callHistory.length === 0) {
      return {
        busyPct: 0,
        reqPerMin: 0,
        tokPerSec: 0,
        reasoningTokPerSec: 0,
        windowMs: config.statusWindowMs,
      }
    }
    let totalDurationMs = 0
    let totalTokens = 0
    let totalReasoningTokens = 0
    for (const c of callHistory) {
      totalDurationMs += c.endedAt - c.startedAt
      totalTokens += c.promptTokens + c.completionTokens
      totalReasoningTokens += c.reasoningTokens
    }
    const windowMs = Math.min(now - callHistory[0].startedAt, config.statusWindowMs)
    const busyPct = windowMs > 0 ? Math.round((totalDurationMs / windowMs) * 100) : 0
    const reqPerMin = windowMs > 0 ? Math.round((callHistory.length / windowMs) * 60_000) : 0
    const tokPerSec = windowMs > 0 ? Math.round((totalTokens / windowMs) * 1000) : 0
    const reasoningTokPerSec =
      windowMs > 0 ? Math.round((totalReasoningTokens / windowMs) * 1000) : 0
    return { busyPct, reqPerMin, tokPerSec, reasoningTokPerSec, windowMs: config.statusWindowMs }
  }

  return { complete, maxContextTokens: resolvedMaxContextTokens, status }
}
