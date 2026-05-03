export interface Embedder {
  /** Compute embeddings for a batch of texts. Vectors are L2-normalized so dot product == cosine. */
  embed(texts: string[]): Promise<Float32Array[]>
  /** Stable identifier for the model + revision. Stored alongside each topic so model swaps trigger re-backfill. */
  readonly model: string
  /** Output dimensionality. Available after the first embed() call resolves; some impls block on init lazily. */
  readonly dim: number
}

/**
 * Deterministic hash-based mock for tests. Skips the ONNX download entirely; produces an L2-normalized
 * Float32Array per input that's stable across runs and uncorrelated for distinct texts. Two identical
 * inputs always yield identical vectors so `dot(a, a) === 1`.
 */
export class HashEmbedder implements Embedder {
  readonly model = 'mock:hash'
  constructor(public readonly dim: number = 384) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => hashToVector(t, this.dim))
  }
}

function hashToVector(text: string, dim: number): Float32Array {
  const out = new Float32Array(dim)
  for (let i = 0; i < dim; i++) {
    // FNV-1a per-lane with a unique seed so each lane is independent.
    let h = (0x811c9dc5 ^ i) >>> 0
    for (let j = 0; j < text.length; j++) {
      h = (h ^ text.charCodeAt(j)) >>> 0
      h = Math.imul(h, 0x01000193) >>> 0
    }
    out[i] = (h / 0xffffffff) * 2 - 1
  }
  let norm = 0
  for (let i = 0; i < dim; i++) norm += out[i] * out[i]
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < dim; i++) out[i] /= norm
  return out
}
