import { config } from '../config.js'
import { Singletons } from '../singletons.js'
import { InferenceProvider } from './provider.js'
import { OllamaProvider } from './ollama.js'
import { VllmProvider } from './vllm.js'

export { InferenceProvider } from './provider.js'
export { OllamaProvider } from './ollama.js'
export { VllmProvider } from './vllm.js'
export type { CompleteOptions, ProviderStatus } from './provider.js'

const AI_KEY = 'ai'

export function getAi(): InferenceProvider {
  return Singletons.computeIfAbsent<InferenceProvider>(AI_KEY, () => {
    switch (config.ai.backend) {
      case 'ollama':
        return new OllamaProvider(config.ai)
      case 'vllm':
        return new VllmProvider(config.ai)
      default: {
        const exhaustive: never = config.ai.backend
        throw new Error(`[ai] unknown backend: ${exhaustive}`)
      }
    }
  })
}
