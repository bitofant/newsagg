# AI module (`src/ai/`)

LLM wrapper over OpenAI-compatible APIs (Ollama or vLLM). The only LLM caller in the project — every other component goes through `getAi()`.

## Provider abstraction

- Polymorphic via `InferenceProvider` (abstract base in `src/ai/provider.ts`) with `OllamaProvider` and `VllmProvider` subclasses.
- Production code receives the abstract type via `getAi()` from `src/ai/index.ts`.
- Backend-specific public methods (`VllmProvider.fetchModelInfo`, `OllamaProvider.listModels`/`ping`) are intentionally not on the abstract interface — production code can't depend on them. Reachable from `llm-test.ts` and tests via `instanceof` narrowing.
- Lazy singleton via `Singletons.computeIfAbsent('ai', ...)` (see `src/singletons.ts`). The first `getAi()` call constructs the right provider based on `config.ai.backend`. Tests pre-populate the registry with a mock (`Singletons.set('ai', mock)`) before any production code touches `getAi()`.
- Initialization is lazy and one-shot: `InferenceProvider.ensureInitialized()` runs `doInit()` once on the first `complete()` call. Mocks pre-populated in `Singletons` skip init entirely (they override `complete` directly).

## Config (`config.ai`)

`backend: 'ollama' | 'vllm'`, `url`, `model`, `maxContextTokens`, optional `apiKey`, `statusWindowMs`, `requestTimeoutMs` (default 5 min — caps every chat-completion call so a hung backend surfaces fast).

`model` and `maxContextTokens` accept `"auto"` to fetch from `/v1/models` at startup. vLLM serves `max_model_len` in the model list; Ollama does not — `OllamaProvider.doInit()` throws if either is `"auto"`.

## `complete(prompt, opts)`

`opts.reasoningEffort: 'off' | 'low' | 'medium' | 'high'`. `low/medium/high` send OpenAI-compatible `reasoning_effort`. `'off'` sends `chat_template_kwargs: { enable_thinking: false }` instead — a vLLM extension respected by Qwen3's chat template (and our custom one) to disable the `<think>` block entirely; the OpenAI API has no equivalent. Omit to leave at backend default.

**Production model is binary on/off**: Qwen3.6:27b treats `low/medium/high` identically (full reasoning); only `'off'` actually disables thinking. So picking a level is yes/no, and reasoning roughly 5×'s wall-clock per call.

**Where each level is used**: matching and profiler use `'high'` (genuinely reasoning-shaped: multi-label classification with the "substantial info, not passing mention" judgment for matching; rare debounced run for profiler). Assessment, relevance scoring, and topic-summary generation/regeneration use `'off'` (clear-criteria booleans, title-vs-profile pattern match, extractive summarization — none benefit from a `<think>` block, and they sit on hot paths where 5× wall-clock would directly grow the consolidator/aggregator backlog).

Reasoning content is read from `message.reasoning_content` *or* `message.reasoning` (vLLM parsers differ — `deepseek_r1` emits `reasoning_content`, `qwen3` emits `reasoning`; Ollama gpt-oss populates `reasoning_content`). When `usage.completion_tokens_details.reasoning_tokens` isn't returned (qwen3 parser doesn't), reasoning-token count is estimated from reasoning text length at ~4 chars/token so `/status` still shows non-zero `reasoningTokPerSec`.

`opts.timeoutMs` overrides `config.ai.requestTimeoutMs` for one call. `npm run llm-test` uses 30s.

## Logging

Every `complete()` call writes 3 files to `llm/{YYYYMMDD}/` (gitignored): `{unix_ts}_{seq}.req` (request JSON), `{unix_ts}_{seq}.res` (response text), `{unix_ts}_{seq}.think` (reasoning text, if present). The `{seq}` suffix is a per-process monotonic counter so concurrent calls in the same second don't overwrite each other. Fire-and-forget, never blocks inference.

## Metrics

Each call records `{startedAt, endedAt, promptTokens, completionTokens, reasoningTokens}` in a rolling window (`ai.statusWindowMs`, default 10 min). Surfaced via `status()` as `busyPct`, `reqPerMin`, `tokPerSec`, `reasoningTokPerSec` (non-zero only for reasoning models). `reasoningTokPerSec` is shown on `/status` only when non-zero.

## Design decisions

### LLM response code-fence stripping (2026-04-10)
Both consolidator and aggregator strip markdown code fences (` ```json ... ``` `) from LLM responses before JSON parsing via `stripCodeFences()`. Models (especially Gemma 4) wrap JSON in code fences despite explicit "no code fences" prompts. Without stripping, all `JSON.parse()` calls fail.

### max_tokens = 4096 / 8192 (2026-04-10, updated 2026-04-29)
The AI client sends `max_tokens: 4096` for non-reasoning calls and `max_tokens: 8192` when `reasoningEffort` is `'low' | 'medium' | 'high'`. Reasoning tokens count against the same output budget on vLLM's qwen3 parser (and Gemma 4 historically), so a long reasoning chain on a complex prompt could exhaust 4096 tokens before emitting any JSON, producing null/truncated responses or full 5-min timeouts. Both constants are exported (`MAX_OUTPUT_TOKENS` / `MAX_OUTPUT_TOKENS_REASONING`) and the consolidator's `inputBudget(ai, fixedOverhead, reasoningEnabled)` reserves the right one when sizing chunked prompts. Only `matchBatchAgainstTopics` passes `true` today; the other batched calls run at `reasoningEffort: 'off'` and keep the smaller reserve so chunks can stay larger. Original 4096 default came from prior Gemma 4 experimentation where 1024 was too low.

### vLLM auto-detection via `"auto"` sentinel (2026-04-25)
`config.ai.model` and `config.ai.maxContextTokens` accept `"auto"` to fetch the first model's `id` and `max_model_len` from `GET /v1/models` at startup. `VllmProvider.doInit()` resolves these before the first `complete()` call. One fetch covers both fields. vLLM always includes `max_model_len`; Ollama does not — setting `"auto"` with Ollama backend throws a clear error. The `maxContextTokens` property on `InferenceProvider` is always a resolved `number` after init. Rationale: vLLM typically serves a single model and the context window is a property of the model weights, not something operators should have to look up manually.

### Reasoning effort is per-call, not config (2026-04-25)
`InferenceProvider.complete(prompt, { reasoningEffort })` accepts `'off' | 'low' | 'medium' | 'high'`. The previous config-level `thinkingEffort` field was removed because it never made it into a request body; the per-call parameter replaces it. Rationale: a global config value would force all stages to the same setting, but stages have very different latency tolerances. (See "Where each level is used" above for current call sites.)

### AI module: classes + Singletons container (2026-04-25)
The one place in the project where `createX()` factories are replaced with classes — abstract `InferenceProvider` with `OllamaProvider` and `VllmProvider` subclasses. Backend-specific public methods reachable only via `instanceof` narrowing; production code holds the abstract type. A generic `Singletons` registry (`src/singletons.ts`, `computeIfAbsent` / `set` / `clear`, keyed by string) lazily constructs the configured provider on first `getAi()` call; tests pre-populate it with mocks. Other modules keep their `createX()` factories — this scope is AI-only for now. Rationale: backends share an OpenAI-compatible request body but differ in initialization and diagnostic surface; polymorphism captures that cleanly, and the registry gives a uniform test-override hook.

### Per-request timeout in `complete()` (2026-04-25)
Every chat-completion call uses `AbortController` with `config.ai.requestTimeoutMs` (default 5 min, overridable via `opts.timeoutMs`). Previously `fetch` had no timeout — a hung backend could pin the consolidator drain silently.
