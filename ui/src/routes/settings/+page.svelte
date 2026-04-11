<script lang="ts">
  import { onMount } from 'svelte'
  import { goto } from '$app/navigation'
  import { isLoggedIn, getPreferences, updatePreferences } from '$lib/api'

  const INTERVAL_OPTIONS = [
    { label: '5 minutes', value: 5 * 60 * 1000 },
    { label: '15 minutes', value: 15 * 60 * 1000 },
    { label: '30 minutes', value: 30 * 60 * 1000 },
    { label: '1 hour', value: 60 * 60 * 1000 },
    { label: '2 hours', value: 2 * 60 * 60 * 1000 },
    { label: '4 hours', value: 4 * 60 * 60 * 1000 },
  ]

  let intervalMs = $state(15 * 60 * 1000)
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
      await updatePreferences({ intervalMs })
      message = 'Saved.'
    } catch (e) {
      message = String(e)
    } finally {
      saving = false
    }
  }
</script>

<div class="max-w-md">
  <a href="/" class="text-sm text-stone-500 hover:text-stone-900">&larr; back</a>
  <h1 class="font-serif text-2xl font-bold mt-4 mb-6">Settings</h1>

  {#if loading}
    <p class="text-stone-400">Loading...</p>
  {:else}
    <label for="interval" class="block text-sm font-medium text-stone-700 mb-2">
      Generate front page every:
    </label>
    <select
      id="interval"
      bind:value={intervalMs}
      class="block w-full border border-stone-300 rounded px-3 py-2 text-sm bg-white"
    >
      {#each INTERVAL_OPTIONS as opt}
        <option value={opt.value}>{opt.label}</option>
      {/each}
    </select>

    <button
      onclick={save}
      disabled={saving}
      class="mt-4 px-4 py-2 bg-stone-800 text-white text-sm rounded hover:bg-stone-700 disabled:opacity-50"
    >
      {saving ? 'Saving...' : 'Save'}
    </button>

    {#if message}
      <p class="mt-3 text-sm {message === 'Saved.' ? 'text-green-600' : 'text-red-500'}">{message}</p>
    {/if}
  {/if}
</div>
