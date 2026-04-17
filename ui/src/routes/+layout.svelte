<script lang="ts">
  import '../app.css'
  import { isLoggedIn, logout } from '$lib/api'
  import { goto } from '$app/navigation'
  import { toggleTheme, getTheme } from '$lib/theme'
  import { Menu, X } from 'lucide-svelte'

  let { children } = $props()
  let isDark = $state(false)
  let menuOpen = $state(false)

  function handleToggleTheme() {
    toggleTheme()
    isDark = getTheme() === 'dark'
  }

  function handleLogout() {
    menuOpen = false
    logout()
    goto('/login')
  }

  function closeMenu(e: MouseEvent) {
    const target = e.target as HTMLElement
    if (!target.closest('.menu-container')) {
      menuOpen = false
    }
  }

  $effect(() => {
    isDark = getTheme() === 'dark'
  })
</script>

<svelte:window onclick={closeMenu} />

<div class="min-h-screen flex flex-col bg-stone-50 dark:bg-stone-950">
  <header class="border-b border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900">
    <div class="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
      <a href="/" class="font-serif text-2xl font-bold tracking-tight">newsagg</a>
      <div class="relative menu-container">
        <button onclick={() => menuOpen = !menuOpen} class="p-1 text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100" title="Menu">
          {#if menuOpen}
            <X size={20} />
          {:else}
            <Menu size={20} />
          {/if}
        </button>
        {#if menuOpen}
          <div class="absolute right-0 top-full mt-2 w-48 bg-white dark:bg-stone-800 rounded-xl shadow-lg border border-stone-200 dark:border-stone-700 py-1 z-50">
            <button onclick={() => { handleToggleTheme(); menuOpen = false }} class="w-full text-left px-4 py-2 text-sm text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700">
              {isDark ? '☀️ Light mode' : '🌙 Dark mode'}
            </button>
            {#if isLoggedIn()}
              <a href="/settings" onclick={() => menuOpen = false} class="block px-4 py-2 text-sm text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700">
                Settings
              </a>
            {/if}
            <a href="/status" onclick={() => menuOpen = false} class="block px-4 py-2 text-sm text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700">
              Status
            </a>
            {#if isLoggedIn()}
              <div class="border-t border-stone-200 dark:border-stone-700 my-1"></div>
              <button onclick={handleLogout} class="w-full text-left px-4 py-2 text-sm text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700">
                Sign out
              </button>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </header>

  <main class="flex-1 max-w-5xl mx-auto w-full px-4 py-8">
    {@render children()}
  </main>
</div>
