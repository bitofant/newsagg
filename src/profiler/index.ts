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
      `Write a "preferences program" in markdown with EXACTLY two sections, in this order:\n` +
      `\n## Follow\n- ...\n- ...\n\n## Skip\n- ...\n- ...\n\n` +
      `Rules:\n` +
      `- Output ONLY those two headings and their bullets. No title, no intro, no prose between bullets, no nested bullets, no code fences.\n` +
      `- Each bullet expresses a CLASS of interest, not a specific instance. Abstract from the voted articles to the underlying theme.\n` +
      `  - GOOD: "Ukraine war and Russia-NATO escalation", "Shifts of power in European politics", "AI safety and frontier-model policy"\n` +
      `  - BAD: "The Donbas battle", "Hungarian elections", "GPT-5 launch"\n` +
      `- Preserve any HARD PREFERENCES verbatim where they fit (the class-level rule applies to vote-inferred bullets, not to user-authored hard rules).\n` +
      `- Cap each section at ~10 bullets. Drop weaker signals before exceeding.\n` +
      `- If a section would be empty, write a single bullet "- (none)".`

    const profile = await getAi().complete(prompt, {
      systemPrompt: 'You are a user preference analyst. You write terse, class-level preference programs as bullet lists — never prose, never instance-level.',
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
