<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { goto } from '$app/navigation'
  import { isLoggedIn, getFrontPage, vote, subscribeToFrontPage, setReadTopics, getTopicArticles, ungroupArticle } from '$lib/api'
  import type { FrontPage, TopicArticle } from '$lib/api'
  import { timeAgo } from '$lib/time'
  import { ThumbsUp, ThumbsDown, CheckCheck, CircleCheck, Circle, Unlink2 } from 'lucide-svelte'

  let page: FrontPage | null = null
  let loading = true
  let error = ''
  let unsubscribe: (() => void) | null = null
  let votes = new Map<number, 1 | -1>()
  let expandedTopics = new Map<number, TopicArticle[] | 'loading'>()
  let readTopicIds = new Set<number>()
  let ungroupingArticles = new Set<number>()

  $: sections = page?.sections ?? []

  onMount(async () => {
    if (!isLoggedIn()) {
      goto('/login')
      return
    }
    try {
      page = await getFrontPage()
      if (page) {
        readTopicIds = new Set(page.readTopicIds)
      }
    } catch (e) {
      error = String(e)
    } finally {
      loading = false
    }

    unsubscribe = subscribeToFrontPage(async () => {
      try {
        const newPage = await getFrontPage()
        if (newPage) {
          page = newPage
          readTopicIds = new Set(newPage.readTopicIds)
          expandedTopics = new Map()
        }
      } catch { /* keep old page */ }
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
    // Everything at indices 0..index becomes read
    // Everything below becomes unread (if it was previously read)
    const newRead = new Set<number>()
    for (let i = 0; i <= index; i++) {
      newRead.add(sections[i].topicId)
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

  async function handleUngroup(topicId: number, articleId: number) {
    ungroupingArticles.add(articleId)
    ungroupingArticles = ungroupingArticles
    try {
      await ungroupArticle(topicId, articleId)
      expandedTopics.delete(topicId)
      expandedTopics = expandedTopics
      page = await getFrontPage()
      if (page) readTopicIds = new Set(page.readTopicIds)
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
    <div class="mb-8 border-b border-stone-200 dark:border-stone-800 pb-2">
      <p class="text-xs text-stone-400 dark:text-stone-500 uppercase tracking-widest">
        {new Date(page.generatedAt).toLocaleString()}
      </p>
    </div>

    <div class="flex flex-col gap-4">
    {#each sections as section, i}
      {@const isRead = readTopicIds.has(section.topicId)}
      {@const topicVote = section.articleIds.map(id => votes.get(id)).find(v => v !== undefined)}
      <div class="bg-white dark:bg-stone-900 p-5 rounded-xl shadow-md hover:shadow-lg hover:-translate-y-0.5 transition-all duration-200 {isRead ? 'opacity-50' : ''}">
        <div class="flex gap-3">
          <a
            href={`/topics/${section.topicId}`}
            class="flex-1 min-w-0 group cursor-pointer"
          >
            <h2 class="font-serif text-lg font-bold leading-tight mb-1 group-hover:underline decoration-stone-300 dark:decoration-stone-600 underline-offset-2">{section.headline}</h2>
            {#if section.topicTitle !== section.headline}
              <p class="text-xs text-stone-400 dark:text-stone-500 uppercase tracking-wide mb-1">{section.topicTitle}</p>
            {/if}
            <p class="text-sm text-stone-700 dark:text-stone-300 leading-relaxed">{section.summary}</p>
          </a>
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
