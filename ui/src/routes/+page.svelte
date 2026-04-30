<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { goto } from '$app/navigation'
  import { isLoggedIn, getFrontPage, vote, subscribeToFrontPage, setReadTopics, getTopicArticles, ungroupArticle, startUnmerge, pollUnmergeResult, requestFrontPage } from '$lib/api'
  import type { FrontPage, TopicArticle } from '$lib/api'
  import { timeAgo } from '$lib/time'
  import { morphingTopicId, morphSnapshot, frontPageCache } from '$lib/transition'
  import { get } from 'svelte/store'
  import { ThumbsUp, ThumbsDown, CheckCheck, CircleCheck, Circle, Unlink2, Split, Loader2, RefreshCw } from 'lucide-svelte'
  import { fade } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'

  type UnmergePhase = 'confirm' | 'pending' | 'done' | 'error'
  interface UnmergeOverlay {
    phase: UnmergePhase
    newTopics?: { id: number; title: string }[]
    error?: string
  }

  let page: FrontPage | null = get(frontPageCache)
  let loading = page === null
  let error = ''
  let unsubscribe: (() => void) | null = null
  let votes = new Map<number, 1 | -1>()
  let expandedTopics = new Map<number, TopicArticle[] | 'loading'>()
  let readTopicIds = new Set<number>(page?.readTopicIds ?? [])
  // Snapshot of read topics at page-load time — these are hidden from the rendered list.
  // Topics marked as read in-session aren't added here, so they remain visible (at reduced opacity)
  // until the next page load, letting the user undo or revisit them.
  let hiddenReadTopicIds = new Set<number>(page?.readTopicIds ?? [])
  let ungroupingArticles = new Set<number>()
  let unmergeOverlays = new Map<number, UnmergeOverlay>()
  // While any overlay is mid-flow (pending/done/error), hold off SSE-driven page replacements;
  // the user is looking at the old card and we don't want it to disappear under them.
  let pendingFreshPage: FrontPage | null = null
  let regenerating = false
  // topicId → starting height (px) for the unmerge swap-in animation. Populated on dismiss
  // of a 'done' overlay; consumed by the in: transition on the new cards' first render.
  let expandingNewCards = new Map<number, number>()

  $: sections = page?.sections ?? []
  $: visibleSections = sections.filter(s => !hiddenReadTopicIds.has(s.topicId))

  onMount(async () => {
    if (!isLoggedIn()) {
      goto('/login')
      return
    }
    try {
      const fresh = await getFrontPage()
      if (fresh) {
        page = fresh
        readTopicIds = new Set(fresh.readTopicIds)
        hiddenReadTopicIds = new Set(fresh.readTopicIds)
        frontPageCache.set(fresh)
      }
    } catch (e) {
      if (!page) error = String(e)
    } finally {
      loading = false
    }

    unsubscribe = subscribeToFrontPage(async () => {
      try {
        const newPage = await getFrontPage()
        if (newPage) {
          if (hasBlockingOverlay()) {
            pendingFreshPage = newPage
          } else {
            applyFreshPage(newPage)
          }
        }
      } catch { /* keep old page */ }
      regenerating = false
    })
  })

  onDestroy(() => unsubscribe?.())

  async function handleTopicVote(articleIds: number[], v: 1 | -1) {
    const current = articleIds.map(id => votes.get(id)).find(x => x !== undefined)
    const next = current === v ? 0 : v
    for (const id of articleIds) {
      if (next === 0) votes.delete(id)
      else votes.set(id, next)
    }
    votes = votes
    await Promise.all(articleIds.map(id => vote(id, next as 1 | -1 | 0)))
  }

  function markReadAtPosition(index: number) {
    // index is into visibleSections. Visible items at 0..index become read; visible items
    // below become unread. Hidden (already-read-at-load) topics keep their read state so
    // shifting the line up doesn't silently un-read items the user can't see.
    const newRead = new Set<number>(hiddenReadTopicIds)
    for (let i = 0; i <= index; i++) {
      newRead.add(visibleSections[i].topicId)
    }
    readTopicIds = newRead
    setReadTopics([...newRead])
  }

  function toggleRead(topicId: number) {
    const newRead = new Set(readTopicIds)
    if (newRead.has(topicId)) {
      newRead.delete(topicId)
    } else {
      newRead.add(topicId)
    }
    readTopicIds = newRead
    setReadTopics([...newRead])
  }

  async function toggleTopic(topicId: number) {
    if (expandedTopics.has(topicId)) {
      expandedTopics.delete(topicId)
      expandedTopics = expandedTopics
      return
    }
    expandedTopics.set(topicId, 'loading')
    expandedTopics = expandedTopics
    try {
      const articles = await getTopicArticles(topicId)
      expandedTopics.set(topicId, articles)
    } catch {
      expandedTopics.delete(topicId)
    }
    expandedTopics = expandedTopics
  }

  async function handleRegenerate() {
    if (regenerating) return
    regenerating = true
    try {
      await requestFrontPage()
    } catch {
      regenerating = false
    }
  }

  function setOverlay(topicId: number, state: UnmergeOverlay | null) {
    if (state === null) unmergeOverlays.delete(topicId)
    else unmergeOverlays.set(topicId, state)
    unmergeOverlays = unmergeOverlays
  }

  function hasBlockingOverlay(): boolean {
    for (const s of unmergeOverlays.values()) {
      if (s.phase === 'pending' || s.phase === 'done' || s.phase === 'error') return true
    }
    return false
  }

  function applyFreshPage(p: FrontPage) {
    page = p
    readTopicIds = new Set(p.readTopicIds)
    hiddenReadTopicIds = new Set(p.readTopicIds)
    expandedTopics = new Map()
    frontPageCache.set(p)
  }

  function startUnmergeConfirm(topicId: number) {
    if (unmergeOverlays.has(topicId)) return
    setOverlay(topicId, { phase: 'confirm' })
  }

  function cancelUnmergeConfirm(topicId: number) {
    setOverlay(topicId, null)
  }

  async function confirmUnmerge(topicId: number) {
    setOverlay(topicId, { phase: 'pending' })
    try {
      await startUnmerge(topicId)
    } catch (err) {
      setOverlay(topicId, { phase: 'error', error: String(err) })
      return
    }
    let networkFails = 0
    while (true) {
      try {
        const r = await pollUnmergeResult(topicId, 30)
        if (r.status === 'done') {
          setOverlay(topicId, { phase: 'done', newTopics: r.newTopics ?? [] })
          return
        }
        if (r.status === 'error') {
          setOverlay(topicId, { phase: 'error', error: r.error ?? 'unmerge failed' })
          return
        }
        networkFails = 0
      } catch {
        networkFails++
        if (networkFails > 5) {
          setOverlay(topicId, { phase: 'error', error: 'lost connection' })
          return
        }
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
  }

  function dismissOverlay(topicId: number) {
    const overlay = unmergeOverlays.get(topicId)
    setOverlay(topicId, null)
    if (!hasBlockingOverlay() && pendingFreshPage) {
      if (overlay?.phase === 'done' && overlay.newTopics?.length) {
        const oldCard = document.querySelector(`[data-topic-id="${topicId}"]`) as HTMLElement | null
        if (oldCard) {
          const oldHeight = oldCard.offsetHeight
          const n = overlay.newTopics.length
          // Between adjacent cards in the column there's gap-4 + read-line divider + gap-4 ≈ 53px;
          // shrinking each new card by that share keeps card_{k+1}'s start position unchanged.
          const perCardStart = Math.max(0, (oldHeight - (n - 1) * 53) / n)
          const heights = new Map<number, number>()
          for (const t of overlay.newTopics) heights.set(t.id, perCardStart)
          expandingNewCards = heights
        }
      }
      applyFreshPage(pendingFreshPage)
      pendingFreshPage = null
    }
  }

  function swapInFromHeight(node: HTMLElement, params: { fromHeight: number | undefined }) {
    const fromHeight = params.fromHeight
    if (fromHeight == null || fromHeight <= 0) return { duration: 0 }
    const target = node.offsetHeight
    return {
      duration: 450,
      easing: cubicOut,
      css: (t: number) => `height: ${fromHeight + (target - fromHeight) * t}px; overflow: hidden;`
    }
  }

  async function handleUngroup(topicId: number, articleId: number) {
    ungroupingArticles.add(articleId)
    ungroupingArticles = ungroupingArticles
    try {
      await ungroupArticle(topicId, articleId)
      expandedTopics.delete(topicId)
      expandedTopics = expandedTopics
      page = await getFrontPage()
      if (page) {
        readTopicIds = new Set(page.readTopicIds)
        hiddenReadTopicIds = new Set(page.readTopicIds)
        frontPageCache.set(page)
      }
    } catch {
      ungroupingArticles.delete(articleId)
      ungroupingArticles = ungroupingArticles
    }
  }

</script>

{#if loading}
  <p class="text-stone-400 dark:text-stone-500 text-center mt-20">Loading your front page...</p>
{:else if error}
  <p class="text-red-500 dark:text-red-400 text-center mt-20">{error}</p>
{:else if !page}
  <div class="text-center mt-20 text-stone-500 dark:text-stone-400">
    <p class="text-lg font-serif">No front page yet.</p>
    <p class="text-sm mt-2">Check back after some RSS feeds have been processed.</p>
  </div>
{:else}
  <div class="max-w-3xl mx-auto">
    <div class="mb-8 border-b border-stone-200 dark:border-stone-800 pb-2 flex items-center justify-between gap-4">
      <p class="text-xs text-stone-400 dark:text-stone-500 uppercase tracking-widest">
        {new Date(page.generatedAt).toLocaleString()}
      </p>
      <button
        onclick={handleRegenerate}
        disabled={regenerating}
        class="text-xs text-stone-400 dark:text-stone-500 uppercase tracking-widest hover:text-stone-600 dark:hover:text-stone-300 transition-colors flex items-center gap-1.5 disabled:cursor-not-allowed"
        title="Generate a new front page now"
      >
        <RefreshCw size={12} class={regenerating ? 'animate-spin' : ''} />
        {regenerating ? 'Generating' : 'Refresh'}
      </button>
    </div>

    <div class="flex flex-col gap-4">
    {#each visibleSections as section, i (section.topicId)}
      {@const isRead = readTopicIds.has(section.topicId)}
      {@const topicVote = section.articleIds.map(id => votes.get(id)).find(v => v !== undefined)}
      {@const isMorphing = $morphingTopicId === section.topicId}
      {@const overlay = unmergeOverlays.get(section.topicId)}
      <div
        data-topic-id={section.topicId}
        in:swapInFromHeight={{ fromHeight: expandingNewCards.get(section.topicId) }}
        class="relative bg-white dark:bg-stone-900 p-5 rounded-xl shadow-md hover:shadow-lg hover:-translate-y-0.5 transition-all duration-200 {isRead && !overlay ? 'opacity-50' : ''}"
        style={isMorphing ? 'view-transition-name: topic-card' : ''}
      >
        <div class="flex gap-3">
          <a
            href={`/topics/${section.topicId}`}
            onclick={() => morphSnapshot.set({ topicId: section.topicId, title: section.headline, summary: section.summary })}
            class="flex-1 min-w-0 group cursor-pointer"
          >
            <h2
              class="font-serif text-lg font-bold leading-tight mb-1 group-hover:underline decoration-stone-300 dark:decoration-stone-600 underline-offset-2"
              style={isMorphing ? 'view-transition-name: topic-title' : ''}
            >{section.headline}</h2>
            {#if section.topicTitle !== section.headline}
              <p class="text-xs text-stone-400 dark:text-stone-500 uppercase tracking-wide mb-1">{section.topicTitle}</p>
            {/if}
            <p
              class="text-sm text-stone-700 dark:text-stone-300 leading-relaxed"
              style={isMorphing ? 'view-transition-name: topic-summary' : ''}
            >{section.summary}</p>
            {#if (section.bullets?.length ?? 0) + (section.newInfo?.length ?? 0) > 0}
              <ul class="mt-3 space-y-1 list-disc list-inside text-sm text-stone-700 dark:text-stone-300 leading-relaxed">
                {#each section.newInfo ?? [] as item}
                  <li><strong class="text-amber-600 dark:text-amber-400">NEW:</strong> {item}</li>
                {/each}
                {#each section.bullets ?? [] as item}
                  <li>{item}</li>
                {/each}
              </ul>
            {/if}
          </a>
          <!-- TODO: this column is getting crowded; consider an overflow menu once we add another action. -->
          <div class="flex flex-col gap-2 items-center shrink-0 pt-0.5">
            <button
              onclick={() => toggleRead(section.topicId)}
              class="transition-all hover:scale-110 {isRead ? 'text-amber-500 dark:text-amber-400' : 'text-stone-400 dark:text-stone-600'}"
              title={isRead ? 'Mark as unread' : 'Mark as read'}
            >{#if isRead}<CircleCheck size={18} />{:else}<Circle size={18} />{/if}</button>
            <button
              onclick={() => handleTopicVote(section.articleIds, 1)}
              class="transition-all hover:scale-110 {topicVote === 1 ? 'text-amber-500 dark:text-amber-400' : 'text-stone-400 dark:text-stone-600'}"
              title="Interesting"
            ><ThumbsUp size={18} /></button>
            <button
              onclick={() => handleTopicVote(section.articleIds, -1)}
              class="transition-all hover:scale-110 {topicVote === -1 ? 'text-amber-500 dark:text-amber-400' : 'text-stone-400 dark:text-stone-600'}"
              title="Not interested"
            ><ThumbsDown size={18} /></button>
            <!-- articleIds counts signals, not articles, so it isn't a reliable article-count signal here.
                 Always show the button; backend rejects single-article topics. -->
            <button
              onclick={() => startUnmergeConfirm(section.topicId)}
              disabled={!!overlay}
              class="transition-all hover:scale-110 text-stone-400 dark:text-stone-600 hover:text-amber-500 dark:hover:text-amber-400 disabled:opacity-40 disabled:cursor-not-allowed"
              title="Split this topic into separate topics"
            ><Split size={18} /></button>
          </div>
        </div>

        {#if expandedTopics.get(section.topicId) === 'loading'}
          <button
            onclick={() => toggleTopic(section.topicId)}
            class="mt-2 text-xs text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 transition-colors flex items-center gap-1"
          >Loading...</button>
        {:else if expandedTopics.has(section.topicId)}
          <button
            onclick={() => toggleTopic(section.topicId)}
            class="mt-2 text-xs text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 transition-colors flex items-center gap-1"
          ><span class="transition-transform rotate-90">▶</span> Hide sources</button>
          {@const articles = expandedTopics.get(section.topicId)}
          {#if Array.isArray(articles)}
            <div class="mt-3 border-t border-stone-100 dark:border-stone-800 pt-3 space-y-2">
              {#each articles as article}
                {@const isUngrouping = ungroupingArticles.has(article.id)}
                <div class="text-sm flex items-start gap-2 transition-opacity duration-300 {isUngrouping ? 'opacity-30' : ''}">
                  <div class="flex-1 min-w-0">
                    <a
                      href={article.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="font-medium text-stone-800 dark:text-stone-200 hover:underline leading-snug block"
                    >{article.title}</a>
                    <span class="text-xs text-stone-400 dark:text-stone-500">{article.source} · {timeAgo(article.fetchedAt)}</span>
                  </div>
                  {#if !isUngrouping}
                    <button
                      onclick={() => handleUngroup(section.topicId, article.id)}
                      class="text-stone-300 dark:text-stone-600 hover:text-amber-500 dark:hover:text-amber-400 transition-colors shrink-0 mt-0.5"
                      title="Ungroup from this topic"
                    ><Unlink2 size={14} /></button>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        {:else}
          <button
            onclick={() => toggleTopic(section.topicId)}
            class="mt-2 text-xs text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 transition-colors flex items-center gap-1"
          ><span class="transition-transform">▶</span> {section.articleIds.length} source{section.articleIds.length === 1 ? '' : 's'}</button>
        {/if}

        {#if overlay?.phase === 'confirm'}
          <div
            class="absolute inset-0 flex rounded-xl overflow-hidden z-10"
            transition:fade={{ duration: 150 }}
          >
            <button
              onclick={() => confirmUnmerge(section.topicId)}
              class="flex-1 bg-green-500/60 hover:bg-green-500/80 flex items-center justify-center transition-colors"
              aria-label="Confirm unmerge"
            ><ThumbsUp size={64} class="text-white drop-shadow" /></button>
            <button
              onclick={() => cancelUnmergeConfirm(section.topicId)}
              class="flex-1 bg-red-500/60 hover:bg-red-500/80 flex items-center justify-center transition-colors"
              aria-label="Cancel"
            ><ThumbsDown size={64} class="text-white drop-shadow" /></button>
            <h3 class="absolute top-4 left-0 right-0 text-center font-serif text-xl font-bold text-white drop-shadow-md pointer-events-none">
              Split topic?
            </h3>
          </div>
        {:else if overlay?.phase === 'pending'}
          <div
            class="absolute inset-0 bg-yellow-400/70 rounded-xl flex flex-col items-center justify-center z-10"
            transition:fade={{ duration: 150 }}
          >
            <h3 class="font-serif text-xl font-bold text-white drop-shadow-md mb-3">Splitting topic…</h3>
            <Loader2 size={56} class="animate-spin text-white drop-shadow" />
          </div>
        {:else if overlay?.phase === 'done'}
          <button
            onclick={() => dismissOverlay(section.topicId)}
            class="absolute inset-0 bg-green-500/75 rounded-xl flex flex-col items-center justify-center z-10 px-5 py-6 cursor-pointer"
            transition:fade={{ duration: 150 }}
            aria-label="Dismiss"
          >
            <h3 class="font-serif text-xl font-bold text-white drop-shadow-md mb-3">Split into:</h3>
            <ul class="space-y-1.5 text-white text-base font-medium text-center max-w-full">
              {#each overlay.newTopics ?? [] as nt}
                <li class="leading-snug">{nt.title}</li>
              {/each}
            </ul>
            <p class="absolute bottom-2 left-0 right-0 text-center text-[10px] uppercase tracking-widest text-white/80">Tap to dismiss</p>
          </button>
        {:else if overlay?.phase === 'error'}
          <button
            onclick={() => dismissOverlay(section.topicId)}
            class="absolute inset-0 bg-red-500/75 rounded-xl flex flex-col items-center justify-center z-10 px-5 py-6 cursor-pointer"
            transition:fade={{ duration: 150 }}
            aria-label="Dismiss"
          >
            <h3 class="font-serif text-xl font-bold text-white drop-shadow-md mb-1">Split failed</h3>
            <p class="text-white text-sm">{overlay.error ?? 'unknown error'}</p>
            <p class="absolute bottom-2 left-0 right-0 text-center text-[10px] uppercase tracking-widest text-white/80">Tap to dismiss</p>
          </button>
        {/if}
      </div>

      <!-- Read line divider -->
      <div class="flex items-center opacity-40 hover:opacity-100 transition-opacity">
        <button
          onclick={() => markReadAtPosition(i)}
          class="w-full text-center text-xs text-stone-300 dark:text-stone-600 hover:text-blue-500 dark:hover:text-blue-400 cursor-pointer py-1 transition-colors flex items-center justify-center gap-1"
        >
          <CheckCheck size={13} />mark above as read
        </button>
      </div>
    {/each}
    </div>
  </div>
{/if}
