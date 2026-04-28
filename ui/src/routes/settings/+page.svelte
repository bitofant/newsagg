<script lang="ts">
  import { onMount } from 'svelte'
  import { goto } from '$app/navigation'
  import { isLoggedIn, getPreferences, updatePreferences } from '$lib/api'
  import { timeAgo } from '$lib/time'

  const INTERVAL_OPTIONS = [
    { label: '5 minutes', value: 5 * 60 * 1000 },
    { label: '15 minutes', value: 15 * 60 * 1000 },
    { label: '30 minutes', value: 30 * 60 * 1000 },
    { label: '1 hour', value: 60 * 60 * 1000 },
    { label: '2 hours', value: 2 * 60 * 60 * 1000 },
    { label: '4 hours', value: 4 * 60 * 60 * 1000 },
  ]

  let intervalMs = $state(15 * 60 * 1000)
  let manualPreferences = $state('')
  let preferenceProfile = $state('')
  let preferenceGeneratedAt = $state<number | null>(null)
  let loading = $state(true)
  let saving = $state(false)
  let message = $state('')

  onMount(async () => {
    if (!isLoggedIn()) {
      goto('/login')
      return
    }
    try {
      const prefs = await getPreferences()
      intervalMs = prefs.intervalMs
      manualPreferences = prefs.manualPreferences ?? ''
      preferenceProfile = prefs.preferenceProfile ?? ''
      preferenceGeneratedAt = prefs.preferenceGeneratedAt
    } catch (e) {
      message = `Failed to load: ${e}`
    } finally {
      loading = false
    }
  })

  async function save() {
    saving = true
    message = ''
    try {
      const prefs = await updatePreferences({ intervalMs, manualPreferences })
      manualPreferences = prefs.manualPreferences ?? ''
      preferenceProfile = prefs.preferenceProfile ?? ''
      preferenceGeneratedAt = prefs.preferenceGeneratedAt
      message = 'Saved.'
    } catch (e) {
      message = String(e)
    } finally {
      saving = false
    }
  }
</script>

<div class="max-w-md">
  <a href="/" class="text-sm text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100">&larr; back</a>
  <h1 class="font-serif text-2xl font-bold mt-4 mb-6">Settings</h1>

  {#if loading}
    <p class="text-stone-400 dark:text-stone-500">Loading...</p>
  {:else}
    <label for="interval" class="block text-sm font-medium text-stone-700 dark:text-stone-300 mb-2">
      Generate front page every:
    </label>
    <select
      id="interval"
      bind:value={intervalMs}
      class="block w-full border border-stone-300 dark:border-stone-700 rounded px-3 py-2 text-sm bg-white dark:bg-stone-800 dark:text-stone-100"
    >
      {#each INTERVAL_OPTIONS as opt}
        <option value={opt.value}>{opt.label}</option>
      {/each}
    </select>

    <label for="manual" class="block text-sm font-medium text-stone-700 dark:text-stone-300 mb-2 mt-6">
      Your preferences
    </label>
    <p class="text-xs text-stone-500 dark:text-stone-400 mb-2">
      Tell the system what you want to see. Treated as authoritative — never overwritten.
    </p>
    <textarea
      id="manual"
      bind:value={manualPreferences}
      rows="8"
      class="block w-full border border-stone-300 dark:border-stone-700 rounded px-3 py-2 text-sm bg-white dark:bg-stone-800 dark:text-stone-100 font-mono"
      placeholder="e.g. Lots of climate policy. No celebrity gossip. Prefer EU politics over US."
    ></textarea>

    <label for="generated" class="block text-sm font-medium text-stone-700 dark:text-stone-300 mb-2 mt-6">
      Preferences program
    </label>
    <p class="text-xs text-stone-500 dark:text-stone-400 mb-2">
      {#if preferenceGeneratedAt}
        A bullet program (Follow / Skip) inferred from your votes plus the preferences above. Updated {timeAgo(preferenceGeneratedAt)}.
      {:else}
        Will be generated after you vote on a few articles or save preferences above.
      {/if}
    </p>
    <textarea
      id="generated"
      value={preferenceProfile}
      readonly
      rows="10"
      class="block w-full border border-stone-300 dark:border-stone-700 rounded px-3 py-2 text-sm bg-stone-100 dark:bg-stone-900 dark:text-stone-100 font-mono opacity-70 cursor-not-allowed"
      placeholder="(empty)"
    ></textarea>

    <button
      onclick={save}
      disabled={saving}
      class="mt-4 px-4 py-2 bg-stone-800 dark:bg-stone-100 text-white dark:text-stone-900 text-sm rounded hover:bg-stone-700 dark:hover:bg-stone-300 disabled:opacity-50"
    >
      {saving ? 'Saving...' : 'Save'}
    </button>

    {#if message}
      <p class="mt-3 text-sm {message === 'Saved.' ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}">{message}</p>
    {/if}
  {/if}
</div>
