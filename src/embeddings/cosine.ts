/** Cosine similarity for L2-normalized vectors. The embedder normalizes outputs so dot product == cosine. */
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!
  return s
}
