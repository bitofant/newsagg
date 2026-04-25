import type { Db } from '../db/index.js'
import { getAi } from '../ai/index.js'

const DEBOUNCE_MS = 15 * 60 * 1000 // 15 minutes

export interface Profiler {
  onVote(userId: number): void
  stop(): void
}

export function createProfiler({ db }: { db: Db }): Profiler {
  const timers = new Map<number, ReturnType<typeof setTimeout>>()

  function onVote(userId: number) {
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
    const votes = db.users.getVotesWithContext(userId)
    if (votes.length < 3) return // not enough signal yet

    const liked = votes.filter((v) => v.vote === 1)
    const disliked = votes.filter((v) => v.vote === -1)

    const formatVotes = (items: typeof votes) =>
      items.map((v) => `- "${v.articleTitle}" (topic: ${v.topicTitle})`).join('\n')

    const prompt =
      `A user has rated news articles. Based on their ratings, write a concise preference profile in markdown.\n\n` +
      (liked.length > 0 ? `## Articles they liked\n${formatVotes(liked)}\n\n` : '') +
      (disliked.length > 0 ? `## Articles they disliked\n${formatVotes(disliked)}\n\n` : '') +
      `Write a preference profile in markdown describing what topics, themes, and types of news this user is interested in and what they want to see less of. ` +
      `Use second person ("You"). Be specific about the subject areas, not generic. ` +
      `Keep it under 300 words. Do not include a title heading.`

    const profile = await getAi().complete(prompt, {
      systemPrompt: 'You are a user preference analyst. Write concise, specific preference profiles based on reading behavior.',
      reasoningEffort: 'high',
    })

    db.users.updatePreferenceProfile(userId, profile.trim())
    console.log(`[profiler] generated preference profile for user ${userId}`)
  }

  function stop() {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
  }

  return { onVote, stop }
}
