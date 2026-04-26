import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { getAi, OllamaProvider, VllmProvider, type CompleteOptions, type InferenceProvider } from './ai/index.js'

// Substantive prompt that should reliably trigger reasoning on a thinking-capable model
// (trivial prompts like "say pong" can cause the model to skip reasoning even at high effort).
const PROMPT =
  'If today is Wednesday, what day of the week will it be 100 days from now? Show your work step by step.'
const LLM_LOG_DIR = './llm'

function formatDay(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

function snapshotDir(dayDir: string): Set<string> {
  return existsSync(dayDir) ? new Set(readdirSync(dayDir)) : new Set<string>()
}

interface TestResult {
  durationMs: number
  responseChars: number
  reasoningChars: number
  reasoningTokensEst: number
  failed?: boolean
}

async function runTest(label: string, ai: InferenceProvider, opts: CompleteOptions): Promise<TestResult> {
  const dayDir = path.join(LLM_LOG_DIR, formatDay(new Date()))
  const before = snapshotDir(dayDir)

  console.log(`\n[llm-test] ===== ${label} =====`)
  console.log('[llm-test] opts:', JSON.stringify(opts))

  const t0 = Date.now()
  let out: string
  try {
    out = await ai.complete(PROMPT, opts)
    console.log(`[llm-test] response in ${Date.now() - t0}ms`)
    console.log('----- assistant content -----')
    console.log(out)
  } catch (err) {
    console.error(`[llm-test] FAILED after ${Date.now() - t0}ms:`, err)
    return { durationMs: Date.now() - t0, responseChars: 0, reasoningChars: 0, reasoningTokensEst: 0, failed: true }
  }
  const durationMs = Date.now() - t0

  // Logging is fire-and-forget — give it a moment to flush.
  await new Promise((r) => setTimeout(r, 200))

  console.log('----- reasoning content (.think file) -----')
  const after = existsSync(dayDir) ? readdirSync(dayDir) : []
  const newThinks = after.filter((f) => f.endsWith('.think') && !before.has(f))
  let reasoningText = ''
  if (newThinks.length === 0) {
    console.log('(no .think file written — model produced no reasoning tokens)')
  } else {
    for (const f of newThinks) {
      const full = path.join(dayDir, f)
      console.log(`[from ${full}]`)
      const content = readFileSync(full, 'utf-8')
      console.log(content)
      reasoningText += content
    }
  }

  return {
    durationMs,
    responseChars: out.length,
    reasoningChars: reasoningText.length,
    reasoningTokensEst: Math.ceil(reasoningText.length / 4),
  }
}

async function main() {
  console.log('[llm-test] config.ai.backend:', config.ai.backend)
  console.log('[llm-test] config.ai.url:', config.ai.url)
  console.log('[llm-test] config.ai.model:', config.ai.model)
  console.log('[llm-test] config.ai.maxContextTokens:', config.ai.maxContextTokens)
  console.log('[llm-test] config.ai.requestTimeoutMs:', config.ai.requestTimeoutMs)
  console.log('[llm-test] config.ai.apiKey set:', !!config.ai.apiKey)

  const ai = getAi()
  console.log('[llm-test] provider class:', ai.constructor.name)

  if (ai instanceof VllmProvider) {
    console.log('[llm-test] fetching vLLM model info...')
    const t0 = Date.now()
    const info = await ai.fetchModelInfo(30_000)
    console.log(`[llm-test] /v1/models returned in ${Date.now() - t0}ms:`, info)
  } else if (ai instanceof OllamaProvider) {
    console.log('[llm-test] fetching Ollama model list...')
    const t0 = Date.now()
    try {
      const models = await ai.listModels(30_000)
      console.log(`[llm-test] /api/tags returned in ${Date.now() - t0}ms:`, models)
    } catch (err) {
      console.error(`[llm-test] /api/tags failed after ${Date.now() - t0}ms:`, err)
    }
  }

  const off = await runTest('Reasoning OFF', ai, { reasoningEffort: 'off', timeoutMs: 60_000, verbose: true })
  const high = await runTest('Reasoning HIGH', ai, { reasoningEffort: 'high', timeoutMs: 180_000, verbose: true })

  console.log('\n[llm-test] ----- final status snapshot -----')
  console.log(ai.status())

  console.log('\n[llm-test] ----- comparison -----')
  console.table({
    'Response chars':       { OFF: off.responseChars, HIGH: high.responseChars },
    'Reasoning chars':      { OFF: off.reasoningChars, HIGH: high.reasoningChars },
    'Reasoning tokens (~)': { OFF: off.reasoningTokensEst, HIGH: high.reasoningTokensEst },
    'Time (s)':             { OFF: Number((off.durationMs / 1000).toFixed(1)), HIGH: Number((high.durationMs / 1000).toFixed(1)) },
  })

  const machineSummary = {
    backend: config.ai.backend,
    model: ai.model,
    prompt: PROMPT,
    results: { off, high },
  }
  console.log('\n[llm-test] ----- summary JSON -----')
  console.log(JSON.stringify(machineSummary))

  console.log('[llm-test] DONE')
}

main().catch((err) => {
  console.error('[llm-test] unhandled error:', err)
  process.exit(1)
})
