<script lang="ts">
  import { onMount } from 'svelte'
  import { goto } from '$app/navigation'
  import { page } from '$app/state'
  import { isLoggedIn, getTopicDetail, vote, setTopicRead, ungroupArticle } from '$lib/api'
  import type { TopicDetail } from '$lib/api'
  import { timeAgo } from '$lib/time'
  import { morphSnapshot } from '$lib/transition'
  import { ArrowLeft, ThumbsUp, ThumbsDown, CircleCheck, Circle, Unlink2 } from 'lucide-svelte'

  let topic = $state<TopicDetail | null>(null)
  let loading = $state(true)
  let error = $state('')
  let votes = $state(new Map<number, 1 | -1>())
  let ungroupingArticles = $state(new Set<number>())

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

    <article class="mt-6" style="view-transition-name: topic-card">
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
    </article>
  </div>
{/if}
