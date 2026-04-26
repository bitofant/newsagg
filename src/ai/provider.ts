import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AiConfig } from '../config.js'

export interface CompleteOptions {
  systemPrompt?: string
  /**
   * Reasoning effort.
   * - `'low' | 'medium' | 'high'`: sent as OpenAI-compatible `reasoning_effort`.
   * - `'off'`: sends `chat_template_kwargs: { enable_thinking: false }` (vLLM extension; the
   *   chat template — Qwen3's default or our custom one — disables the `<think>` block).
   * Omit to leave at the backend default.
   */
  reasoningEffort?: 'off' | 'low' | 'medium' | 'high'
  /** Per-call request timeout in ms. Falls back to `config.ai.requestTimeoutMs`. */
  timeoutMs?: number
  /** Diagnostic: when true, dumps the full raw chat-completion JSON response to console.log. Used by llm-test. */
  verbose?: boolean
}

export interface ProviderStatus {
  busyPct: number
  reqPerMin: number
  tokPerSec: number
  reasoningTokPerSec: number
  windowMs: number
}

interface ChatMessage {
  role: string
  content: string
}

interface ChatCompletionResponse {
  choices: {
    message: {
      content: string
      // vLLM reasoning parsers vary on field name: deepseek_r1 emits `reasoning_content`,
      // qwen3 (and some others) emit `reasoning`. Accept either.
      reasoning_content?: string
      reasoning?: string
    }
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    completion_tokens_details?: { reasoning_tokens?: number }
  }
}

interface CallRecord {
  startedAt: number
  endedAt: number
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
}

const LLM_LOG_DIR = './llm'

/** Hard cap on output tokens per chat-completion request. Exported so the consolidator can size prompts against it. */
export const MAX_OUTPUT_TOKENS = 4096

export abstract class InferenceProvider {
  protected resolvedModel: string
  protected resolvedMaxContextTokens: number
  protected readonly headers: Record<string, string>
  private callHistory: CallRecord[] = []
  private initPromise?: Promise<void>

  constructor(protected readonly config: AiConfig) {
    this.resolvedModel = typeof config.model === 'string' ? config.model : ''
    this.resolvedMaxContextTokens = typeof config.maxContextTokens === 'number' ? config.maxContextTokens : 0
    this.headers = {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    }
  }

  get maxContextTokens(): number {
    return this.resolvedMaxContextTokens
  }

  get model(): string {
    return this.resolvedModel
  }

  /** One-shot lazy init. Subclasses provide `doInit()`. */
  async ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit().catch((err) => {
        // Reset so a later call can retry
        this.initPromise = undefined
        throw err
      })
    }
    return this.initPromise
  }

  protected abstract doInit(): Promise<void>

  async complete(prompt: string, opts?: CompleteOptions): Promise<string> {
    await this.ensureInitialized()

    const messages: ChatMessage[] = []
    if (opts?.systemPrompt) messages.push({ role: 'system', content: opts.systemPrompt })
    messages.push({ role: 'user', content: prompt })

    const body: Record<string, unknown> = {
      model: this.resolvedModel,
      messages,
      max_tokens: MAX_OUTPUT_TOKENS,
    }
    if (opts?.reasoningEffort === 'off') {
      body['chat_template_kwargs'] = { enable_thinking: false }
    } else if (opts?.reasoningEffort) {
      body['reasoning_effort'] = opts.reasoningEffort
    }

    const timestamp = Math.floor(Date.now() / 1000)
    const startedAt = Date.now()
    const timeoutMs = opts?.timeoutMs ?? this.config.requestTimeoutMs

    const data = await this.fetchChatCompletion(body, timeoutMs)
    const endedAt = Date.now()

    if (opts?.verbose) {
      console.log('[ai] raw chat-completion response:')
      console.log(JSON.stringify(data, null, 2))
    }

    const msg = data.choices[0]!.message
    const reasoning = msg.reasoning_content ?? msg.reasoning
    // vLLM with the qwen3 parser does NOT break out reasoning_tokens in usage — it lumps them
    // into completion_tokens. Estimate from reasoning text length (~4 chars/token) as a fallback
    // so the rolling-window metric reflects reality on those backends.
    const reportedReasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens ?? 0
    const reasoningTokens = reportedReasoningTokens > 0
      ? reportedReasoningTokens
      : reasoning
        ? Math.ceil(reasoning.length / 4)
        : 0

    this.callHistory.push({
      startedAt,
      endedAt,
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      reasoningTokens,
    })
    this.pruneHistory(endedAt)

    logLlmCall(timestamp, { model: this.resolvedModel, messages }, msg.content, reasoning)
    return msg.content
  }

  status(): ProviderStatus {
    const now = Date.now()
    this.pruneHistory(now)
    if (this.callHistory.length === 0) {
      return { busyPct: 0, reqPerMin: 0, tokPerSec: 0, reasoningTokPerSec: 0, windowMs: this.config.statusWindowMs }
    }
    let totalDurationMs = 0
    let totalTokens = 0
    let totalReasoningTokens = 0
    for (const c of this.callHistory) {
      totalDurationMs += c.endedAt - c.startedAt
      totalTokens += c.promptTokens + c.completionTokens
      totalReasoningTokens += c.reasoningTokens
    }
    const windowMs = Math.min(now - this.callHistory[0].startedAt, this.config.statusWindowMs)
    const busyPct = windowMs > 0 ? Math.round((totalDurationMs / windowMs) * 100) : 0
    const reqPerMin = windowMs > 0 ? Math.round((this.callHistory.length / windowMs) * 60_000) : 0
    const tokPerSec = windowMs > 0 ? Math.round((totalTokens / windowMs) * 1000) : 0
    const reasoningTokPerSec = windowMs > 0 ? Math.round((totalReasoningTokens / windowMs) * 1000) : 0
    return { busyPct, reqPerMin, tokPerSec, reasoningTokPerSec, windowMs: this.config.statusWindowMs }
  }

  /** Backend-overridable: HTTP POST to /chat/completions with timeout. */
  protected async fetchChatCompletion(body: Record<string, unknown>, timeoutMs: number): Promise<ChatCompletionResponse> {
    const response = await fetchWithTimeout(
      `${this.config.url}/chat/completions`,
      { method: 'POST', headers: this.headers, body: JSON.stringify(body) },
      timeoutMs,
    )
    if (!response.ok) {
      throw new Error(`AI request failed: ${response.status} ${await response.text()}`)
    }
    return (await response.json()) as ChatCompletionResponse
  }

  private pruneHistory(now: number) {
    const cutoff = now - this.config.statusWindowMs
    while (this.callHistory.length > 0 && this.callHistory[0].endedAt < cutoff) {
      this.callHistory.shift()
    }
  }
}

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function logLlmCall(
  timestamp: number,
  req: { model: string; messages: ChatMessage[] },
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
    if (reasoning) await writeFile(`${base}.think`, reasoning)
  }

  work().catch((err) => console.error('[ai] llm log write failed:', err))
}
