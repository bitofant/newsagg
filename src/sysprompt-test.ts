/**
 * Compare placing instructions in `system` role vs concatenated into the `user` message.
 * Runs a realistic consolidator-style matching task several times each way and reports
 * latency, parse success, and output stability.
 */
import { getAi } from './ai/index.js'
import { config } from './config.js'

// A realistic snapshot: 4 new articles against 8 existing topics. Chosen to have a few
// unambiguous matches and a few non-matches so output diffs are easy to read.
const TOPICS: { id: number; title: string; description: string }[] = [
  { id: 101, title: 'Ukraine war', description: 'Ongoing conflict between Russia and Ukraine, frontline operations and diplomacy.' },
  { id: 102, title: 'US-China trade tensions', description: 'Tariffs, export controls, and economic disputes between the US and China.' },
  { id: 103, title: 'Artemis II Moon mission', description: 'NASA crewed lunar flyby preparations and launch updates.' },
  { id: 104, title: 'UK general election', description: 'Campaigns, polling, and party platforms ahead of the UK national vote.' },
  { id: 105, title: 'AI regulation in the EU', description: 'EU AI Act implementation, member-state guidance, and enforcement.' },
  { id: 106, title: 'Gaza ceasefire negotiations', description: 'Talks between Israel, Hamas, and mediators on a Gaza ceasefire.' },
  { id: 107, title: 'Climate summit COP31', description: 'International climate conference outcomes and country commitments.' },
  { id: 108, title: 'Boeing safety investigations', description: 'FAA and NTSB probes into Boeing aircraft incidents and manufacturing.' },
]

const ARTICLES: { title: string; text: string }[] = [
  {
    title: 'NASA confirms Artemis II crew clears final flight readiness review',
    text: 'NASA officials announced today that the Artemis II crew has passed the final flight readiness review, clearing the way for the crewed lunar flyby mission. The four-person crew is scheduled to launch within the next quarter.',
  },
  {
    title: 'Russian drone strikes hit Kharkiv energy grid as Ukraine pushes for more air defense',
    text: 'Overnight Russian drone strikes targeted energy infrastructure in Kharkiv, prompting Ukrainian officials to renew calls for additional Western air defense systems. The attacks come amid stalled diplomatic talks.',
  },
  {
    title: 'Boeing CEO testifies before Senate on 737 MAX manufacturing oversight',
    text: 'Boeing\'s chief executive faced sharp questioning at a Senate hearing over the company\'s manufacturing oversight, with senators citing recent FAA findings about quality lapses on the 737 MAX line.',
  },
  {
    title: 'Roundup: tech stocks rally as inflation data cools and EU finalizes AI Act guidance',
    text: 'Markets rose on softer inflation numbers, while in Brussels, EU regulators published implementation guidance for the AI Act covering general-purpose models. Separately, US-China trade negotiators met to discuss new export-control carve-outs.',
  },
]

const INSTRUCTIONS_PREFIX = `You are a news editor. Match new articles to existing topics.\n\nExisting topics:\n`

const INSTRUCTIONS_SUFFIX = `\n\nNew articles:\n{ARTICLES}\n\nFor each article, decide which existing topics it belongs to. An article may match multiple topics if it covers multiple subjects. Only match if the article contains substantial information about that topic — a passing mention is not enough.\nReply with a JSON array. Each entry has "article" (the article index number) and "topicIds" (an array of matching topic ID numbers, or an empty array if no match).\n\nExample: [{"article": 0, "topicIds": [5, 12]}, {"article": 1, "topicIds": []}]\n\nReply with ONLY the JSON array, no other text.`

function buildTopicList() {
  return TOPICS.map((t) => `${t.id}: ${t.title} — ${t.description}`).join('\n')
}
function buildArticleList() {
  return ARTICLES.map((a, i) => `${i}: ${a.title} — ${a.text.slice(0, 200)}`).join('\n')
}

function buildFullPrompt(): string {
  return INSTRUCTIONS_PREFIX + buildTopicList() + INSTRUCTIONS_SUFFIX.replace('{ARTICLES}', buildArticleList())
}

// System-prompt variant: static instructions in system, dynamic data in user.
function buildSystemPart(): string {
  return `You are a news editor. Match new articles to existing topics. For each article, decide which existing topics it belongs to. An article may match multiple topics if it covers multiple subjects. Only match if the article contains substantial information about that topic — a passing mention is not enough.\nReply with a JSON array. Each entry has "article" (the article index number) and "topicIds" (an array of matching topic ID numbers, or an empty array if no match).\n\nExample: [{"article": 0, "topicIds": [5, 12]}, {"article": 1, "topicIds": []}]\n\nReply with ONLY the JSON array, no other text.`
}
function buildUserPart(): string {
  return `Existing topics:\n${buildTopicList()}\n\nNew articles:\n${buildArticleList()}`
}

function stripCodeFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
}

interface RunResult {
  ok: boolean
  durationMs: number
  parsed: { article: number; topicIds: number[] }[] | null
  raw: string
}

function normalizeMatches(parsed: RunResult['parsed']): string {
  if (!parsed) return 'PARSE_FAIL'
  const sorted = parsed
    .map((e) => ({ article: e.article, topicIds: [...(e.topicIds ?? [])].sort((a, b) => a - b) }))
    .sort((a, b) => a.article - b.article)
  return JSON.stringify(sorted)
}

const ai = getAi()
const N = 5

async function runConcat(): Promise<RunResult> {
  const t0 = Date.now()
  const raw = await ai.complete(buildFullPrompt(), { reasoningEffort: 'high', timeoutMs: 180_000 })
  const durationMs = Date.now() - t0
  try {
    const parsed = JSON.parse(stripCodeFences(raw)) as RunResult['parsed']
    return { ok: true, durationMs, parsed, raw }
  } catch {
    return { ok: false, durationMs, parsed: null, raw }
  }
}

async function runSystem(): Promise<RunResult> {
  const t0 = Date.now()
  const raw = await ai.complete(buildUserPart(), { reasoningEffort: 'high', timeoutMs: 180_000, systemPrompt: buildSystemPart() })
  const durationMs = Date.now() - t0
  try {
    const parsed = JSON.parse(stripCodeFences(raw)) as RunResult['parsed']
    return { ok: true, durationMs, parsed, raw }
  } catch {
    return { ok: false, durationMs, parsed: null, raw }
  }
}

async function main() {
  console.log('[sysprompt-test] backend:', config.ai.backend, 'model:', ai.model)
  console.log(`[sysprompt-test] running ${N} iterations of each variant…\n`)

  const concat: RunResult[] = []
  const system: RunResult[] = []

  for (let i = 0; i < N; i++) {
    process.stdout.write(`  iter ${i + 1}/${N} concat… `)
    const c = await runConcat()
    concat.push(c)
    process.stdout.write(`${c.durationMs}ms ${c.ok ? 'ok' : 'PARSE_FAIL'}  |  system… `)
    const s = await runSystem()
    system.push(s)
    process.stdout.write(`${s.durationMs}ms ${s.ok ? 'ok' : 'PARSE_FAIL'}\n`)
  }

  const summarize = (label: string, runs: RunResult[]) => {
    const okRuns = runs.filter((r) => r.ok)
    const parseRate = `${okRuns.length}/${runs.length}`
    const avg = runs.reduce((s, r) => s + r.durationMs, 0) / runs.length
    const min = Math.min(...runs.map((r) => r.durationMs))
    const max = Math.max(...runs.map((r) => r.durationMs))
    const distinct = new Set(okRuns.map((r) => normalizeMatches(r.parsed))).size
    return { label, parseRate, avgMs: Math.round(avg), minMs: min, maxMs: max, distinctOutputs: distinct }
  }

  console.log('\n[sysprompt-test] ----- summary -----')
  console.table([summarize('CONCAT (everything in user)', concat), summarize('SYSTEM (instr in system)', system)])

  console.log('\n[sysprompt-test] ----- normalized outputs -----')
  for (let i = 0; i < N; i++) {
    console.log(`iter ${i + 1}:`)
    console.log(`  concat: ${normalizeMatches(concat[i].parsed)}`)
    console.log(`  system: ${normalizeMatches(system[i].parsed)}`)
    console.log(`  match:  ${normalizeMatches(concat[i].parsed) === normalizeMatches(system[i].parsed) ? 'YES' : 'NO'}`)
  }

  // Show one full raw example each
  console.log('\n[sysprompt-test] ----- example raw output (iter 1) -----')
  console.log('CONCAT:')
  console.log(concat[0].raw)
  console.log('\nSYSTEM:')
  console.log(system[0].raw)
}

main().catch((err) => {
  console.error('[sysprompt-test] error:', err)
  process.exit(1)
})
