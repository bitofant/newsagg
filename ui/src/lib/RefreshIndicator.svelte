<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { fade } from 'svelte/transition'

  let {
    cycleStartedAt,
    cycleEndedAt,
    lastError = false,
    cycleMs,
    fillMs = 2000,
  }: {
    cycleStartedAt: number | null
    cycleEndedAt: number | null
    lastError?: boolean
    cycleMs: number
    fillMs?: number
  } = $props()

  type Color = 'blue' | 'orange' | 'green' | 'red'
  type Snapshot = { id: number; color: Color; progress: number }

  // When color changes or progress jumps by more than this, push a fresh snapshot
  // so the old one fades out independently while the new one fades in. Otherwise
  // we mutate the live snapshot's progress for smooth per-frame tweening.
  const SNAP_DELTA = 0.2
  const FADE_MS = 300

  let snapshots = $state<Snapshot[]>([])
  let nextId = 0
  let raf: number | null = null

  function computeState(): { color: Color; progress: number } {
    const t = Date.now()
    if (cycleStartedAt == null) return { color: 'blue', progress: 0 }
    if (cycleEndedAt == null) {
      const elapsed = t - cycleStartedAt
      if (elapsed < fillMs) return { color: 'blue', progress: elapsed / fillMs }
      return { color: 'orange', progress: 1 }
    }
    const cycleEnd = cycleStartedAt + cycleMs
    const drainTotal = Math.max(1, cycleEnd - cycleEndedAt)
    const drainElapsed = t - cycleEndedAt
    return {
      color: lastError ? 'red' : 'green',
      progress: Math.max(0, 1 - drainElapsed / drainTotal),
    }
  }

  onMount(() => {
    const init = computeState()
    snapshots = [{ id: nextId++, color: init.color, progress: init.progress }]
    const loop = () => {
      const state = computeState()
      const live = snapshots[snapshots.length - 1]
      const jump = live.color !== state.color || Math.abs(live.progress - state.progress) > SNAP_DELTA
      if (jump) {
        snapshots = [{ id: nextId++, color: state.color, progress: state.progress }]
      } else {
        live.progress = state.progress
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
  })

  onDestroy(() => {
    if (raf) cancelAnimationFrame(raf)
  })

  const r = 9
  const c = 2 * Math.PI * r
</script>

<div class="relative h-6 w-6">
  {#each snapshots as snap (snap.id)}
    <svg
      viewBox="0 0 24 24"
      class="absolute inset-0 h-6 w-6 -rotate-90"
      class:text-blue-500={snap.color === 'blue'}
      class:text-orange-500={snap.color === 'orange'}
      class:text-green-600={snap.color === 'green'}
      class:text-red-500={snap.color === 'red'}
      in:fade={{ duration: FADE_MS }}
      out:fade={{ duration: FADE_MS }}
    >
      <circle cx="12" cy="12" r={r} fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="2" />
      <circle
        cx="12"
        cy="12"
        r={r}
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-dasharray={c}
        stroke-dashoffset={c * (1 - snap.progress)}
      />
    </svg>
  {/each}
</div>
