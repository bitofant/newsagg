<script lang="ts">
  import { onMount } from 'svelte'
  import { goto } from '$app/navigation'
  import { login, register } from '$lib/api'

  let email = ''
  let password = ''
  let mode: 'login' | 'register' = 'login'
  let error = ''
  let loading = false
  let registrationEnabled = false

  onMount(async () => {
    const res = await fetch('/api/registration-enabled')
    if (res.ok) {
      const data = await res.json()
      registrationEnabled = data.enabled
    }
  })

  async function submit() {
    error = ''
    loading = true
    try {
      if (mode === 'login') {
        await login(email, password)
      } else {
        await register(email, password)
      }
      goto('/')
    } catch (e) {
      error = String(e)
    } finally {
      loading = false
    }
  }
</script>

<div class="max-w-sm mx-auto mt-20">
  <h1 class="font-serif text-3xl font-bold mb-6 text-center">
    {mode === 'login' ? 'Sign in' : 'Create account'}
  </h1>

  <form onsubmit={(e) => { e.preventDefault(); submit() }} class="space-y-4">
    <div>
      <label class="block text-sm font-medium mb-1" for="email">Email</label>
      <input
        id="email"
        type="email"
        bind:value={email}
        required
        class="w-full border border-stone-300 dark:border-stone-700 rounded px-3 py-2 text-sm bg-white dark:bg-stone-800 dark:text-stone-100 focus:outline-none focus:ring-2 focus:ring-stone-400 dark:focus:ring-stone-500"
      />
    </div>
    <div>
      <label class="block text-sm font-medium mb-1" for="password">Password</label>
      <input
        id="password"
        type="password"
        bind:value={password}
        required
        class="w-full border border-stone-300 dark:border-stone-700 rounded px-3 py-2 text-sm bg-white dark:bg-stone-800 dark:text-stone-100 focus:outline-none focus:ring-2 focus:ring-stone-400 dark:focus:ring-stone-500"
      />
    </div>

    {#if error}
      <p class="text-red-500 dark:text-red-400 text-sm">{error}</p>
    {/if}

    <button
      type="submit"
      disabled={loading}
      class="w-full bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 rounded py-2 text-sm font-medium hover:bg-stone-700 dark:hover:bg-stone-300 disabled:opacity-50"
    >
      {loading ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
    </button>
  </form>

  {#if registrationEnabled}
  <p class="text-center text-sm text-stone-500 dark:text-stone-400 mt-4">
    {#if mode === 'login'}
      No account? <button onclick={() => (mode = 'register')} class="underline">Register</button>
    {:else}
      Already have an account? <button onclick={() => (mode = 'login')} class="underline">Sign in</button>
    {/if}
  </p>
  {/if}
</div>
