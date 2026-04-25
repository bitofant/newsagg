import { config } from './config.js'
import { getAi, OllamaProvider, VllmProvider } from './ai/index.js'

const TIMEOUT_MS = 30_000
const PROMPT = 'Reply with the single word "pong" and nothing else.'

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
    const info = await ai.fetchModelInfo(TIMEOUT_MS)
    console.log(`[llm-test] /v1/models returned in ${Date.now() - t0}ms:`, info)
  } else if (ai instanceof OllamaProvider) {
    console.log('[llm-test] fetching Ollama model list...')
    const t0 = Date.now()
    try {
      const models = await ai.listModels(TIMEOUT_MS)
      console.log(`[llm-test] /api/tags returned in ${Date.now() - t0}ms:`, models)
    } catch (err) {
      console.error(`[llm-test] /api/tags failed after ${Date.now() - t0}ms:`, err)
    }
  }

  console.log(`[llm-test] sending prompt with ${TIMEOUT_MS}ms timeout: ${JSON.stringify(PROMPT)}`)
  const t0 = Date.now()
  try {
    const out = await ai.complete(PROMPT, { timeoutMs: TIMEOUT_MS })
    const elapsed = Date.now() - t0
    console.log(`[llm-test] response in ${elapsed}ms:`)
    console.log('----- assistant content -----')
    console.log(out)
    console.log('----- status snapshot -----')
    console.log(ai.status())
    console.log('[llm-test] OK')
  } catch (err) {
    console.error(`[llm-test] FAILED after ${Date.now() - t0}ms:`, err)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('[llm-test] unhandled error:', err)
  process.exit(1)
})
