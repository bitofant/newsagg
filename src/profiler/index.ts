import type { Db } from '../db/index.js'
import { getAi } from '../ai/index.js'

const DEBOUNCE_MS = 15 * 60 * 1000 // 15 minutes

export interface Profiler {
  onVote(userId: number): void
  onManualProfileChange(userId: number): void
  stop(): void
}

export function createProfiler({ db }: { db: Db }): Profiler {
  const timers = new Map<number, ReturnType<typeof setTimeout>>()

  function schedule(userId: number) {
    const existing = timers.get(userId)
    if (existing) clearTimeout(existing)
    timers.set(
      userId,
      setTimeout(() => {
        timers.delete(userId)
        generateProfile(userId).catch((err) =>
          console.error(`[profiler] failed to generate profile for user ${userId}:`, err),
        )
      }, DEBOUNCE_MS),
    )
  }

  async function generateProfile(userId: number) {
    const user = db.users.getUserById(userId)
    if (!user) return
    const manual = (user.manualPreferences ?? '').trim()
    const votes = db.users.getVotesWithContext(userId)

    if (manual.length === 0 && votes.length < 3) return // not enough signal yet

    const liked = votes.filter((v) => v.vote === 1)
    const disliked = votes.filter((v) => v.vote === -1)

    const formatVotes = (items: typeof votes) =>
      items.map((v) => `- "${v.articleTitle}" (topic: ${v.topicTitle})`).join('\n')

    const prompt =
      `The user has two inputs describing their news preferences:\n\n` +
      `(1) HARD PREFERENCES — written by the user, treat as authoritative. ` +
      `Do not contradict or dilute these. If empty, ignore.\n` +
      `---\n${manual.length > 0 ? manual : '(none)'}\n---\n\n` +
      `(2) Behavioral signal — articles they upvoted/downvoted. Use to ` +
      `INFER additional interests, themes, and aversions not stated above. ` +
      `If empty, rely solely on (1).\n\n` +
      `## Articles they liked\n${liked.length > 0 ? formatVotes(liked) : '(none)'}\n\n` +
      `## Articles they disliked\n${disliked.length > 0 ? formatVotes(disliked) : '(none)'}\n\n` +
      `Write a unified preference profile in markdown that (a) restates and preserves the hard preferences and (b) augments them with inferred interests from voting. ` +
      `Use second person ("You"). Be specific about the subject areas, not generic. ` +
      `Keep it under 400 words. Do not include a title heading.`

    const profile = await getAi().complete(prompt, {
      systemPrompt: 'You are a user preference analyst. Write concise, specific preference profiles based on stated preferences and reading behavior.',
      reasoningEffort: 'high',
    })

    db.users.updatePreferenceProfile(userId, profile.trim())
    console.log(`[profiler] generated preference profile for user ${userId}`)
  }

  function stop() {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
  }

  return {
    onVote: schedule,
    onManualProfileChange: schedule,
    stop,
  }
}
