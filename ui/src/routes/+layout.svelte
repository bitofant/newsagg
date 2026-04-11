<script lang="ts">
  import '../app.css'
  import { isLoggedIn, logout } from '$lib/api'
  import { goto } from '$app/navigation'

  function handleLogout() {
    logout()
    goto('/login')
  }
</script>

<div class="min-h-screen flex flex-col">
  <header class="border-b border-stone-300 bg-white">
    <div class="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
      <a href="/" class="font-serif text-2xl font-bold tracking-tight">newsagg</a>
      {#if isLoggedIn()}
        <div class="flex items-center gap-4">
          <a href="/settings" class="text-sm text-stone-500 hover:text-stone-900">settings</a>
          <button onclick={handleLogout} class="text-sm text-stone-500 hover:text-stone-900">
            sign out
          </button>
        </div>
      {/if}
    </div>
  </header>

  <main class="flex-1 max-w-5xl mx-auto w-full px-4 py-6">
    <slot />
  </main>
</div>
