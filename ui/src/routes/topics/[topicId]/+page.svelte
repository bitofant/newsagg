<script lang="ts">
  import { onMount } from 'svelte'
  import { goto } from '$app/navigation'
  import { page } from '$app/state'
  import { isLoggedIn, getTopicDetail, vote, setTopicRead, ungroupArticle, startUnmerge, pollUnmergeResult, listTopics, mergeTopic } from '$lib/api'
  import type { TopicDetail, TopicListEntry } from '$lib/api'
  import { timeAgo } from '$lib/time'
  import { morphSnapshot } from '$lib/transition'
  import { ArrowLeft, ThumbsUp, ThumbsDown, CircleCheck, Circle, Unlink2, Split, Merge, Loader2, Search, X } from 'lucide-svelte'
  import { fade } from 'svelte/transition'

  type UnmergePhase = 'confirm' | 'pending' | 'done' | 'error'
  interface UnmergeOverlay {
    phase: UnmergePhase
    newTopics?: { id: number; title: string }[]
    error?: string
  }

  type MergePhase = 'picker' | 'confirm' | 'pending' | 'done' | 'error'
  interface MergeOverlay {
    phase: MergePhase
    topics?: TopicListEntry[]
    query?: string
    loading?: boolean
    destination?: TopicListEntry
    winnerId?: number
    winnerTitle?: string
    error?: string
  }

  let topic = $state<TopicDetail | null>(null)
  let loading = $state(true)
  let error = $state('')
  let votes = $state(new Map<number, 1 | -1>())
  let ungroupingArticles = $state(new Set<number>())
  let unmergeOverlay = $state<UnmergeOverlay | null>(null)
  let mergeOverlay = $state<MergeOverlay | null>(null)

  $effect(() => {
    const id = page.params['topicId']
    if (!id) return
    void loadTopic(parseInt(id, 10))
  })

  async function loadTopic(topicId: number) {
    if (!isLoggedIn()) {
      goto('/login')
      return
    }
    loading = true
    error = ''
    try {
      const t = await getTopicDetail(topicId)
      if (!t) {
        goto('/')
        return
      }
      topic = t
    } catch (e) {
      error = String(e)
    } finally {
      loading = false
    }
  }

  async function handleTopicVote(v: 1 | -1) {
    if (!topic) return
    const articleIds = topic.articles.map((a) => a.id)
    const current = articleIds.map((id) => votes.get(id)).find((x) => x !== undefined)
    const next = current === v ? 0 : v
    const updated = new Map(votes)
    for (const id of articleIds) {
      if (next === 0) updated.delete(id)
      else updated.set(id, next)
    }
    votes = updated
    await Promise.all(articleIds.map((id) => vote(id, next as 1 | -1 | 0)))
  }

  async function toggleRead() {
    if (!topic) return
    const newIsRead = !topic.isRead
    topic = { ...topic, isRead: newIsRead }
    await setTopicRead(topic.id, newIsRead)
  }

  function startUnmergeConfirm() {
    if (!topic || unmergeOverlay) return
    if (topic.articles.length < 2) return
    unmergeOverlay = { phase: 'confirm' }
  }

  function cancelUnmergeConfirm() {
    unmergeOverlay = null
  }

  async function confirmUnmerge() {
    if (!topic) return
    const topicId = topic.id
    unmergeOverlay = { phase: 'pending' }
    try {
      await startUnmerge(topicId)
    } catch (e) {
      unmergeOverlay = { phase: 'error', error: String(e) }
      return
    }
    let networkFails = 0
    while (true) {
      try {
        const r = await pollUnmergeResult(topicId, 30)
        if (r.status === 'done') {
          unmergeOverlay = { phase: 'done', newTopics: r.newTopics ?? [] }
          return
        }
        if (r.status === 'error') {
          unmergeOverlay = { phase: 'error', error: r.error ?? 'unmerge failed' }
          return
        }
        networkFails = 0
      } catch {
        networkFails++
        if (networkFails > 5) {
          unmergeOverlay = { phase: 'error', error: 'lost connection' }
          return
        }
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
  }

  function dismissOverlay() {
    const wasDone = unmergeOverlay?.phase === 'done'
    unmergeOverlay = null
    if (wasDone) goto('/')
  }

  async function startMergePicker() {
    if (!topic || mergeOverlay || unmergeOverlay) return
    const currentId = topic.id
    mergeOverlay = { phase: 'picker', loading: true, query: '' }
    try {
      const all = await listTopics(200)
      if (!mergeOverlay) return
      mergeOverlay = { phase: 'picker', topics: all.filter((t) => t.id !== currentId), query: '', loading: false }
    } catch (e) {
      mergeOverlay = { phase: 'error', error: String(e) }
    }
  }

  function pickMergeDestination(t: TopicListEntry) {
    mergeOverlay = { phase: 'confirm', destination: t }
  }

  function cancelMerge() {
    mergeOverlay = null
  }

  async function confirmMerge() {
    if (!topic || !mergeOverlay?.destination) return
    const dest = mergeOverlay.destination
    const topicId = topic.id
    mergeOverlay = { phase: 'pending', destination: dest }
    try {
      const r = await mergeTopic(topicId, dest.id)
      mergeOverlay = { phase: 'done', destination: dest, winnerId: r.winnerId, winnerTitle: r.winnerTitle }
    } catch (e) {
      mergeOverlay = { phase: 'error', destination: dest, error: String(e) }
    }
  }

  function dismissMergeOverlay() {
    const overlay = mergeOverlay
    mergeOverlay = null
    if (overlay?.phase === 'done' && overlay.winnerId !== undefined) {
      goto(`/topics/${overlay.winnerId}`)
    }
  }

  async function handleUngroup(articleId: number) {
    if (!topic) return
    const updated = new Set(ungroupingArticles)
    updated.add(articleId)
    ungroupingArticles = updated
    try {
      await ungroupArticle(topic.id, articleId)
      const refreshed = await getTopicDetail(topic.id)
      if (!refreshed || refreshed.articles.length === 0) {
        goto('/')
        return
      }
      topic = refreshed
      const cleared = new Set(ungroupingArticles)
      cleared.delete(articleId)
      ungroupingArticles = cleared
    } catch {
      const cleared = new Set(ungroupingArticles)
      cleared.delete(articleId)
      ungroupingArticles = cleared
    }
  }

  function topicVote(): 1 | -1 | undefined {
    if (!topic) return undefined
    return topic.articles.map((a) => votes.get(a.id)).find((v) => v !== undefined)
  }
</script>

<svelte:head>
  <title>{topic?.title ?? 'Topic'} · newsagg</title>
</svelte:head>

{#if error}
  <p class="text-red-500 dark:text-red-400 text-center mt-20">{error}</p>
{:else}
  {@const urlId = parseInt(page.params['topicId'] ?? '0', 10)}
  {@const snap = $morphSnapshot && $morphSnapshot.topicId === urlId ? $morphSnapshot : null}
  {@const heroTitle = topic?.title ?? snap?.title ?? ''}
  {@const heroSummary = topic?.summary ?? snap?.summary ?? ''}
  {@const tv = topicVote()}
  <div class="max-w-2xl mx-auto">
    <a
      href="/"
      class="inline-flex items-center gap-1.5 text-sm text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
    >
      <ArrowLeft size={16} /> Front page
    </a>

    <article class="mt-6 relative" style="view-transition-name: topic-card">
      {#if heroTitle}
        <h1
          class="font-serif text-3xl md:text-4xl font-bold leading-tight tracking-tight"
          style="view-transition-name: topic-title"
        >
          {heroTitle}
        </h1>
      {/if}

      {#if heroSummary}
        <p
          class="mt-5 text-lg leading-relaxed text-stone-700 dark:text-stone-300"
          style="view-transition-name: topic-summary"
        >
          {heroSummary}
        </p>
      {/if}

      {#if topic && ((topic.bullets?.length ?? 0) + (topic.newInfo?.length ?? 0) > 0)}
        <ul class="mt-5 space-y-1.5 list-disc list-inside text-base leading-relaxed text-stone-700 dark:text-stone-300">
          {#each topic.newInfo ?? [] as item}
            <li><strong class="text-amber-600 dark:text-amber-400">NEW:</strong> {item}</li>
          {/each}
          {#each topic.bullets ?? [] as item}
            <li>{item}</li>
          {/each}
        </ul>
      {/if}

      {#if loading && !snap}
        <p class="text-stone-400 dark:text-stone-500 text-center mt-10">Loading...</p>
      {/if}

      {#if topic}
      <div class="mt-7 flex flex-wrap items-center gap-2 border-y border-stone-200 dark:border-stone-800 py-3">
        <button
          onclick={toggleRead}
          class="flex items-center gap-2 px-3 py-2 rounded-full text-sm transition-colors {topic.isRead
            ? 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40'
            : 'text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800'}"
          title={topic.isRead ? 'Mark as unread' : 'Mark as read'}
        >
          {#if topic.isRead}<CircleCheck size={20} />{:else}<Circle size={20} />{/if}
          <span>{topic.isRead ? 'Read' : 'Mark as read'}</span>
        </button>
        <button
          onclick={() => handleTopicVote(1)}
          class="flex items-center gap-2 px-3 py-2 rounded-full text-sm transition-colors {tv === 1
            ? 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40'
            : 'text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800'}"
          title="Interesting"
        >
          <ThumbsUp size={20} />
          <span>Interesting</span>
        </button>
        <button
          onclick={() => handleTopicVote(-1)}
          class="flex items-center gap-2 px-3 py-2 rounded-full text-sm transition-colors {tv === -1
            ? 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40'
            : 'text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800'}"
          title="Not interested"
        >
          <ThumbsDown size={20} />
          <span>Not for me</span>
        </button>
        <button
          onclick={startUnmergeConfirm}
          disabled={!!unmergeOverlay || !!mergeOverlay || topic.articles.length < 2}
          class="flex items-center gap-2 px-3 py-2 rounded-full text-sm transition-colors text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40 disabled:cursor-not-allowed"
          title="Split this topic into separate topics"
        >
          <Split size={20} />
          <span>Unmerge</span>
        </button>
        <button
          onclick={startMergePicker}
          disabled={!!unmergeOverlay || !!mergeOverlay}
          class="flex items-center gap-2 px-3 py-2 rounded-full text-sm transition-colors text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40 disabled:cursor-not-allowed"
          title="Merge this topic into another (mark as duplicate)"
        >
          <Merge size={20} />
          <span>Merge into…</span>
        </button>
      </div>

      <section class="mt-8">
        <h2 class="font-serif text-xl font-semibold mb-2">
          Sources <span class="text-stone-400 dark:text-stone-500 font-normal">· {topic.articles.length}</span>
        </h2>
        <ul class="divide-y divide-stone-100 dark:divide-stone-800">
          {#each topic.articles as article}
            {@const isUngrouping = ungroupingArticles.has(article.id)}
            <li
              class="flex items-start gap-3 py-4 transition-opacity duration-300 {isUngrouping ? 'opacity-30' : ''}"
            >
              <div class="flex-1 min-w-0">
                <a
                  href={article.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-base font-medium text-stone-900 dark:text-stone-100 hover:underline leading-snug block"
                >{article.title}</a>
                <div class="mt-1 text-sm text-stone-500 dark:text-stone-400">
                  {article.source} · {timeAgo(article.fetchedAt)}
                </div>
              </div>
              {#if !isUngrouping}
                <button
                  onclick={() => handleUngroup(article.id)}
                  class="shrink-0 p-2 rounded-full text-stone-400 dark:text-stone-500 hover:text-amber-600 dark:hover:text-amber-400 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors"
                  title="Ungroup from this topic"
                >
                  <Unlink2 size={18} />
                </button>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
      {/if}

      {#if unmergeOverlay?.phase === 'confirm'}
        <div
          class="absolute inset-0 flex rounded-xl overflow-hidden z-10"
          transition:fade={{ duration: 150 }}
        >
          <button
            onclick={confirmUnmerge}
            class="flex-1 bg-green-500/60 hover:bg-green-500/80 flex items-center justify-center transition-colors"
            aria-label="Confirm unmerge"
          ><ThumbsUp size={96} class="text-white drop-shadow" /></button>
          <button
            onclick={cancelUnmergeConfirm}
            class="flex-1 bg-red-500/60 hover:bg-red-500/80 flex items-center justify-center transition-colors"
            aria-label="Cancel"
          ><ThumbsDown size={96} class="text-white drop-shadow" /></button>
          <h3 class="absolute top-6 left-0 right-0 text-center font-serif text-3xl font-bold text-white drop-shadow-md pointer-events-none">
            Split topic?
          </h3>
        </div>
      {:else if unmergeOverlay?.phase === 'pending'}
        <div
          class="absolute inset-0 bg-yellow-400/70 rounded-xl flex flex-col items-center justify-center z-10"
          transition:fade={{ duration: 150 }}
        >
          <h3 class="font-serif text-3xl font-bold text-white drop-shadow-md mb-5">Splitting topic…</h3>
          <Loader2 size={80} class="animate-spin text-white drop-shadow" />
        </div>
      {:else if unmergeOverlay?.phase === 'done'}
        <button
          onclick={dismissOverlay}
          class="absolute inset-0 bg-green-500/75 rounded-xl flex flex-col items-center justify-center z-10 px-6 py-10 cursor-pointer"
          transition:fade={{ duration: 150 }}
          aria-label="Dismiss"
        >
          <h3 class="font-serif text-3xl font-bold text-white drop-shadow-md mb-5">Split into:</h3>
          <ul class="space-y-2 text-white text-lg font-medium text-center max-w-full">
            {#each unmergeOverlay.newTopics ?? [] as nt}
              <li class="leading-snug">{nt.title}</li>
            {/each}
          </ul>
          <p class="absolute bottom-4 left-0 right-0 text-center text-xs uppercase tracking-widest text-white/80">Tap to continue</p>
        </button>
      {:else if unmergeOverlay?.phase === 'error'}
        <button
          onclick={dismissOverlay}
          class="absolute inset-0 bg-red-500/75 rounded-xl flex flex-col items-center justify-center z-10 px-6 py-10 cursor-pointer"
          transition:fade={{ duration: 150 }}
          aria-label="Dismiss"
        >
          <h3 class="font-serif text-3xl font-bold text-white drop-shadow-md mb-2">Split failed</h3>
          <p class="text-white text-base">{unmergeOverlay.error ?? 'unknown error'}</p>
          <p class="absolute bottom-4 left-0 right-0 text-center text-xs uppercase tracking-widest text-white/80">Tap to dismiss</p>
        </button>
      {/if}

      {#if mergeOverlay?.phase === 'picker'}
        <div
          class="absolute inset-0 bg-stone-900/95 dark:bg-black/95 rounded-xl flex flex-col z-10 overflow-hidden"
          transition:fade={{ duration: 150 }}
        >
          <div class="flex items-center gap-2 p-3 border-b border-white/10">
            <Search size={20} class="text-stone-400 shrink-0" />
            <input
              type="text"
              bind:value={mergeOverlay.query}
              placeholder="Find topic to merge into…"
              class="flex-1 bg-transparent text-white placeholder:text-stone-500 outline-none text-base"
            />
            <button onclick={cancelMerge} class="p-1.5 text-stone-400 hover:text-white" aria-label="Cancel">
              <X size={18} />
            </button>
          </div>
          <div class="flex-1 overflow-y-auto">
            {#if mergeOverlay.loading}
              <p class="text-stone-400 text-center mt-10">Loading…</p>
            {:else}
              {@const q = (mergeOverlay.query ?? '').toLowerCase().trim()}
              {@const filtered = (mergeOverlay.topics ?? []).filter((t) => !q || t.title.toLowerCase().includes(q))}
              {#if filtered.length === 0}
                <p class="text-stone-400 text-center mt-10">No matching topics</p>
              {:else}
                <ul class="divide-y divide-white/5">
                  {#each filtered as t (t.id)}
                    <li>
                      <button
                        onclick={() => pickMergeDestination(t)}
                        class="w-full text-left px-4 py-3 hover:bg-white/10 transition-colors"
                      >
                        <div class="text-white font-medium leading-snug">{t.title}</div>
                        <div class="text-xs text-stone-400 mt-0.5">
                          {t.articleCount} article{t.articleCount === 1 ? '' : 's'} · {timeAgo(t.updatedAt)}
                        </div>
                      </button>
                    </li>
                  {/each}
                </ul>
              {/if}
            {/if}
          </div>
        </div>
      {:else if mergeOverlay?.phase === 'confirm'}
        <div
          class="absolute inset-0 flex rounded-xl overflow-hidden z-10"
          transition:fade={{ duration: 150 }}
        >
          <button
            onclick={confirmMerge}
            class="flex-1 bg-green-500/60 hover:bg-green-500/80 flex items-center justify-center transition-colors"
            aria-label="Confirm merge"
          ><ThumbsUp size={96} class="text-white drop-shadow" /></button>
          <button
            onclick={cancelMerge}
            class="flex-1 bg-red-500/60 hover:bg-red-500/80 flex items-center justify-center transition-colors"
            aria-label="Cancel"
          ><ThumbsDown size={96} class="text-white drop-shadow" /></button>
          <div class="absolute top-6 left-0 right-0 text-center px-6 pointer-events-none">
            <h3 class="font-serif text-2xl md:text-3xl font-bold text-white drop-shadow-md">Merge into:</h3>
            <p class="mt-2 text-white text-lg font-medium drop-shadow leading-snug">{mergeOverlay.destination?.title ?? ''}</p>
          </div>
        </div>
      {:else if mergeOverlay?.phase === 'pending'}
        <div
          class="absolute inset-0 bg-yellow-400/70 rounded-xl flex flex-col items-center justify-center z-10"
          transition:fade={{ duration: 150 }}
        >
          <h3 class="font-serif text-3xl font-bold text-white drop-shadow-md mb-5">Merging topics…</h3>
          <Loader2 size={80} class="animate-spin text-white drop-shadow" />
        </div>
      {:else if mergeOverlay?.phase === 'done'}
        <button
          onclick={dismissMergeOverlay}
          class="absolute inset-0 bg-green-500/75 rounded-xl flex flex-col items-center justify-center z-10 px-6 py-10 cursor-pointer"
          transition:fade={{ duration: 150 }}
          aria-label="Open merged topic"
        >
          <h3 class="font-serif text-3xl font-bold text-white drop-shadow-md mb-3">Merged into:</h3>
          <p class="text-white text-lg font-medium leading-snug text-center max-w-full">{mergeOverlay.winnerTitle ?? ''}</p>
          <p class="absolute bottom-4 left-0 right-0 text-center text-xs uppercase tracking-widest text-white/80">Tap to open</p>
        </button>
      {:else if mergeOverlay?.phase === 'error'}
        <button
          onclick={dismissMergeOverlay}
          class="absolute inset-0 bg-red-500/75 rounded-xl flex flex-col items-center justify-center z-10 px-6 py-10 cursor-pointer"
          transition:fade={{ duration: 150 }}
          aria-label="Dismiss"
        >
          <h3 class="font-serif text-3xl font-bold text-white drop-shadow-md mb-2">Merge failed</h3>
          <p class="text-white text-base">{mergeOverlay.error ?? 'unknown error'}</p>
          <p class="absolute bottom-4 left-0 right-0 text-center text-xs uppercase tracking-widest text-white/80">Tap to dismiss</p>
        </button>
      {/if}
    </article>
  </div>
{/if}
