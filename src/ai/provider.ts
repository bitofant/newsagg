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
  /**
   * Per-call output cap. vLLM uses `max_tokens` to reserve a scheduling slot per request, so a tight
   * cap (matched to the actual JSON-output size for a given call site) lets vLLM batch more concurrent
   * requests. Defaults to `MAX_OUTPUT_TOKENS` (off) or `MAX_OUTPUT_TOKENS_REASONING` (reasoning on).
   */
  maxTokens?: number
  /** Per-call request timeout in ms. Falls back to `config.ai.requestTimeoutMs`. */
  timeoutMs?: number
  /** Diagnostic: when true, dumps the full raw chat-completion JSON response to console.log. Used by llm-test. */
  verbose?: boolean
  /**
   * Scheduling priority for the global concurrency gate. `'low'` yields completely to `'normal'`
   * (may starve under sustained normal load — intentional). Default `'normal'`.
   */
  priority?: 'low' | 'normal'
}

export interface ProviderStatus {
  busyPct: number
  reqPerMin: number
  tokPerSec: number
  reasoningTokPerSec: number
  /** Share of prompt tokens served from vLLM's prefix cache over the rolling window, as a 0-100 percent. */
  cacheHitPct: number
  windowMs: number
  /** Currently dispatched LLM requests (acquired a permit, awaiting response). */
  inFlight: number
  /** Normal-priority requests waiting for a permit. */
  queueDepthNormal: number
  /** Low-priority requests waiting for a permit (drained only when normal queue empty). */
  queueDepthLow: number
  /** Configured cap on in-flight requests (`config.ai.maxConcurrency`). */
  maxConcurrency: number
  /** False while the health probe is failing — `complete()` calls block at the gate until probe recovers. */
  healthy: boolean
  /** Last unhealthiness reason (human-readable error summary). Cleared once health is restored. */
  unhealthyReason: string | null
  /** Unix-ms timestamp of when the current outage started. Null when healthy. */
  unhealthySince: number | null
}

interface ChatMessage {
  role: string
  content: string
}

interface ChatCompletionUsage {
  prompt_tokens?: number
  completion_tokens?: number
  completion_tokens_details?: { reasoning_tokens?: number }
  // vLLM (with --enable-prefix-caching) reports cached prompt tokens here, mirroring the OpenAI shape.
  prompt_tokens_details?: { cached_tokens?: number }
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
  usage?: ChatCompletionUsage
}

interface ChatCompletionStreamChunk {
  choices?: {
    delta?: {
      content?: string
      reasoning_content?: string
      reasoning?: string
    }
  }[]
  usage?: ChatCompletionUsage
}

export interface StreamCallbacks {
  onReasoning?: (delta: string) => void
  onContent?: (delta: string) => void
}

interface CallRecord {
  startedAt: number
  endedAt: number
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  cachedTokens: number
}

const LLM_LOG_DIR = './llm'

/** Per-process monotonic counter so concurrent calls in the same second get unique filenames. */
let logCallSeq = 0

/** Hard cap on output tokens per chat-completion request when reasoning is OFF. Exported so the consolidator can size prompts against it. */
export const MAX_OUTPUT_TOKENS = 4096
/** Hard cap on output tokens when reasoning is ENABLED — reasoning tokens count against this budget on vLLM (qwen3 parser), so we double it. */
export const MAX_OUTPUT_TOKENS_REASONING = 8192

/** Interval between probe attempts while the LLM is unhealthy. */
const HEALTH_PROBE_INTERVAL_MS = 5_000
/** Timeout for one health-probe HTTP request. Kept short so a hung backend trips fast. */
const HEALTH_PROBE_TIMEOUT_MS = 5_000

/**
 * Process-wide concurrency gate with two priorities. Normal queue is fully drained before low queue —
 * intentional starvation of low under sustained normal load (see docs/ai.md).
 */
class PriorityGate {
  private inFlight = 0
  private readonly normal: Array<() => void> = []
  private readonly low: Array<() => void> = []
  constructor(private readonly limit: number) {}

  acquire(priority: 'low' | 'normal'): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = () => {
        this.inFlight++
        let released = false
        resolve(() => {
          if (released) return
          released = true
          this.inFlight--
          this.drain()
        })
      }
      if (this.inFlight < this.limit) grant()
      else (priority === 'low' ? this.low : this.normal).push(grant)
    })
  }

  private drain() {
    while (this.inFlight < this.limit) {
      const next = this.normal.shift() ?? this.low.shift()
      if (!next) return
      next()
    }
  }

  stats() {
    return { inFlight: this.inFlight, queueDepthNormal: this.normal.length, queueDepthLow: this.low.length }
  }
}

function maxOutputFor(opts?: CompleteOptions): number {
  const reasoning = !!opts?.reasoningEffort && opts.reasoningEffort !== 'off'
  const defaultCap = reasoning ? MAX_OUTPUT_TOKENS_REASONING : MAX_OUTPUT_TOKENS
  const requested = opts?.maxTokens && opts.maxTokens > 0 ? opts.maxTokens : defaultCap
  // Reasoning tokens count against the same output budget on vLLM's qwen3 parser, so a tight
  // per-site cap could starve the <think> block and produce truncated/empty responses. Floor to
  // MAX_OUTPUT_TOKENS_REASONING whenever reasoning is on, regardless of what the caller passed.
  return reasoning ? Math.max(requested, MAX_OUTPUT_TOKENS_REASONING) : requested
}

export abstract class InferenceProvider {
  protected resolvedModel: string
  protected resolvedMaxContextTokens: number
  protected readonly headers: Record<string, string>
  private readonly gate: PriorityGate
  private callHistory: CallRecord[] = []
  private initPromise?: Promise<void>
  private healthy = true
  private unhealthyReason: string | null = null
  private unhealthySince: number | null = null
  private healthWaiters: Array<() => void> = []
  private healthProbeTimer: ReturnType<typeof setTimeout> | null = null

  constructor(protected readonly config: AiConfig) {
    this.resolvedModel = typeof config.model === 'string' ? config.model : ''
    this.resolvedMaxContextTokens = typeof config.maxContextTokens === 'number' ? config.maxContextTokens : 0
    this.headers = {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    }
    this.gate = new PriorityGate(config.maxConcurrency)
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

  /** Backend-specific cheap health check: vLLM `/health`, Ollama base `/`. Returns true if alive. */
  protected abstract probeHealth(timeoutMs: number): Promise<boolean>

  /** Block until the health flag flips back to true. Returns immediately if already healthy. */
  private awaitHealthy(): Promise<void> {
    if (this.healthy) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.healthWaiters.push(resolve)
    })
  }

  /**
   * Flip to unhealthy and start (idempotently) the probe loop. Calls already past `awaitHealthy()`
   * keep their permits but their retry-loop body re-enters `awaitHealthy()` after this returns.
   * New calls block at the gate-front `awaitHealthy()` and wait without holding permits.
   */
  private markUnhealthy(reason: string): void {
    if (!this.healthy) return
    this.healthy = false
    this.unhealthyReason = reason
    this.unhealthySince = Date.now()
    console.warn(`[ai] LLM unhealthy: ${reason} — pausing dispatch and probing every ${HEALTH_PROBE_INTERVAL_MS}ms`)
    this.scheduleProbe()
  }

  private scheduleProbe(): void {
    if (this.healthProbeTimer) return
    const tick = async () => {
      this.healthProbeTimer = null
      let alive = false
      try {
        alive = await this.probeHealth(HEALTH_PROBE_TIMEOUT_MS)
      } catch {
        alive = false
      }
      if (alive) {
        const downtimeMs = this.unhealthySince != null ? Date.now() - this.unhealthySince : 0
        console.log(`[ai] LLM healthy again after ${(downtimeMs / 1000).toFixed(1)}s`)
        this.healthy = true
        this.unhealthyReason = null
        this.unhealthySince = null
        const waiters = this.healthWaiters
        this.healthWaiters = []
        for (const w of waiters) w()
        return
      }
      this.healthProbeTimer = setTimeout(tick, HEALTH_PROBE_INTERVAL_MS)
    }
    // First probe runs after one interval so a transient blip isn't mistaken for recovery.
    this.healthProbeTimer = setTimeout(tick, HEALTH_PROBE_INTERVAL_MS)
  }

  /**
   * Classify a thrown error as a transient backend-availability problem (retry after probe) vs.
   * a real client error (propagate). Network errors, AbortError (timeout), and 5xx/503 responses
   * are retryable; other failures (4xx, JSON parse, etc.) are not.
   */
  private isRetryableError(err: unknown): boolean {
    if (!(err instanceof Error)) return false
    if (err.name === 'AbortError') return true
    // node fetch wraps low-level connection errors in TypeError with a `cause`.
    if (err.name === 'TypeError') return true
    const msg = err.message
    // `fetchChatCompletion` formats non-OK responses as "AI request failed: <status> ...".
    if (/^AI request failed: 5\d\d/.test(msg)) return true
    if (/^AI request failed: 408 /.test(msg)) return true
    if (/^AI request failed: 429 /.test(msg)) return true
    if (/timeout/i.test(msg)) return true
    return false
  }

  private errSummary(err: unknown): string {
    if (err instanceof Error) return `${err.name}: ${err.message}`
    return String(err)
  }

  async complete(prompt: string, opts?: CompleteOptions): Promise<string> {
    // Retry-on-transient-failure loop. Pause inside `awaitHealthy()` (no permit held) when the
    // probe loop has flagged the backend as down. Init is also retryable — a process started while
    // the LLM is still booting will keep retrying init via this loop rather than hard-failing.
    while (true) {
      try {
        await this.ensureInitialized()
      } catch (err) {
        if (this.isRetryableError(err)) {
          this.markUnhealthy(`init: ${this.errSummary(err)}`)
          await this.awaitHealthy()
          continue
        }
        throw err
      }
      await this.awaitHealthy()

      const messages: ChatMessage[] = []
      if (opts?.systemPrompt) messages.push({ role: 'system', content: opts.systemPrompt })
      messages.push({ role: 'user', content: prompt })

      const body: Record<string, unknown> = {
        model: this.resolvedModel,
        messages,
        max_tokens: maxOutputFor(opts),
      }
      if (opts?.reasoningEffort === 'off') {
        body['chat_template_kwargs'] = { enable_thinking: false }
      } else if (opts?.reasoningEffort) {
        body['reasoning_effort'] = opts.reasoningEffort
      }

      // Acquire AFTER ensureInitialized + awaitHealthy + body assembly so the timeout (started
      // inside fetchChatCompletion) does not tick during queue wait — a low-priority call that
      // waits 10 minutes behind normal traffic must not spuriously time out before dispatch.
      const release = await this.gate.acquire(opts?.priority ?? 'normal')
      let releaseCalled = false
      try {
        const timestamp = Math.floor(Date.now() / 1000)
        const seq = logCallSeq++
        const startedAt = Date.now()
        const timeoutMs = opts?.timeoutMs ?? this.config.requestTimeoutMs

        let data: ChatCompletionResponse
        try {
          data = await this.fetchChatCompletion(body, timeoutMs)
        } catch (err) {
          if (this.isRetryableError(err)) {
            this.markUnhealthy(`complete: ${this.errSummary(err)}`)
            release()
            releaseCalled = true
            await this.awaitHealthy()
            continue
          }
          throw err
        }
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
          cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        })
        this.pruneHistory(endedAt)

        logLlmCall(timestamp, seq, { model: this.resolvedModel, messages }, msg.content, reasoning)
        return msg.content
      } finally {
        if (!releaseCalled) release()
      }
    }
  }

  /**
   * Streaming counterpart of `complete()`. Same lifecycle (init → gate → fetch → release), same
   * metrics, same llm/ logs (written at the end). Dispatches incremental reasoning/content deltas
   * via callbacks; returns the full accumulated content string.
   */
  async completeStream(prompt: string, opts: CompleteOptions | undefined, callbacks: StreamCallbacks): Promise<string> {
    // Streaming is only used for user-driven manual regen, where partial progress on a connection
    // failure is awkward to expose mid-stream. The retry loop wraps the whole stream attempt; a
    // failed connection restarts from scratch (callbacks see the new stream's deltas, not the old).
    while (true) {
      try {
        await this.ensureInitialized()
      } catch (err) {
        if (this.isRetryableError(err)) {
          this.markUnhealthy(`init: ${this.errSummary(err)}`)
          await this.awaitHealthy()
          continue
        }
        throw err
      }
      await this.awaitHealthy()

      const messages: ChatMessage[] = []
      if (opts?.systemPrompt) messages.push({ role: 'system', content: opts.systemPrompt })
      messages.push({ role: 'user', content: prompt })

      const body: Record<string, unknown> = {
        model: this.resolvedModel,
        messages,
        max_tokens: maxOutputFor(opts),
        stream: true,
        stream_options: { include_usage: true },
      }
      if (opts?.reasoningEffort === 'off') {
        body['chat_template_kwargs'] = { enable_thinking: false }
      } else if (opts?.reasoningEffort) {
        body['reasoning_effort'] = opts.reasoningEffort
      }

      const release = await this.gate.acquire(opts?.priority ?? 'normal')
      let releaseCalled = false
      try {
        const timestamp = Math.floor(Date.now() / 1000)
        const seq = logCallSeq++
        const startedAt = Date.now()
        const timeoutMs = opts?.timeoutMs ?? this.config.requestTimeoutMs

        let content = ''
        let reasoning = ''
        let usage: ChatCompletionUsage | undefined
        try {
          await this.streamChatCompletion(body, timeoutMs, (chunk) => {
            const delta = chunk.choices?.[0]?.delta
            if (delta) {
              if (delta.content) {
                content += delta.content
                callbacks.onContent?.(delta.content)
              }
              const reasoningDelta = delta.reasoning_content ?? delta.reasoning
              if (reasoningDelta) {
                reasoning += reasoningDelta
                callbacks.onReasoning?.(reasoningDelta)
              }
            }
            if (chunk.usage) usage = chunk.usage
          })
        } catch (err) {
          if (this.isRetryableError(err)) {
            this.markUnhealthy(`completeStream: ${this.errSummary(err)}`)
            release()
            releaseCalled = true
            await this.awaitHealthy()
            continue
          }
          throw err
        }
        const endedAt = Date.now()

        const reportedReasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? 0
        const reasoningTokens = reportedReasoningTokens > 0
          ? reportedReasoningTokens
          : reasoning
            ? Math.ceil(reasoning.length / 4)
            : 0

        this.callHistory.push({
          startedAt,
          endedAt,
          promptTokens: usage?.prompt_tokens ?? 0,
          completionTokens: usage?.completion_tokens ?? 0,
          reasoningTokens,
          cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
        })
        this.pruneHistory(endedAt)

        logLlmCall(timestamp, seq, { model: this.resolvedModel, messages }, content, reasoning || undefined)
        return content
      } finally {
        if (!releaseCalled) release()
      }
    }
  }

  status(): ProviderStatus {
    const now = Date.now()
    this.pruneHistory(now)
    const gateStats = this.gate.stats()
    const maxConcurrency = this.config.maxConcurrency
    const healthFields = {
      healthy: this.healthy,
      unhealthyReason: this.unhealthyReason,
      unhealthySince: this.unhealthySince,
    }
    if (this.callHistory.length === 0) {
      return {
        busyPct: 0, reqPerMin: 0, tokPerSec: 0, reasoningTokPerSec: 0, cacheHitPct: 0,
        windowMs: this.config.statusWindowMs,
        ...gateStats, maxConcurrency,
        ...healthFields,
      }
    }
    let totalDurationMs = 0
    let totalTokens = 0
    let totalReasoningTokens = 0
    let totalPromptTokens = 0
    let totalCachedTokens = 0
    for (const c of this.callHistory) {
      totalDurationMs += c.endedAt - c.startedAt
      totalTokens += c.promptTokens + c.completionTokens
      totalReasoningTokens += c.reasoningTokens
      totalPromptTokens += c.promptTokens
      totalCachedTokens += c.cachedTokens
    }
    const windowMs = Math.min(now - this.callHistory[0].startedAt, this.config.statusWindowMs)
    const busyPct = windowMs > 0 ? Math.round((totalDurationMs / windowMs) * 100) : 0
    const reqPerMin = windowMs > 0 ? Math.round((this.callHistory.length / windowMs) * 60_000) : 0
    const tokPerSec = windowMs > 0 ? Math.round((totalTokens / windowMs) * 1000) : 0
    const reasoningTokPerSec = windowMs > 0 ? Math.round((totalReasoningTokens / windowMs) * 1000) : 0
    const cacheHitPct = totalPromptTokens > 0 ? Math.round((totalCachedTokens / totalPromptTokens) * 100) : 0
    return {
      busyPct, reqPerMin, tokPerSec, reasoningTokPerSec, cacheHitPct,
      windowMs: this.config.statusWindowMs,
      ...gateStats, maxConcurrency,
      ...healthFields,
    }
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

  /** Streaming POST to /chat/completions. Parses `data: {...}\n\n` SSE frames and dispatches each chunk. */
  protected async streamChatCompletion(
    body: Record<string, unknown>,
    timeoutMs: number,
    onChunk: (chunk: ChatCompletionStreamChunk) => void,
  ): Promise<void> {
    const response = await fetchWithTimeout(
      `${this.config.url}/chat/completions`,
      { method: 'POST', headers: this.headers, body: JSON.stringify(body) },
      timeoutMs,
    )
    if (!response.ok) {
      throw new Error(`AI request failed: ${response.status} ${await response.text()}`)
    }
    if (!response.body) throw new Error('AI streaming response had no body')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE frames are separated by a blank line.
      let sep
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          try {
            onChunk(JSON.parse(payload) as ChatCompletionStreamChunk)
          } catch {
            // ignore malformed frame
          }
        }
      }
    }
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
  seq: number,
  req: { model: string; messages: ChatMessage[] },
  content: string,
  reasoning?: string,
): void {
  const date = new Date(timestamp * 1000)
  const day = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
  const dir = join(LLM_LOG_DIR, day)
  const base = join(dir, `${timestamp}_${seq}`)

  const work = async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(`${base}.req`, JSON.stringify(req, null, 2))
    await writeFile(`${base}.res`, content)
    if (reasoning) await writeFile(`${base}.think`, reasoning)
  }

  work().catch((err) => console.error('[ai] llm log write failed:', err))
}
