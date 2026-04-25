import { InferenceProvider, fetchWithTimeout } from './provider.js'

interface ModelInfo {
  id: string
  max_model_len?: number
}

export class VllmProvider extends InferenceProvider {
  protected async doInit(): Promise<void> {
    const needsLookup = this.config.model === 'auto' || this.config.maxContextTokens === 'auto'

    if (needsLookup) {
      const info = await this.fetchModelInfo()
      if (this.config.model === 'auto') {
        this.resolvedModel = info.id
        console.log(`[ai] auto-detected model: ${this.resolvedModel}`)
      } else {
        this.resolvedModel = this.config.model
      }
      if (this.config.maxContextTokens === 'auto') {
        if (info.max_model_len == null) {
          throw new Error(
            `[ai] maxContextTokens is "auto" but /v1/models did not return max_model_len for "${this.resolvedModel}". Set it explicitly in config.json.`,
          )
        }
        this.resolvedMaxContextTokens = info.max_model_len
        console.log(`[ai] auto-detected maxContextTokens: ${this.resolvedMaxContextTokens}`)
      } else {
        this.resolvedMaxContextTokens = this.config.maxContextTokens
      }
    } else {
      this.resolvedModel = this.config.model
      this.resolvedMaxContextTokens = this.config.maxContextTokens as number
    }
  }

  /** Fetch the first model entry from vLLM's /v1/models endpoint. */
  async fetchModelInfo(timeoutMs = 10_000): Promise<ModelInfo> {
    const res = await fetchWithTimeout(`${this.config.url}/models`, { headers: this.headers }, timeoutMs)
    if (!res.ok) throw new Error(`[ai] GET /models failed: ${res.status} ${await res.text()}`)
    const body = (await res.json()) as { data: ModelInfo[] }
    const first = body.data[0]
    if (!first) throw new Error('[ai] /v1/models returned an empty list')
    return first
  }
}
