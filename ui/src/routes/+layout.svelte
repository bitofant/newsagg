<script lang="ts">
  import '../app.css'
  import { tick } from 'svelte'
  import { isLoggedIn, logout } from '$lib/api'
  import { goto, onNavigate } from '$app/navigation'
  import { toggleTheme, getTheme } from '$lib/theme'
  import { morphingTopicId } from '$lib/transition'
  import { Menu, X, Sun, Moon, Settings, Activity, LogOut } from 'lucide-svelte'
  import { slide } from 'svelte/transition'

  onNavigate(async (navigation) => {
    const startViewTransition = (document as any).startViewTransition?.bind(document)
    if (!startViewTransition) {
      console.warn('[viewTransition] not supported by this browser')
      return
    }

    const fromMatch = navigation.from?.url.pathname.match(/^\/topics\/(\d+)/)
    const toMatch = navigation.to?.url.pathname.match(/^\/topics\/(\d+)/)
    if (toMatch) morphingTopicId.set(parseInt(toMatch[1], 10))
    else if (fromMatch) morphingTopicId.set(parseInt(fromMatch[1], 10))
    else morphingTopicId.set(null)

    // Let the front page re-render with view-transition-name applied
    // before the browser snapshots the old DOM.
    await tick()

    console.log('[viewTransition] starting, morphingTopicId=', toMatch?.[1] ?? fromMatch?.[1])
    return new Promise<void>((resolve) => {
      startViewTransition(async () => {
        resolve()
        await navigation.complete
      })
    })
  })

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
  <header class="border-b border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 menu-container">
    <div class="max-w-5xl mx-auto px-4">
      <div class="py-3 flex items-center justify-between">
        <a href="/" class="font-serif text-2xl font-bold tracking-tight">newsagg</a>
        <button onclick={() => menuOpen = !menuOpen} class="-m-3 p-4 text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100" title="Menu">
          {#if menuOpen}
            <X size={20} />
          {:else}
            <Menu size={20} />
          {/if}
        </button>
      </div>
      {#if menuOpen}
        <nav transition:slide={{ duration: 200 }} class="border-t border-stone-200 dark:border-stone-700 py-2">
          <button onclick={() => { handleToggleTheme(); menuOpen = false }} class="w-full flex items-center gap-3 px-2 py-3 text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100">
            {#if isDark}
              <Sun size={18} />
              <span>Light mode</span>
            {:else}
              <Moon size={18} />
              <span>Dark mode</span>
            {/if}
          </button>
          {#if isLoggedIn()}
            <a href="/settings" onclick={() => menuOpen = false} class="w-full flex items-center gap-3 px-2 py-3 text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100">
              <Settings size={18} />
              <span>Settings</span>
            </a>
          {/if}
          <a href="/status" onclick={() => menuOpen = false} class="w-full flex items-center gap-3 px-2 py-3 text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100">
            <Activity size={18} />
            <span>Status</span>
          </a>
          {#if isLoggedIn()}
            <button onclick={handleLogout} class="w-full flex items-center gap-3 px-2 py-3 text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100">
              <LogOut size={18} />
              <span>Sign out</span>
            </button>
          {/if}
        </nav>
      {/if}
    </div>
  </header>

  <main class="flex-1 max-w-5xl mx-auto w-full px-4 py-8">
    {@render children()}
  </main>
</div>
