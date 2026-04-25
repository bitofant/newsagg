import { InferenceProvider, fetchWithTimeout } from './provider.js'

export class OllamaProvider extends InferenceProvider {
  protected async doInit(): Promise<void> {
    if (this.config.model === 'auto' || this.config.maxContextTokens === 'auto') {
      throw new Error(
        '[ai] Ollama does not expose max_model_len via /v1/models — set ai.model and ai.maxContextTokens explicitly in config.json',
      )
    }
    this.resolvedModel = this.config.model
    this.resolvedMaxContextTokens = this.config.maxContextTokens
  }

  /** List local Ollama models via /api/tags (Ollama-specific, not OpenAI-compatible). */
  async listModels(timeoutMs = 10_000): Promise<string[]> {
    const baseUrl = this.config.url.replace(/\/v1\/?$/, '')
    const res = await fetchWithTimeout(`${baseUrl}/api/tags`, { headers: this.headers }, timeoutMs)
    if (!res.ok) throw new Error(`[ai] /api/tags failed: ${res.status} ${await res.text()}`)
    const body = (await res.json()) as { models?: { name: string }[] }
    return (body.models ?? []).map((m) => m.name)
  }

  /** Quick health check: GET / on the base host. */
  async ping(timeoutMs = 5_000): Promise<boolean> {
    const baseUrl = this.config.url.replace(/\/v1\/?$/, '')
    try {
      const res = await fetchWithTimeout(baseUrl, { headers: this.headers }, timeoutMs)
      return res.ok
    } catch {
      return false
    }
  }
}
