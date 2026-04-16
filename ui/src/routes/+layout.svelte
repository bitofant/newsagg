<script lang="ts">
  import '../app.css'
  import { isLoggedIn, logout } from '$lib/api'
  import { goto } from '$app/navigation'
  import { toggleTheme, getTheme } from '$lib/theme'

  let { children } = $props()
  let isDark = $state(false)

  function handleToggleTheme() {
    toggleTheme()
    isDark = getTheme() === 'dark'
  }

  function handleLogout() {
    logout()
    goto('/login')
  }

  $effect(() => {
    isDark = getTheme() === 'dark'
  })
</script>

<div class="min-h-screen flex flex-col bg-stone-50 dark:bg-stone-950">
  <header class="border-b border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900">
    <div class="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
      <a href="/" class="font-serif text-2xl font-bold tracking-tight">newsagg</a>
      <div class="flex items-center gap-4">
        <button onclick={handleToggleTheme} class="text-sm text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100" title="Toggle theme">
          {isDark ? '☀️' : '🌙'}
        </button>
        {#if isLoggedIn()}
          <a href="/settings" class="text-sm text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100">settings</a>
          <button onclick={handleLogout} class="text-sm text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100">
            sign out
          </button>
        {/if}
      </div>
    </div>
  </header>

  <main class="flex-1 max-w-5xl mx-auto w-full px-4 py-8">
    {@render children()}
  </main>
</div>
