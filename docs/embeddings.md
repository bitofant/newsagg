# Embeddings module (`src/embeddings/`)

CPU-side text embedder used by the consolidator to pre-filter candidate topics before LLM matching. Replaces the previous "page through every topic 50 at a time" loop with a single small candidate set per article batch, ~100× fewer LLM input tokens per drain.

## Provider abstraction

- `Embedder` interface in `src/embeddings/provider.ts`: `embed(texts: string[]) → Promise<Float32Array[]>`, plus readonly `model` and `dim`. All vectors are L2-normalized so callers use plain dot product as cosine.
- `TransformersEmbedder` (`src/embeddings/transformers.ts`) — production impl using `@huggingface/transformers` v3 + `onnxruntime-node`. Loads a quantized ONNX model from the Hugging Face hub on first `embed()` call (cached locally in `~/.cache/huggingface/transformers`); subsequent runs are offline.
- `HashEmbedder` (also in `provider.ts`) — deterministic mock for tests. Skips the ONNX download entirely. Two identical strings yield identical vectors so `dot(a, a) === 1`; distinct strings yield uncorrelated vectors.
- Lazy singleton via `Singletons.computeIfAbsent('embedder', factory)` (`src/singletons.ts`) — same pattern as `getAi()`. Tests pre-populate via `Singletons.set('embedder', new HashEmbedder())` before any production code reaches `getEmbedder()`.

## Config (`config.embedding`)

- `model` (string): Hugging Face model id. Default `Xenova/all-MiniLM-L6-v2` (384-dim, ~23 MB quantized). Stored alongside each topic embedding so a model swap silently auto-triggers a full re-backfill on next startup.
- `batchSize` (number): max items per `embed()` ONNX call. Default 32. Bigger = better throughput, more peak RAM.
- `candidateThreshold` (number): cosine cutoff for keeping a topic in an article's candidate set. Default 0.35. Tuned empirically; raise to be stricter, lower to widen.
- `candidateMinK` (number): if fewer than this many topics clear the threshold for a given article, take the top-N by score regardless. Safety net for novel-story articles. Default 5.
- `candidateMaxK` (number): cap on per-article candidates after threshold filtering. Prevents prompt blow-up when an article is broadly similar to many topics. Default 20.

## How the consolidator uses it

- **At every `createTopic`**: the new topic is embedded immediately so the very next batch can find it as a candidate. Multi-topic create paths (drain phase 5, unmerge) batch the embeds into one ONNX call.
- **At every summary regen**: the embed is refreshed via `regenerateAndEmbed` (drain phase 4, drain background-regen path, ungroupArticle, mergeTopic via `enqueueRegen`). The canonical embed text is `title + ". " + description + ". " + summary + ". " + bullets.join(". ")`; including summary/bullets means the embedding tracks the topic's current state, not its origin description.
- **In `processBatch`**: pre-filter each article in the batch, union per-article candidates, sort by topic id ASC for partial vLLM prefix-cache reuse, hand to one `matchBatchAgainstTopics` call.
- **In `ungroupArticle`**: same pre-filter, excluding the source topic id.
- **At `consolidator.start()`**: `backfillEmbeddings()` kicks off in the background, paging through topics whose stored `embedding_model` doesn't match `config.embedding.model`. The first drain awaits the resulting promise; subsequent drains read freely. The server's `listen()` is not blocked.

## Storage

- `topics.embedding` (BLOB): little-endian Float32 bytes. Serialized via `Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)`; deserialized via a copy into a fresh 4-byte-aligned ArrayBuffer (the Uint8Array node:sqlite returns isn't guaranteed to start at a 4-byte-aligned offset, so wrapping it directly as a Float32Array would throw on some inputs).
- `topics.embedding_model` (TEXT): the `Embedder.model` value at the time the embedding was written. `listAllTopicEmbeddings(model)` and `listTopicsMissingEmbedding(model, ...)` filter on this so a config-driven model swap force-regenerates everything.
- No separate index. With ~thousands of topics × 384 floats, brute-force cosine over the full set is sub-millisecond and avoids dragging in a vector database.
- Article embeddings are NOT persisted. Articles are write-once-match-once; embed-on-demand at match time. `ungroupArticle` re-embeds the article in memory.

## Design decisions

### CPU embedder via `@huggingface/transformers` (2026-05-03)
The constraint that drove deferring the pre-filter for so long was "no GPU available outside the LLM backend". `@huggingface/transformers` v3 with `onnxruntime-node` runs a quantized `all-MiniLM-L6-v2` on CPU at ~50 ms/embed (faster batched), which is more than fast enough for a personal-scale aggregator. License is Apache-2.0 across the package + ORT + the model. Rejected alternatives: `fastembed` (thin wrapper around the same ORT, no value-add), raw `onnxruntime-node` + manual tokenizer (reimplementing BPE/WordPiece for one model), the legacy `@xenova/transformers` package (superseded by the official `@huggingface/transformers`).

### Threshold + min-K rather than fixed top-K (2026-05-03)
Pure top-K guarantees you always include K candidates per article, even when the article is genuinely a novel story that should match nothing. That wastes LLM tokens on obvious-non-matches. Instead: take all topics with `cosine ≥ candidateThreshold`, capped at `candidateMaxK`; if fewer than `candidateMinK` clear the bar, fall back to taking the top-`candidateMinK` regardless. This means: most articles see a tight candidate set sized to actual semantic similarity, novel-story articles still see a fair LLM look at the closest existing topics (so the LLM can confirm "no, this is genuinely new" rather than the pre-filter making that call alone). When *zero* topics are returned for *every* article in a batch, the LLM matching call is skipped entirely and articles route straight to new-topic creation — a free latency win on the genuine-novel-story path.

### Embedding text includes summary + bullets, not just title + description (2026-05-03)
The embed source for a topic is the concatenation of its title, description, summary, and bullets (when present). This matters because new topics start with only a terse `title + description` (one-sentence each), and that produces a thin embedding signal. Once a topic accumulates a regenerated 2-3 sentence summary (or threshold-gated bullets), its embedding picks up the additional facts and becomes a much better target for cosine matching against future articles. Re-embed runs on every `regenerateTopicSummaries` call, mirroring exactly the trigger that updates the summary itself, so embeddings can never lag behind summary content for more than the regen call's duration. Same canonical text is used at create-time and regen-time so a single article's view of the topic-vector universe is consistent.

### Backfill is non-blocking with first-drain await (2026-05-03)
On `consolidator.start()`, `backfillEmbeddings()` is kicked off in the background and the resulting promise is stashed. The first `drain()` iteration awaits it before processing any articles; subsequent drains see a resolved promise and skip the await. This trades a small one-time delay before the first article matches (typically tens of seconds) for not blocking `server.listen()` or readiness probes. The trade vs. blocking startup matters because in normal operation the LLM backend init also needs to happen — running both in parallel rather than serializing them avoids paying both costs end-to-end.

### Vector storage as inline BLOB, no extension (2026-05-03)
Topic embeddings live in a `BLOB` column on `topics`. No `sqlite-vec` integration: `node:sqlite`'s `DatabaseSync` does not expose `loadExtension`, and the brute-force scan over the full embedding set is sub-millisecond at our scale anyway. If topic count ever grows past ~50k, revisit (probably by switching to `better-sqlite3` and loading `sqlite-vec`, or by computing top-K candidates incrementally with a heap).

### Trade vLLM prefix cache for ~100× input token reduction (2026-05-03)
The previous matcher's deterministic 50-topic pages were tuned for vLLM prefix caching (block size 1568 tokens on hybrid Mamba models). The pre-filter destroys that determinism — the candidate set per drain is now article-content-driven and varies. Net throughput still improves by a wide margin: per-batch input tokens drop from ~560k (10 articles × ~28 pages × ~2k tokens/page) to ~3k (10 articles + ~30 candidate topics in one call), the dominant LLM work shifts from token volume to reasoning quality on a small candidate set, and the LLM still gets to do the multi-label classification work — only on a useful subset. Some prefix-cache hits remain opportunistically: the system prompt is byte-stable, the article batch suffix is byte-stable across the chunks of a single oversized union, and the candidate union is sorted by topic id so consecutive batches whose unions overlap share a leading prefix.
