<script lang="ts">
  import { onMount } from 'svelte'
  import { slide } from 'svelte/transition'
  import { goto } from '$app/navigation'
  import {
    isLoggedIn,
    listDupeCandidates,
    startDupeGeneration,
    cancelDupeGeneration,
    pollDupeStatus,
    dismissDupePair,
    mergeTopic,
    type DupeCandidate,
    type DupeFinderStatus,
  } from '$lib/api'
  import { timeAgo } from '$lib/time'
  import { ArrowLeft, ArrowRight, Ban, Loader2, Search, X, Merge } from 'lucide-svelte'

  let candidates = $state<DupeCandidate[]>([])
  let status = $state<DupeFinderStatus>({ state: 'idle' })
  let loading = $state(true)
  let error = $state('')
  let busyPair = $state<{ key: string; kind: 'merge' | 'dismiss' } | null>(null)
  let cancelling = $state(false)
  // In-flight POST /dupes/generate, if this client is the one that started the scan.
  // cancel() awaits it so a cancel can't reach the server before the run it means to stop.
  let startPromise: Promise<unknown> | null = null

  function pairKey(c: DupeCandidate): string {
    return `${c.topicIdA}:${c.topicIdB}`
  }

  onMount(async () => {
    if (!isLoggedIn()) {
      goto('/login')
      return
    }
    await refresh()
    loading = false
    // If a generation is in flight (e.g. user navigated away and came back), resume polling.
    if (status.state === 'running') void pollUntilDone()
  })

  async function refresh() {
    try {
      const r = await listDupeCandidates()
      candidates = r.candidates
      status = r.status
    } catch (e) {
      error = String(e)
    }
  }

  async function pollUntilDone() {
    let networkFails = 0
    while (true) {
      try {
        const s = await pollDupeStatus(30)
        status = s
        if (s.state !== 'running') {
          await refresh()
          return
        }
        networkFails = 0
      } catch {
        networkFails++
        if (networkFails > 5) {
          error = 'lost connection while polling'
          return
        }
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
  }

  async function generate() {
    if (status.state === 'running') return
    error = ''
    status = { ...status, state: 'running', startedAt: Date.now() }
    try {
      startPromise = startDupeGeneration()
      await startPromise
    } catch (e) {
      error = String(e)
      status = { state: 'error', error: String(e) }
      return
    }
    await pollUntilDone()
  }

  async function cancel() {
    // Cancellation is server-side; this just asks the server to stop whichever run
    // is in flight. The active poll will pick up the resulting 'cancelled' status.
    if (status.state !== 'running' || cancelling) return
    cancelling = true
    try {
      // generate() flips status to 'running' optimistically, so the Cancel button can be
      // clicked before the server has even received the start. Wait for the start to land
      // first, otherwise the cancel arrives with nothing in flight and silently no-ops.
      await startPromise?.catch(() => {})
      await cancelDupeGeneration()
    } catch (e) {
      error = String(e)
    } finally {
      cancelling = false
    }
  }

  const SLIDE_MS = 300

  async function handleDismiss(c: DupeCandidate) {
    const key = pairKey(c)
    if (busyPair) return
    busyPair = { key, kind: 'dismiss' }
    try {
      await dismissDupePair(c.topicIdA, c.topicIdB)
      candidates = candidates.filter((x) => pairKey(x) !== key)
      setTimeout(() => { if (busyPair?.key === key) busyPair = null }, SLIDE_MS + 20)
    } catch (e) {
      error = String(e)
      busyPair = null
    }
  }

  async function handleMerge(c: DupeCandidate, direction: 'AintoB' | 'BintoA') {
    const key = pairKey(c)
    if (busyPair) return
    busyPair = { key, kind: 'merge' }
    const loserId = direction === 'AintoB' ? c.topicIdA : c.topicIdB
    const winnerId = direction === 'AintoB' ? c.topicIdB : c.topicIdA
    try {
      await mergeTopic(loserId, winnerId)
      // Server-side cascade in deleteTopic already removed this candidate row.
      candidates = candidates.filter((x) => pairKey(x) !== key)
      setTimeout(() => { if (busyPair?.key === key) busyPair = null }, SLIDE_MS + 20)
    } catch (e) {
      error = String(e)
      busyPair = null
    }
  }

  let searchQuery = $state('')
  let filtered = $derived(
    searchQuery.trim()
      ? candidates.filter((c) => {
          const q = searchQuery.toLowerCase()
          return c.titleA.toLowerCase().includes(q) || c.titleB.toLowerCase().includes(q)
        })
      : candidates,
  )
</script>

<svelte:head>
  <title>Find duplicates · newsagg</title>
</svelte:head>

<div class="max-w-3xl mx-auto">
  <a
    href="/"
    class="inline-flex items-center gap-1.5 text-sm text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
  >
    <ArrowLeft size={16} /> Front page
  </a>

  <div class="flex items-baseline justify-between mt-4 mb-2 gap-3 flex-wrap">
    <h1 class="font-serif text-2xl font-bold">Find duplicates</h1>
    {#if status.state === 'done' && status.completedAt}
      <span class="text-xs text-stone-500 dark:text-stone-400">
        Last scan {timeAgo(status.completedAt)} · {status.candidateCount ?? 0} pair{(status.candidateCount ?? 0) === 1 ? '' : 's'}
      </span>
    {:else if status.state === 'cancelled' && status.completedAt}
      <span class="text-xs text-stone-500 dark:text-stone-400">Scan cancelled {timeAgo(status.completedAt)}</span>
    {/if}
  </div>

  <p class="text-sm text-stone-500 dark:text-stone-400 mb-4">
    Topic pairs whose embeddings look very similar. Merge real duplicates; mark the rest as not-a-duplicate so they don't reappear.
  </p>

  <div class="flex flex-wrap items-center gap-3 mb-6">
    <button
      onclick={generate}
      disabled={status.state === 'running'}
      class="inline-flex items-center gap-2 px-4 py-2 bg-stone-800 dark:bg-stone-100 text-white dark:text-stone-900 text-sm rounded hover:bg-stone-700 dark:hover:bg-stone-300 disabled:opacity-50"
    >
      {#if status.state === 'running'}
        <Loader2 size={16} class="animate-spin" /> Scanning…
      {:else}
        Generate candidates
      {/if}
    </button>

    <!-- Driven solely by server-reported status, so it shows for any client while a
         scan is in flight regardless of who started it. -->
    {#if status.state === 'running'}
      <button
        onclick={cancel}
        disabled={cancelling}
        class="inline-flex items-center gap-2 px-4 py-2 border border-stone-300 dark:border-stone-700 text-stone-700 dark:text-stone-300 text-sm rounded hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50"
      >
        <Ban size={16} /> {cancelling ? 'Cancelling…' : 'Cancel'}
      </button>
    {/if}

    {#if candidates.length > 0}
      <div class="flex items-center gap-2 flex-1 min-w-[12rem] max-w-md border border-stone-300 dark:border-stone-700 rounded px-2 py-1 bg-white dark:bg-stone-800">
        <Search size={16} class="text-stone-400" />
        <input
          type="text"
          bind:value={searchQuery}
          placeholder="Filter by title…"
          class="flex-1 bg-transparent text-sm outline-none dark:text-stone-100"
        />
        {#if searchQuery}
          <button onclick={() => (searchQuery = '')} class="text-stone-400 hover:text-stone-700 dark:hover:text-stone-200" aria-label="Clear">
            <X size={14} />
          </button>
        {/if}
      </div>
    {/if}
  </div>

  {#if error}
    <p class="mb-4 text-sm text-red-500 dark:text-red-400">{error}</p>
  {/if}
  {#if status.state === 'error' && status.error}
    <p class="mb-4 text-sm text-red-500 dark:text-red-400">Scan failed: {status.error}</p>
  {/if}

  {#if loading}
    <p class="text-stone-400 dark:text-stone-500">Loading…</p>
  {:else if candidates.length === 0}
    <div class="bg-white dark:bg-stone-900 rounded-xl shadow-sm p-8 text-center">
      <p class="text-stone-500 dark:text-stone-400">
        {#if status.state === 'done'}
          No duplicate candidates. Either there are fewer than two topics with embeddings, or every top pair has already been dismissed.
        {:else}
          No candidates yet. Click <strong>Generate candidates</strong> to scan all topics.
        {/if}
      </p>
    </div>
  {:else}
    <ul class="space-y-3">
      {#each filtered as c (pairKey(c))}
        {@const key = pairKey(c)}
        {@const busy = busyPair?.key === key}
        {@const overlayColor = busyPair?.kind === 'merge'
          ? 'bg-emerald-500/60 dark:bg-emerald-500/50'
          : busyPair?.kind === 'dismiss'
            ? 'bg-red-500/60 dark:bg-red-500/50'
            : 'bg-white/60 dark:bg-stone-900/60'}
        <li
          out:slide={{ duration: SLIDE_MS }}
          class="relative bg-white dark:bg-stone-900 rounded-xl shadow-sm p-4 {busy ? 'pointer-events-none' : ''}"
        >
          <div
            class="pointer-events-none absolute inset-0 z-10 rounded-xl {overlayColor} transition-opacity duration-200 {busy ? 'opacity-100' : 'opacity-0'}"
          ></div>
          <div class="flex items-center gap-3 mb-3">
            <span
              class="text-xs uppercase tracking-wide font-medium px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300"
              title="Cosine similarity"
            >{c.similarity.toFixed(3)}</span>
            <span class="text-xs text-stone-400 dark:text-stone-500">added {timeAgo(c.createdAt)}</span>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-3 items-stretch">
            <div class="flex flex-col gap-1 p-3 rounded border border-stone-200 dark:border-stone-800">
              <a
                href={`/topics/${c.topicIdA}`}
                class="font-medium text-stone-900 dark:text-stone-100 hover:underline leading-snug"
              >{c.titleA}</a>
              <span class="text-xs text-stone-500 dark:text-stone-400">
                {c.articleCountA} article{c.articleCountA === 1 ? '' : 's'} · #{c.topicIdA}
              </span>
            </div>

            <div class="hidden md:flex items-center justify-center text-stone-400 dark:text-stone-600">
              <Merge size={20} />
            </div>

            <div class="flex flex-col gap-1 p-3 rounded border border-stone-200 dark:border-stone-800">
              <a
                href={`/topics/${c.topicIdB}`}
                class="font-medium text-stone-900 dark:text-stone-100 hover:underline leading-snug"
              >{c.titleB}</a>
              <span class="text-xs text-stone-500 dark:text-stone-400">
                {c.articleCountB} article{c.articleCountB === 1 ? '' : 's'} · #{c.topicIdB}
              </span>
            </div>
          </div>

          <div class="mt-3 flex flex-wrap gap-2">
            <button
              onclick={() => handleMerge(c, 'BintoA')}
              disabled={busy}
              class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-full bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-300 hover:bg-stone-200 dark:hover:bg-stone-700"
              title={`Merge "${c.titleB}" into "${c.titleA}"`}
            >
              <ArrowLeft size={14} /> Merge into left
            </button>
            <button
              onclick={() => handleMerge(c, 'AintoB')}
              disabled={busy}
              class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-full bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-300 hover:bg-stone-200 dark:hover:bg-stone-700"
              title={`Merge "${c.titleA}" into "${c.titleB}"`}
            >
              Merge into right <ArrowRight size={14} />
            </button>
            <button
              onclick={() => handleDismiss(c)}
              disabled={busy}
              class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-full text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
              title="Permanently mark as not a duplicate. Will not reappear in future scans."
            >
              <X size={14} /> Not a duplicate
            </button>
          </div>
        </li>
      {/each}
    </ul>
    {#if searchQuery && filtered.length === 0}
      <p class="text-center text-stone-400 dark:text-stone-500 mt-6">No candidates match "{searchQuery}".</p>
    {/if}
  {/if}
</div>
