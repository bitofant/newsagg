<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { goto } from '$app/navigation'
  import { isLoggedIn, getFrontPage, vote, subscribeToFrontPage } from '$lib/api'
  import type { FrontPage } from '$lib/api'

  let page: FrontPage | null = null
  let loading = true
  let error = ''
  let unsubscribe: (() => void) | null = null

  onMount(async () => {
    if (!isLoggedIn()) {
      goto('/login')
      return
    }
    try {
      page = await getFrontPage()
    } catch (e) {
      error = String(e)
    } finally {
      loading = false
    }

    unsubscribe = subscribeToFrontPage(async () => {
      try { page = await getFrontPage() } catch { /* keep old page */ }
    })
  })

  onDestroy(() => unsubscribe?.())

  async function handleVote(articleId: number, v: 1 | -1) {
    await vote(articleId, v)
  }
</script>

{#if loading}
  <p class="text-stone-400 text-center mt-20">Loading your front page…</p>
{:else if error}
  <p class="text-red-500 text-center mt-20">{error}</p>
{:else if !page}
  <div class="text-center mt-20 text-stone-500">
    <p class="text-lg font-serif">No front page yet.</p>
    <p class="text-sm mt-2">Check back after some RSS feeds have been processed.</p>
  </div>
{:else}
  <div class="mb-6 border-b border-stone-300 pb-2">
    <p class="text-xs text-stone-400 uppercase tracking-widest">
      {new Date(page.generatedAt).toLocaleString()}
    </p>
  </div>

  <div class="columns-1 md:columns-2 lg:columns-3 gap-6 space-y-0">
    {#each page.sections as section}
      <div class="break-inside-avoid mb-6 border border-stone-200 bg-white p-4 rounded shadow-sm">
        <h2 class="font-serif text-xl font-bold leading-tight mb-1">{section.headline}</h2>
        <p class="text-xs text-stone-400 uppercase tracking-wide mb-2">{section.topicTitle}</p>
        <p class="text-sm text-stone-700 leading-relaxed">{section.summary}</p>
        <div class="mt-3 flex gap-3">
          {#each section.articleIds as articleId}
            <div class="flex gap-1">
              <button
                onclick={() => handleVote(articleId, 1)}
                class="text-lg hover:scale-110 transition-transform"
                title="Interesting"
              >👍</button>
              <button
                onclick={() => handleVote(articleId, -1)}
                class="text-lg hover:scale-110 transition-transform"
                title="Not interested"
              >👎</button>
            </div>
          {/each}
        </div>
      </div>
    {/each}
  </div>
{/if}
