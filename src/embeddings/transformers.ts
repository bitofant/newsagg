import type { Embedder } from './provider.js'

/**
 * CPU embedder backed by `@huggingface/transformers` + `onnxruntime-node`. Loads a quantized ONNX
 * model from the HF hub on first use (cached in `~/.cache/huggingface/transformers`); subsequent runs
 * are offline. Outputs are mean-pooled and L2-normalized, so callers can use plain dot product as cosine.
 *
 * The package + native binaries aren't loaded until `embed()` is first called, mirroring
 * `InferenceProvider.ensureInitialized()` — this keeps process startup snappy and lets tests using
 * `HashEmbedder` (via `Singletons.set('embedder', mock)`) skip the ONNX download entirely.
 */
export class TransformersEmbedder implements Embedder {
  private extractor: ((input: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>) | null = null
  private initPromise: Promise<void> | null = null
  private resolvedDim = 0

  constructor(public readonly model: string, private readonly batchSize: number) {}

  get dim(): number {
    return this.resolvedDim
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit().catch((err) => {
        this.initPromise = null
        throw err
      })
    }
    return this.initPromise
  }

  private async doInit(): Promise<void> {
    console.log(`[embed] loading model ${this.model}...`)
    const t0 = Date.now()
    // Dynamic import keeps the dependency optional at type-check time and defers native binary load.
    const transformers = (await import('@huggingface/transformers' as string)) as {
      pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<unknown>
    }
    const extractor = (await transformers.pipeline('feature-extraction', this.model, { dtype: 'q8' })) as (
      input: string[],
      opts: { pooling: 'mean'; normalize: boolean },
    ) => Promise<{ data: Float32Array; dims: number[] }>
    // Probe to resolve dim without leaving extractor in an undefined state.
    const probe = await extractor(['probe'], { pooling: 'mean', normalize: true })
    this.resolvedDim = probe.dims[probe.dims.length - 1]!
    this.extractor = extractor
    console.log(`[embed] loaded ${this.model} (dim=${this.resolvedDim}) in ${Date.now() - t0}ms`)
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    await this.ensureInitialized()
    if (!this.extractor) throw new Error('[embed] extractor not initialized')

    const out: Float32Array[] = []
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const chunk = texts.slice(i, i + this.batchSize)
      const tensor = await this.extractor(chunk, { pooling: 'mean', normalize: true })
      const flat = tensor.data
      const dim = tensor.dims[tensor.dims.length - 1]!
      for (let j = 0; j < chunk.length; j++) {
        // .slice() copies, so each output owns its bytes independently of the shared tensor buffer.
        out.push(flat.slice(j * dim, (j + 1) * dim))
      }
    }
    return out
  }
}
