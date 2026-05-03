import { config } from '../config.js'
import { Singletons } from '../singletons.js'
import type { Embedder } from './provider.js'
import { TransformersEmbedder } from './transformers.js'

export type { Embedder } from './provider.js'
export { HashEmbedder } from './provider.js'
export { TransformersEmbedder } from './transformers.js'

const EMBEDDER_KEY = 'embedder'

export function getEmbedder(): Embedder {
  return Singletons.computeIfAbsent<Embedder>(
    EMBEDDER_KEY,
    () => new TransformersEmbedder(config.embedding.model, config.embedding.batchSize),
  )
}
