// Shared guard rails for every Wrapped narrative (day and period): the line
// validator, the deck prompt builder, and the JSON plumbing. The model writes
// prose per slide id; everything here exists to reject a line that invents a
// number, grades the user, asks homework, or breaks the voice contract — the
// deterministic fallbackLine takes over per slide, never per wrap.

import type { WrapSlideSpec } from '../../renderer/lib/wrapDeck'
import { firstUngroundedNumericToken } from './wrapFactTable'

export const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/u

/** The only emoji a wrap line may carry — earned celebration, one per line, at
 *  the end. Everything else still reads as AI confetti and dies. */
export const CELEBRATION_EMOJI = ['🏆', '🔥', '🌙', '☕', '🎯', '✨'] as const

/** True when the text's emoji usage is allowed: at most ONE emoji, from the
 *  celebration set, sitting at the end of the line. */
export function emojiUsageAllowed(text: string): boolean {
  const matches = [...text.matchAll(new RegExp(EMOJI_REGEX.source, 'gu'))]
  if (matches.length === 0) return true
  if (matches.length > 1) return false
  const emoji = matches[0][0]
  if (!(CELEBRATION_EMOJI as readonly string[]).includes(emoji)) return false
  return text.trimEnd().endsWith(emoji)
}

export const BANNED_PHRASES = [
  'dive into', 'unleash', 'navigate the landscape', "in today's fast-paced",
  'game-changing', 'seamless', 'elevate', 'great question', "let's explore",
  'at the end of the day', 'fascinating perspective', "you're absolutely right",
  'harness the power', 'empower', 'robust', 'streamline',
]

// Carryover / homework / guilt the wrap must never speak (locked decision +
// voice.md §2.9). No "pick it up tomorrow", no drift, no focus grades.
// "distraction" is a live product noun (profile, alerts) and is not banned.
export const HOMEWORK_GUILT_PATTERNS = [
  /needs?\b[^.]{0,24}\breview\b/i,
  /\bpick (?:it|this|that|them) (?:back )?up\b/i,
  /\bcarry(?:ing)?\b[^.]{0,16}\b(?:forward|over|into (?:tomorrow|next))\b/i,
  /\bfocus(?:ed)?\s+(?:score|percentage|signal)\b/i,
  /\bdrift\b/i,
  /\bproductiv(?:e|ity)\s+score\b/i,
]

// ─── Evidence honesty (say only what was observed) ───────────────────────────
// The one written-once contract (docs/product/product.md, evidence-before-narrative): every sentence claims
// only what the tracked data can back. The DIRECTIVES go into both the day and
// the period system prompts; the PATTERNS below are the deterministic guard the
// runtime validator AND the benchmark share, so a rule lives in exactly one place.

export const EVIDENCE_HONESTY_DIRECTIVES = [
  'SAY ONLY WHAT WAS OBSERVED. Every fact you receive is what Daylens saw on this one computer: which app, window, site, or meeting surface was frontmost, for how long, plus any connected signals (git, calendar). Time in an app is evidence the app was open and in front, and with real dwell it is fair to narrate the person doing that work; it is NOT proof they finished, read, watched, or absorbed anything. Never write "you read" or "you watched" anything: a page or a player in the foreground was OPEN, never provably consumed. Never claim an outcome, a completed read, or a finished piece of work unless the facts state it (a git commit, a recorded note); on a day with no such evidence, never write "finished", "shipped", "done", or any other completion word about the work.',
  'CALENDAR IS A SCHEDULE, NOT A RECORD OF ATTENDANCE. A calendar event means the calendar HELD that event; write "your calendar had the design review", "the 1:1 sat on the calendar at midday", never "you attended", "you sat in", "you sat through", "you joined", or "you went to" a meeting on calendar evidence alone. Time observed in a meeting app is the only ground for saying the person was IN a call.',
  'UNTRACKED TIME IS UNKNOWN, NOT EMPTY. Time that was not observed is simply not in the story: never call it idle, rest, a break, off task, or a gap in the person\'s effort, and never guess what filled it (no walks, naps, lunches, gym runs, or errands the screen never saw). If it matters, anchor the honesty to the SCREEN, plainly ("most of the day happened away from this screen", "only 23 minutes reached the screen"), and NEVER name the product as the narrator: a line never says "Daylens saw", "Daylens only saw", or "Daylens didn\'t see" — the app never speaks its own name (voice.md §2.8). Naming Daylens as the thing WORKED ON (a project, commits to it) is of course fine.',
  'A MEASURED STRETCH IS OBSERVABLE; ATTENTION AND CONTINUITY ABSOLUTES ARE NOT. Narrate the run and its length plainly; never grade the attention inside it, and never claim absolute continuity: brief detours can sit inside any measured stretch, so never write "unbroken", "uninterrupted", "nothing broke it", "straight through", or any phrasing that swears nothing else happened. Never write "focused", "unfocused", or "deep focus": the screen shows time, not state of mind. (Naming a real focus-timer session from the focusSessions facts is fine.)',
  'NO PLAN, NO INTENT. The facts never contain what the person planned, meant, or intended to do; there is no written plan anywhere in this data. Never write "the plan was", "you planned to", "as planned", and never compare the day to any supposed intention. Narrate what happened, never what was supposed to happen.',
  'NEVER SPECULATE. No "probably", "must have", "likely", "no doubt", "surely". If the facts do not say it, the wrap does not say it.',
] as const

/** Speculation and unobserved-time characterizations that turn an honest recap
 *  into a guess. Shared by the runtime validator and the benchmark. */
export const OVERCLAIM_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = [
  { re: /\b(?:probably|must have|likely|no doubt|surely|presumably)\b/i, reason: 'speculates about something the facts do not state' },
  { re: /\bidle\b/i, reason: 'characterizes untracked or quiet time as "idle"; unobserved time is unknown, never idle' },
  { re: /\boff[- ]task\b/i, reason: 'grades time as "off task"' },
  { re: /\byou (?:attended|sat (?:in|through)|went to|showed up (?:to|at|for)|joined|hopped on|jumped on|dialed in)\b/i, reason: 'claims attendance the tracked data cannot prove; calendar evidence only supports "your calendar had ..."' },
  // App-open is never proof of consumption: a page or player in the foreground
  // was OPEN, not read or watched. Naming the surface and the time stays legal
  // ("YouTube pooled 59m"); the consumption verb is what dies.
  { re: /\byou (?:read|re-?read|watched|re-?watched|listened to|consumed|absorbed|caught up on)\b/i, reason: 'claims consumption ("you read/watched") that foreground time cannot prove; an open page or player is evidence it was open, not that it was taken in' },
  // Unobserved time is unknown: never narrate what physically filled it.
  { re: /\byou (?:took a (?:walk|nap|break)|went for a (?:walk|run)|stepped (?:away|out)|napped|went to (?:lunch|the gym))\b/i, reason: 'narrates what filled unobserved time; time away from this screen is unknown and never guessed at' },
  // Attention quality is not observable; a measured stretch is. The word
  // "focus session" (a real focus-timer fact) stays legal.
  { re: /\b(?:focused|unfocused)\b/i, reason: 'grades attention quality ("focused"); a measured stretch is observable, attention is not — narrate the run, not the state of mind' },
  { re: /\b(?:deep(?:est)?|sharp(?:est)?|intense|laser|pure) focus\b/i, reason: 'grades attention quality ("deep focus"); a measured stretch is observable, attention is not' },
  // Continuity absolutes: the longest-stretch fact is measured with small
  // tolerances (short quiet, sub-detour peeks), so "unbroken" and its kin
  // routinely contradict the timeline's own record of what sat inside the
  // run — the single most repeated shape-judge failure. The duration and the
  // run are the facts; the absolute is the lie.
  { re: /\b(?:unbroken|uninterrupted|nothing (?:broke|interrupted|else interrupted)|without (?:a break|breaking|interruption)|straight through|never (?:looked away|left|broke)|didn'?t (?:break|look away)|nothing pulled you (?:away|off))\b/i, reason: 'claims absolute continuity ("unbroken", "nothing broke it"); the stretch is measured with tolerances and brief detours may sit inside it — narrate the run and its length, never the absolute' },
  // No plan exists anywhere in the data (no morning-intention field is built);
  // any plan-vs-actual claim is invented.
  { re: /\b(?:the plan was|you (?:had )?planned|you (?:set out|meant|intended) to|as planned|your plan\b|the morning intention)\b/i, reason: 'claims a plan the person never wrote down; no written intention exists in the data, so any plan is invented' },
  // The product never speaks its own name as the narrator (voice.md §2.8).
  // "Daylens" as the thing worked on ("9 commits to Daylens") stays legal; it is
  // the observer voice ("Daylens saw / only saw / didn't see") that dies.
  { re: /\bDaylens(?:'s)?\s+(?:only\s+|never\s+|barely\s+)?(?:saw|sees|watch(?:ed|es)?|track(?:ed|s)?|observ(?:ed|es)|record(?:ed|s)?|caught|miss(?:ed|es)?|notic(?:ed|es)?|did\s*not\s+\w+|didn'?t\s+\w+|can(?:no|')t\s+see|couldn'?t\s+see)\b/i, reason: 'names the product as the narrator ("Daylens saw ..."); the recap never speaks its own name — anchor the honesty to the screen instead ("away from this screen", "reached the screen")' },
]

/** The first overclaim in the text, or null. One rule, used by the runtime
 *  guard and the benchmark's deterministic pre-check. */
export function findOverclaimViolation(text: string): string | null {
  for (const { re, reason } of OVERCLAIM_PATTERNS) {
    const m = text.match(re)
    if (m) return `${reason} ("${m[0]}")`
  }
  return null
}

// ─── Completion claims (Layer 2's evidence rule) ─────────────────────────────
// "X is done" is the most satisfying true thing a wrap can say and the easiest
// place to lie: app time never proves an outcome. Completion words are legal
// ONLY when the day carries verified output evidence (git commits / PRs, or
// recorded meeting notes) — otherwise the honest wrap narrates the time and
// says nothing about the result. Context-gated (not in OVERCLAIM_PATTERNS)
// because with evidence these are exactly the words voice.md loves.

const COMPLETION_CLAIM_RE = /\b(?:finished|completed|shipped|submitted|published|merged|wrapped up|got done|(?:is|are|was|were) done|crossed the line)\b/i

/** The first unverified completion claim, or null. Pass `outputVerified: true`
 *  when the facts carry real output evidence (shipped / meetingNotes). */
export function findUnverifiedCompletionClaim(text: string, outputVerified: boolean): string | null {
  if (outputVerified) return null
  const m = text.match(COMPLETION_CLAIM_RE)
  if (!m) return null
  return `claims finished output ("${m[0]}") with no verified artifact behind it; without a git commit or a recorded note, narrate the time spent and say nothing about completion`
}

// Raw technical text that must never reach human-readable prose: paths, file
// names, branch-like slugs, snake_case identifiers, long hex ids, JSON. Kept
// deliberately conservative so real prose ("a two-hour stretch") never dies.
const RAW_ARTIFACT_CHECKS: ReadonlyArray<{ re: RegExp; what: string }> = [
  // Two or more slashes is a path; one slash only counts when it reads like a
  // git branch — "and/or", "24/7", "work/life" stay legal prose.
  { re: /\b[\w.-]+\/[\w.-]+\/[\w.-]+\b/, what: 'a path-like token' },
  { re: /\b(?:feat|fix|chore|refactor|docs|test|build|ci|perf|hotfix|release)\/[\w.-]+\b/i, what: 'a branch-like token' },
  { re: /\b[\w-]+\.(?:tsx?|jsx?|py|rs|go|java|rb|cpp?|h|md|json|ya?ml|sql|sh|ipynb|sqlite|exe|dmg|pkg)\b/i, what: 'a file name' },
  { re: /\b\w+_\w+\b/, what: 'a snake_case identifier' },
  { re: /\b[0-9a-f]{8,}\b/i, what: 'a raw id or hash' },
  { re: /[{}`]|\[\[/, what: 'code or JSON syntax' },
]

/** The first raw technical leak in the text, or null. Shared by the runtime
 *  guard and the benchmark. */
export function findRawArtifactLeak(text: string): string | null {
  for (const { re, what } of RAW_ARTIFACT_CHECKS) {
    const m = text.match(re)
    if (m) return `${what} ("${m[0]}")`
  }
  return null
}

export function stripCodeFence(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return fenced?.[1]?.trim() ?? text
}

export function normalizeOptional(value: unknown): string | null {
  if (value == null) return null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^null$/i.test(trimmed)) return null
  return trimmed
}

export interface LineGuardContext {
  /** The period's total hours; a claim exceeding this beyond tolerance dies. */
  totalHours: number
  /** Hour tolerance (a line may reference a sub-total, so only excess kills). */
  hourTolerance: number
  /** The only percentages a line may speak — the ones a slide actually shows.
   *  Any other percentage is an invented grade and kills the line. */
  allowedPercents: ReadonlySet<number>
  /** The only clock times a line may speak — normalized tokens harvested from
   *  the facts. "You started at midnight" when the facts say 11:15am is the
   *  single worst wrap failure; any ungrounded clock time kills the line. */
  allowedTimes: ReadonlySet<string>
  /** The only counts a line may attach to an enrichment noun, keyed by category
   *  ("commits:9", "meetings:2"). Enrichment rides no slide, so this is how an
   *  invented "12 commits" dies. Keyed by noun so a real "2 meetings" does NOT
   *  authorize an invented "2 commits". Empty/absent means no enrichment counts
   *  exist, so ANY such count is invented and killed. */
  allowedCounts?: ReadonlySet<string>
  /** The only compact duration tokens ("8h58m", "46m", "3h") a line may write —
   *  harvested from the compact facts the writer saw plus every slide's own
   *  facts. Undefined = grounding off (callers that predate it). This is what
   *  kills the off-by-one "8h 57m" on a slide whose facts say 8h 58m. */
  allowedDurations?: ReadonlySet<string>
  /** True when the period's facts carry verified output evidence (git shipped /
   *  recorded meeting notes). Without it, completion claims ("finished",
   *  "shipped", "is done") are invented outcomes and die. */
  outputVerified?: boolean
  /** The wrap fact table's groundable forms unioned with every numeric token
   *  the writer was actually shown (compact facts JSON + slide card text).
   *  When present, EVERY numeric token in a line must match one of these
   *  forms — the fact-table backstop under the per-kind checks above, and the
   *  only check that catches a bare invented integer ("opened it 14 times").
   *  Undefined = backstop off (callers that predate the fact table). */
  groundedNumericForms?: ReadonlySet<string>
}

export function guardContextPercents(slides: WrapSlideSpec[]): Set<number> {
  const allowed = new Set<number>()
  for (const spec of slides) {
    if (spec.split) { allowed.add(spec.split.aPct); allowed.add(spec.split.bPct) }
  }
  return allowed
}

// ─── Clock-time grounding ─────────────────────────────────────────────────────

// "noon" and "midnight" are precise clock claims (12pm / 12am) and must ground
// like any other clock time. "midday" is a part-of-day word like "morning" or
// "the evening" — free prose, never a clock token.
const CLOCK_TOKEN_REGEX = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\bmidnight\b|\bnoon\b/gi

/** Normalize one clock mention to a comparable token: "12:00 PM" → "12pm",
 *  "midnight" → "12am", "8:22pm" → "8:22pm". */
function normalizeClockToken(match: RegExpMatchArray): string {
  const whole = match[0].toLowerCase()
  if (whole === 'midnight') return '12am'
  if (whole === 'noon') return '12pm'
  const hour = match[1]
  const minutes = match[2] && match[2] !== '00' ? `:${match[2]}` : ''
  const meridiem = match[3].toLowerCase()
  return `${Number(hour)}${minutes}${meridiem}`
}

/** Every normalized clock token mentioned in a text. */
export function clockTokensIn(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const match of text.matchAll(CLOCK_TOKEN_REGEX)) tokens.add(normalizeClockToken(match))
  return tokens
}

/** The clock tokens the whole deck's facts put on the table (kickers, facts
 *  notes, stat sublabels). Union set for the question and the reflection; the
 *  per-slide validator further restricts a line to its own slide's tokens. */
export function guardContextTimes(slides: WrapSlideSpec[]): Set<string> {
  const allowed = new Set<string>()
  for (const spec of slides) {
    for (const token of clockTokensIn(`${spec.kicker} ${spec.factsNote} ${spec.stat?.sublabel ?? ''} ${spec.stat?.value ?? ''}`)) {
      allowed.add(token)
    }
  }
  return allowed
}

/** The first clock token in the text that is NOT grounded in the allowed set,
 *  or null when every claimed time is grounded. */
function ungroundedTimeIn(text: string, allowed: ReadonlySet<string>): string | null {
  for (const token of clockTokensIn(text)) {
    if (!allowed.has(token)) return token
  }
  return null
}

// ─── Duration grounding ───────────────────────────────────────────────────────
// Compact duration tokens ("8h 58m", "46m", "3h") are pre-formatted facts, so a
// line may only write ones that exist somewhere in the facts. This is the
// deterministic fix for the paid-bench week failures where the model wrote
// "8h 57m" for an 8h 58m stretch and hand-computed a wrong "12h 21m" delta:
// close-but-wrong durations sailed past the old excess-only hour check and cost
// an automatic accuracy 0 at the judge. Word-form durations ("two and a half
// hours") are untouched; they are prose, not fact tokens.

const DURATION_TOKEN_REGEX = /\b(\d+)\s*h(?:\s*(\d{1,2})\s*m)?\b|\b(\d+)\s*m\b/gi

function normalizeDurationToken(match: RegExpMatchArray): string {
  if (match[3] !== undefined) return `${Number(match[3])}m`
  const minutes = match[2] !== undefined ? `${Number(match[2])}m` : ''
  return `${Number(match[1])}h${minutes}`
}

/** Every normalized compact duration token mentioned in a text. */
export function durationTokensIn(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const match of text.matchAll(DURATION_TOKEN_REGEX)) tokens.add(normalizeDurationToken(match))
  return tokens
}

/** The first compact duration in the text that appears nowhere in the allowed
 *  facts tokens, or null. */
function ungroundedDurationIn(text: string, allowed: ReadonlySet<string>): string | null {
  for (const match of text.matchAll(DURATION_TOKEN_REGEX)) {
    if (!allowed.has(normalizeDurationToken(match))) return match[0]
  }
  return null
}

export interface WrapLineGuardOpts {
  minChars?: number
  maxChars?: number
  allowQuestion?: boolean
  allowedTimes?: ReadonlySet<string>
}

/** Why a line dies, phrased for the WRITER (the repair round feeds this back to
 *  the model verbatim), or null when the line is valid. Every reason names the
 *  offending value and what would have been allowed, so a rewrite can actually
 *  fix it instead of guessing. */
export function wrapLineViolation(value: string, ctx: LineGuardContext, opts?: WrapLineGuardOpts): string | null {
  const minChars = opts?.minChars ?? 18
  const maxChars = opts?.maxChars ?? 220
  if (!value) return 'the line is empty'
  if (value.length < minChars) return `too short (${value.length} characters; write at least ${minChars})`
  if (value.length > maxChars) return `too long (${value.length} characters; the hard cap for this slide is ${maxChars})`
  if (!emojiUsageAllowed(value)) return 'emoji rule broken: at most ONE emoji in the whole deck, from the celebration set, only at the very end of a line'
  if (!opts?.allowQuestion && /\?/.test(value)) return 'contains a question mark; only the dedicated question slide may ask'
  if (/[—–]/.test(value)) return 'contains an em or en dash; use a comma, a period, or "and"'
  if (/```/.test(value)) return 'contains a code fence'
  if (/^\s*[{[]/.test(value)) return 'reads as JSON, not prose'
  const hedge = value.match(/\b(I'?m not sure|couldn'?t|cannot determine|no data|n\/?a)\b/i)
  if (hedge) return `hedges about missing data ("${hedge[0]}"); state only what the facts support, plainly`
  const lower = value.toLowerCase()
  const banned = BANNED_PHRASES.find((p) => lower.includes(p))
  if (banned) return `contains the banned phrase "${banned}"`
  const guilt = HOMEWORK_GUILT_PATTERNS.find((p) => p.test(value))
  if (guilt) {
    const matched = value.match(guilt)?.[0] ?? ''
    return `contains banned homework/guilt/grading language ("${matched}"); never mention drift, carryover, or focus scores, not even to negate them`
  }
  const overclaim = findOverclaimViolation(value)
  if (overclaim) return `${overclaim}; state only what the tracked data observed, plainly`
  const completion = findUnverifiedCompletionClaim(value, ctx.outputVerified ?? false)
  if (completion) return completion
  const leak = findRawArtifactLeak(value)
  if (leak) return `leaks raw technical text into prose: ${leak}; name the work in human words, never a path, file, branch, or id`
  const hours = hourClaimViolation(value, ctx)
  if (hours) return hours
  if (ctx.allowedDurations) {
    const duration = ungroundedDurationIn(value, ctx.allowedDurations)
    if (duration) return `writes the duration "${duration}" which appears nowhere in the facts; copy a pre-formatted duration character for character, or say it in words instead`
  }
  const percent = percentClaimViolation(value, ctx)
  if (percent) return percent
  const time = ungroundedTimeIn(value, opts?.allowedTimes ?? ctx.allowedTimes)
  if (time) {
    const allowed = [...(opts?.allowedTimes ?? ctx.allowedTimes)]
    return `writes the clock time "${time}" which is NOT in this slide's own facts (${allowed.length ? `this slide's facts only allow: ${allowed.join(', ')}` : 'this slide\'s facts contain no clock times at all'}); copy a listed time character for character, or use a part-of-day word instead`
  }
  const count = countClaimViolation(value, ctx)
  if (count) return count
  if (ctx.groundedNumericForms) {
    const ungrounded = firstUngroundedNumericToken(value, ctx.groundedNumericForms)
    if (ungrounded) {
      return `writes the ${ungrounded.kind} "${ungrounded.raw}" which matches no fact in this wrap's fact table; every number must be copied from the facts you were given, so copy one character for character or drop the number`
    }
  }
  return null
}

export function isWrapLineValid(value: string, ctx: LineGuardContext, opts?: WrapLineGuardOpts): boolean {
  return wrapLineViolation(value, ctx, opts) === null
}

/** A number attached to an enrichment noun ("9 commits", "two pull requests")
 *  must be a real count from the enrichment facts. Word-form small numbers are
 *  normalized so "two meetings" is checked too. Only enrichment nouns are
 *  policed, so ordinary lines ("you opened it 14 times") are untouched. */
const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
}
/** Map an enrichment noun to its count category, so counts are checked against
 *  the RIGHT source ("2 meetings" never vouches for "2 commits"). */
export function countNounCategory(noun: string): 'commits' | 'prs' | 'meetings' | 'sessions' | null {
  const n = noun.toLowerCase()
  if (/^commits?$/.test(n)) return 'commits'
  if (/^(?:pull requests?|prs?|merge requests?)$/.test(n)) return 'prs'
  if (/^(?:meetings?|calls?)$/.test(n)) return 'meetings'
  if (/^(?:focus sessions?|sessions?)$/.test(n)) return 'sessions'
  return null
}
function countClaimViolation(text: string, ctx: LineGuardContext): string | null {
  const allowed = ctx.allowedCounts ?? EMPTY_COUNTS
  const re = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(commits?|pull requests?|prs?|merge requests?|meetings?|calls?|focus sessions?|sessions?)\b/gi
  for (const m of text.matchAll(re)) {
    const raw = m[1].toLowerCase()
    const n = /^\d+$/.test(raw) ? Number(raw) : WORD_NUMBERS[raw]
    if (!Number.isFinite(n)) return `claims "${m[0]}" which cannot be read as a real count`
    const category = countNounCategory(m[2])
    if (!category) return `claims "${m[0]}" which cannot be matched to a fact category`
    if (!allowed.has(`${category}:${n}`)) return `claims "${m[0]}" but the facts record no such ${category} count; copy the exact count the facts give you or drop it`
  }
  return null
}
const EMPTY_COUNTS: ReadonlySet<string> = new Set()

function hourClaimViolation(text: string, ctx: LineGuardContext): string | null {
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h\b)/gi)]
  for (const m of matches) {
    const claimed = Number(m[1])
    // A line may reference a sub-total (one activity), so only reject a claim
    // that EXCEEDS the period total beyond tolerance.
    if (!Number.isFinite(claimed) || claimed - ctx.totalHours > ctx.hourTolerance) {
      return `claims "${m[0]}" which exceeds the period's real total; copy durations exactly as the facts pre-format them`
    }
  }
  return null
}

function percentClaimViolation(text: string, ctx: LineGuardContext): string | null {
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)]
  for (const m of matches) {
    const claimed = Number(m[1])
    if (!Number.isFinite(claimed) || !ctx.allowedPercents.has(claimed)) {
      const allowed = [...ctx.allowedPercents]
      return `writes "${m[0]}" but ${allowed.length ? `the only percentages any slide shows are ${allowed.map((p) => `${p}%`).join(' and ')}, and only on the split slide` : 'no slide shows a percentage, so none may be written'}`
    }
  }
  return null
}

/** The AI's curious question: must actually be a question, short, warm, and
 *  about the period — never a task assignment. */
export function validateWrapQuestion(value: unknown, ctx: LineGuardContext): string | null {
  return wrapQuestionViolation(value, ctx).value
}

/** Detailed question validation: the surviving value, or why it died. A missing
 *  question is itself a violation — the JSON contract demands one. */
export function wrapQuestionViolation(value: unknown, ctx: LineGuardContext): { value: string | null; reason: string | null } {
  const trimmed = normalizeOptional(value)
  if (trimmed == null) return { value: null, reason: 'no question was provided; the contract requires one curious question ending in a question mark' }
  if (!/\?$/.test(trimmed)) return { value: null, reason: 'the question does not end with a question mark' }
  const lineReason = wrapLineViolation(trimmed, ctx, { minChars: 12, maxChars: 210, allowQuestion: true })
  if (lineReason) return { value: null, reason: lineReason }
  const task = trimmed.match(/\b(should you|you should|will you|promise|commit)\b/i)
  if (task) return { value: null, reason: `reads as a task or a should ("${task[0]}"); ask out of genuine curiosity, never assign` }
  return { value: trimmed, reason: null }
}

/** Per-slide upper bound on line length. The story/leisure beats ("text") are the
 *  narrative heart and legitimately run to two full sentences, so they get more
 *  room than a stat caption; everything else stays punchy. Kept well short of a
 *  paragraph (voice.md §11 — short lines, never a wall). */
export function maxCharsForKind(kind: string): number {
  return kind === 'text' ? 340 : 220
}

/** The finale reflection: a real paragraph, longer leash, same honesty rules. */
export function validateWrapReflection(value: unknown, ctx: LineGuardContext): string | null {
  return wrapReflectionViolation(value, ctx).value
}

/** Detailed reflection validation: the surviving value, or why it died. */
export function wrapReflectionViolation(value: unknown, ctx: LineGuardContext): { value: string | null; reason: string | null } {
  const trimmed = normalizeOptional(value)
  if (trimmed == null) return { value: null, reason: 'no reflection was provided; the contract requires a closing paragraph of 3 to 5 sentences' }
  const lineReason = wrapLineViolation(trimmed, ctx, { minChars: 80, maxChars: 650, allowQuestion: false })
  if (lineReason) return { value: null, reason: lineReason }
  return { value: trimmed, reason: null }
}

/** One rejected piece of the model's response, with the writer-facing reason.
 *  `id` is a slide id, or the pseudo-ids 'question' / 'reflection'. */
export interface WrapLineRejection {
  id: string
  candidate: string | null
  reason: string
}

export interface DeckLinesValidation {
  lines: Record<string, string | null>
  rejections: WrapLineRejection[]
}

/** Read the model's `lines` object and keep only per-slide lines that survive
 *  the guards; everything else falls back to the slide's deterministic line.
 *  Every death is recorded with its reason so the repair round (and the bench
 *  log) can see exactly why a slide fell back instead of guessing. */
export function validateDeckLinesDetailed(
  raw: Record<string, unknown> | null | undefined,
  slides: WrapSlideSpec[],
  ctx: LineGuardContext,
): DeckLinesValidation {
  const lines: Record<string, string | null> = {}
  const rejections: WrapLineRejection[] = []
  for (const spec of slides) {
    if (!spec.ask) continue
    const candidate = normalizeOptional(raw?.[spec.id])
    if (candidate == null) {
      lines[spec.id] = null
      rejections.push({ id: spec.id, candidate: null, reason: 'no line was written for this slide; the contract requires one line per listed slide id' })
      continue
    }
    // A line may only speak the clock times ITS OWN slide's facts contain —
    // this is what kills "you started at midnight" on the 11:15am card.
    const slideTimes = clockTokensIn(`${spec.kicker} ${spec.factsNote} ${spec.stat?.sublabel ?? ''} ${spec.stat?.value ?? ''}`)
    const reason = wrapLineViolation(candidate, ctx, { allowedTimes: slideTimes, maxChars: maxCharsForKind(spec.kind) })
    if (reason) {
      lines[spec.id] = null
      rejections.push({ id: spec.id, candidate, reason })
    } else {
      lines[spec.id] = candidate
    }
  }
  return { lines, rejections }
}

export function validateDeckLines(
  raw: Record<string, unknown> | null | undefined,
  slides: WrapSlideSpec[],
  ctx: LineGuardContext,
): Record<string, string | null> {
  return validateDeckLinesDetailed(raw, slides, ctx).lines
}

// ─── Deck-level emoji budget ──────────────────────────────────────────────────
// The per-line check allows one earned emoji per LINE; the deck contract
// (catalog "Emoji note") allows one per DECK. Enforced here after per-line
// validation: the first emoji in deck order is the earned one, every later
// emoji-bearing piece is rejected and sent to the repair round.

export interface DeckEmojiEnforcement {
  lines: Record<string, string | null>
  question: string | null
  reflection: string | null
  rejections: WrapLineRejection[]
}

export function enforceDeckEmojiBudget(
  lines: Record<string, string | null>,
  slides: WrapSlideSpec[],
  question: string | null,
  reflection: string | null,
): DeckEmojiEnforcement {
  const hasEmoji = (text: string) => new RegExp(EMOJI_REGEX.source, 'u').test(text)
  const out: DeckEmojiEnforcement = { lines: { ...lines }, question, reflection, rejections: [] }
  let spentOn: string | null = null
  const reject = (id: string, candidate: string) => {
    out.rejections.push({
      id,
      candidate,
      reason: `carries an emoji but the deck already spent its one emoji on "${spentOn}"; at most ONE line in the whole deck may end with one — rewrite this piece without any emoji`,
    })
  }
  for (const spec of slides) {
    if (!spec.ask) continue
    const line = out.lines[spec.id]
    if (!line || !hasEmoji(line)) continue
    if (spentOn == null) { spentOn = spec.id; continue }
    reject(spec.id, line)
    out.lines[spec.id] = null
  }
  if (out.question && hasEmoji(out.question)) {
    if (spentOn == null) spentOn = 'question'
    else { reject('question', out.question); out.question = null }
  }
  if (out.reflection && hasEmoji(out.reflection)) {
    if (spentOn == null) spentOn = 'reflection'
    else { reject('reflection', out.reflection); out.reflection = null }
  }
  return out
}

/** The user message for the ONE repair round: each rejected piece, the line the
 *  writer produced, why the guard killed it, and that slide's ask + facts again.
 *  The writer rewrites ONLY these; everything that survived is already final. */
export function buildRepairUserMessage(slides: WrapSlideSpec[], rejections: WrapLineRejection[]): string {
  const byId = new Map(slides.map((s) => [s.id, s]))
  const items = rejections.map((r) => {
    const spec = byId.get(r.id)
    const head = spec
      ? `- "${r.id}": ${spec.ask}\n  facts: ${spec.factsNote}`
      : r.id === 'question'
        ? '- "question": the ONE curious question, ending with a question mark.'
        : '- "reflection": the closing paragraph, 3 to 5 sentences.'
    const wrote = r.candidate == null ? '  you wrote: nothing' : `  you wrote: ${JSON.stringify(r.candidate)}`
    return `${head}\n${wrote}\n  rejected because it ${r.reason}`
  })
  const lineIds = rejections.filter((r) => r.id !== 'question' && r.id !== 'reflection').map((r) => r.id)
  const wants: string[] = []
  if (lineIds.length) wants.push(`"lines" with exactly these ids: ${lineIds.map((id) => `"${id}"`).join(', ')}`)
  if (rejections.some((r) => r.id === 'question')) wants.push('"question"')
  if (rejections.some((r) => r.id === 'reflection')) wants.push('"reflection"')
  return [
    'Some of your lines were rejected by the validator. Rewrite ONLY the pieces listed below; every other line you wrote has already been accepted and must not change.',
    'Fix exactly what each rejection names, keep every other rule, and stay just as specific and warm. Do not go vague to dodge a rejection; anchor the rewrite in a different true fact from that slide instead.',
    '',
    ...items,
    '',
    `Return STRICT JSON with only: ${wants.join(', ')}. No prose outside the JSON. No code fences.`,
  ].join('\n')
}

/** The per-slide section of the user prompt: id, what to write, and the true
 *  facts the line may use. The model may never write about a slide not listed. */
export function deckPromptSection(slides: WrapSlideSpec[]): string {
  const rows = slides
    .filter((s) => s.ask)
    .map((s) => `- "${s.id}": ${s.ask}\n  facts: ${s.factsNote}`)
  return ['Slides to write, keyed by id:', ...rows].join('\n')
}

/** The JSON contract shared by the day and period prompts. */
export const DECK_JSON_CONTRACT = [
  'Return STRICT JSON with exactly these keys:',
  '"lines" — an object with one string per slide id listed below. Write ONLY the listed ids.',
  '"question" — ONE genuine question you are curious about after reading the facts, addressed to the user, ending with a question mark. Curious, specific to THIS data, never a task, never a should.',
  '"reflection" — one paragraph (3 to 5 sentences, under 600 characters) you would send the user as a closing message about this period. Warm, specific, grounded in the facts, no advice, no homework, no prediction.',
  'No prose outside the JSON. No code fences. No markdown. No exclamation marks. No emoji anywhere except the single earned celebration emoji the instructions allow, at the end of at most one line.',
].join(' ')
