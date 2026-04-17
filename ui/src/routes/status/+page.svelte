<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { getStatus, type Status } from '$lib/api'

  const REFRESH_MS = 5000

  let status = $state<Status | null>(null)
  let error = $state('')
  let timer: ReturnType<typeof setInterval> | null = null

  async function refresh() {
    try {
      status = await getStatus()
      error = ''
    } catch (e) {
      error = String(e)
    }
  }

  onMount(() => {
    refresh()
    timer = setInterval(refresh, REFRESH_MS)
  })

  onDestroy(() => {
    if (timer) clearInterval(timer)
  })

  function formatRelative(ts: number | null): string {
    if (ts == null) return 'never'
    const diff = Date.now() - ts
    if (diff < 0) return 'in the future'
    const s = Math.floor(diff / 1000)
    if (s < 60) return `${s}s ago`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ago`
    return `${Math.floor(h / 24)}d ago`
  }

  function formatDuration(ms: number): string {
    const s = Math.floor(ms / 1000)
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h`
    return `${Math.floor(h / 24)}d`
  }
</script>

<div class="max-w-3xl">
  <h1 class="font-serif text-2xl font-bold mb-6">Status</h1>

  {#if error}
    <p class="text-red-500 dark:text-red-400 text-sm mb-4">{error}</p>
  {/if}

  {#if !status}
    <p class="text-stone-400 dark:text-stone-500">Loading...</p>
  {:else}
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
      <div class="bg-white dark:bg-stone-900 rounded-xl shadow-sm p-5">
        <h2 class="text-xs uppercase tracking-wide text-stone-500 dark:text-stone-400 mb-3">Consolidator</h2>
        <div class="flex items-baseline justify-between mb-1">
          <span class="text-sm text-stone-600 dark:text-stone-300">Buffer depth</span>
          <span class="font-mono text-2xl font-semibold {status.consolidator.bufferDepth > 20 ? 'text-amber-600 dark:text-amber-400' : ''}">
            {status.consolidator.bufferDepth}
          </span>
        </div>
        <div class="flex items-baseline justify-between">
          <span class="text-sm text-stone-600 dark:text-stone-300">Processing</span>
          <span class="text-sm font-medium {status.consolidator.processing ? 'text-green-600 dark:text-green-400' : 'text-stone-400 dark:text-stone-500'}">
            {status.consolidator.processing ? 'yes' : 'idle'}
          </span>
        </div>
      </div>

      <div class="bg-white dark:bg-stone-900 rounded-xl shadow-sm p-5">
        <h2 class="text-xs uppercase tracking-wide text-stone-500 dark:text-stone-400 mb-3">Aggregator</h2>
        <div class="flex items-baseline justify-between mb-1">
          <span class="text-sm text-stone-600 dark:text-stone-300">Queue length</span>
          <span class="font-mono text-2xl font-semibold">{status.aggregator.queueLength}</span>
        </div>
        <div class="flex items-baseline justify-between">
          <span class="text-sm text-stone-600 dark:text-stone-300">Active workers</span>
          <span class="font-mono text-2xl font-semibold">{status.aggregator.activeWorkers}</span>
        </div>
      </div>

      <div class="bg-white dark:bg-stone-900 rounded-xl shadow-sm p-5 sm:col-span-2">
        <h2 class="text-xs uppercase tracking-wide text-stone-500 dark:text-stone-400 mb-3">Database</h2>
        <div class="flex gap-8">
          <div>
            <div class="text-sm text-stone-600 dark:text-stone-300">Topics</div>
            <div class="font-mono text-2xl font-semibold">{status.db.topicCount}</div>
          </div>
          <div>
            <div class="text-sm text-stone-600 dark:text-stone-300">Articles</div>
            <div class="font-mono text-2xl font-semibold">{status.db.totalArticles}</div>
          </div>
        </div>
      </div>
    </div>

    <div class="bg-white dark:bg-stone-900 rounded-xl shadow-sm p-5">
      <h2 class="text-xs uppercase tracking-wide text-stone-500 dark:text-stone-400 mb-3">Users</h2>
      {#if status.users.length === 0}
        <p class="text-sm text-stone-400 dark:text-stone-500">No users.</p>
      {:else}
        <div class="space-y-3">
          {#each status.users as user (user.id)}
            <div class="flex items-center justify-between border-t border-stone-200 dark:border-stone-800 pt-3 first:border-0 first:pt-0">
              <div>
                <div class="text-sm font-medium">{user.email}</div>
                <div class="text-xs text-stone-500 dark:text-stone-400">
                  interval {formatDuration(user.intervalMs)} · last front page {formatRelative(user.lastFrontPageAt)} · {user.recentSignalCount} signals (14d)
                </div>
              </div>
              <div class="text-right">
                {#if user.overdueBy === 0}
                  <span class="text-sm text-green-600 dark:text-green-400">on schedule</span>
                {:else if user.overdueBy == null}
                  <span class="text-sm text-stone-400 dark:text-stone-500">never run</span>
                {:else}
                  <span class="text-sm text-amber-600 dark:text-amber-400">overdue by {formatDuration(user.overdueBy)}</span>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <p class="mt-6 text-xs text-stone-400 dark:text-stone-500">
      Auto-refreshes every {REFRESH_MS / 1000}s · last update {formatRelative(status.timestamp)}
    </p>
  {/if}
</div>
