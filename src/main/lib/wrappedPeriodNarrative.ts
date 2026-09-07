// Period (week / month / year) Wrapped narrative — prompt, validation, and a
// deterministic baseline. Pure helpers, no DB or AI orchestration, so tests can
// drive them directly.
//
// Like the daily wrap, the period wrap is a DECK: `planPeriodWrapSlides`
// computes the slides deterministically from WrappedPeriodFacts (a SUM of
// frozen daily snapshots — the stat card reads the same facts, so they can't
// disagree), and the model writes one line per slide id, plus one curious
// question and a closing reflection. Rejected lines fall back per slide.

import { createHash } from 'node:crypto'
import { INTERPRETATION_DIRECTIVES } from '@shared/activityDescription'
import { VOICE_SYSTEM_PROMPT } from '../ai/voiceContract'
import type {
  WrappedPeriod,
  WrappedPeriodFacts,
  WrappedPeriodNarrative,
} from '@shared/types'
import { planPeriodWrapSlides, type WrapSlideSpec } from '../../renderer/lib/wrapDeck'
import { formatHm, seedFromDate } from '../../renderer/lib/dayWrapScenes'
import {
  DECK_JSON_CONTRACT,
  EVIDENCE_HONESTY_DIRECTIVES,
  buildRepairUserMessage,
  deckPromptSection,
  durationTokensIn,
  enforceDeckEmojiBudget,
  guardContextPercents,
  guardContextTimes,
  stripCodeFence,
  validateDeckLinesDetailed,
  wrapQuestionViolation,
  wrapReflectionViolation,
  type LineGuardContext,
  type WrapLineRejection,
} from './wrapNarrativeShared'
import { buildPeriodFactTable, groundingFormsForRuntime } from './wrapFactTable'

function periodWord(period: WrappedPeriod): string {
  return period === 'week' ? 'week' : period === 'month' ? 'month' : 'year'
}

/** Mirrors the day wrap's time contract: clock strings are copied, never
 *  recomputed, never moved to a different part of the day. */
const PERIOD_TIME_LITERACY = [
  'HOW TO READ TIMES. Every time in the facts is a local 12-hour clock string.',
  '"12am" is midnight, the start of the day. "12pm" is noon. "12:27pm" is early afternoon, 27 minutes after noon, never night.',
  'CLOCK RULE, STRICT: You may write a clock time on a slide ONLY if that exact time appears in THAT slide\'s own facts, copied CHARACTER FOR CHARACTER. Never round it (write "11:29pm", never "11pm" or "past 11"), never do clock arithmetic, never move a time onto a slide whose facts do not list it. "noon" and "midnight" ARE clock claims (12pm and 12am): write them only when that slide\'s facts hold exactly that time. Never write "dinnertime"; meals are a guess.',
  'To place something in time without a grounded clock, name the PART OF DAY or the DAY ("Tuesday", "the mornings", "the evenings"), never a bare clock the facts did not give you. "5pm", "9am" are clock times, not parts of day.',
].join(' ')

/** Rotating emphasis, seeded by the period anchor, so consecutive weeks and
 *  months never read as the same script re-run. */
const PERIOD_ANGLES = [
  'This one, lead with the shape: where it peaked, where it breathed.',
  'This one, lead with the craft: the thread that mattered most and how the days served it.',
  'This one, lead with the single moment worth keeping, and let the rest orbit it.',
  'This one, lead with the contrast between the loud days and the quiet ones, plainly.',
  'This one, lead with the person: what this stretch says about how they work.',
] as const

/** Bumped whenever the period wrap's prompt semantics change (directives,
 *  contract, slide asks), so a stored analysis version records WHICH prompt
 *  produced it (DEV-206: reproducible, inspectable versions). */
export const PERIOD_WRAP_PROMPT_VERSION = 2

export function computePeriodFactsHash(facts: WrappedPeriodFacts): string {
  const bucket = (s: number) => Math.round(s / 60)
  const canonical = JSON.stringify({
    period: facts.period,
    anchor: facts.anchorDate,
    total: bucket(facts.totalSeconds),
    work: bucket(facts.workSeconds),
    leisure: bucket(facts.leisureSeconds),
    prev: bucket(facts.previousPeriodSeconds),
    days: facts.daysWithActivity,
    dom: facts.dominantWorkCategory,
    domPct: facts.dominantWorkCategoryPct,
    cats: facts.categories.map((c) => [c.category, bucket(c.seconds)]),
    apps: facts.topApps.map((a) => [a.appName.toLowerCase(), bucket(a.seconds)]),
    threads: facts.threads.map((t) => [t.subject.toLowerCase(), bucket(t.seconds), t.daysActive]),
    busy: facts.busiestDay ? [facts.busiestDay.dateStr, bucket(facts.busiestDay.totalSeconds)] : null,
    long: facts.longestStretch ? [facts.longestStretch.label.toLowerCase(), bucket(facts.longestStretch.seconds)] : null,
    buckets: facts.buckets.map((b) => [b.label, bucket(b.totalSeconds)]),
  })
  return createHash('sha1').update(canonical).digest('hex').slice(0, 12)
}

export function periodNarrativeCacheKey(facts: WrappedPeriodFacts, factsHash: string): string {
  return `${facts.period}|${facts.anchorDate}|${factsHash}`
}

function guardContext(facts: WrappedPeriodFacts, slides: WrapSlideSpec[]): LineGuardContext {
  // Week ±1.5h; month ±5h; year ±20h — bigger periods round looser.
  const tolerance = facts.period === 'week' ? 1.5 : facts.period === 'month' ? 5 : 20
  // Durations ground against everything the writer saw: the compact facts JSON
  // plus every slide's own card text. This is what killed the week bench at
  // 8.0-8.3: a hand-rounded "8h 57m" (facts: 8h 58m) and a self-computed delta
  // sailed past the old excess-only hour check and cost accuracy 0 at the judge.
  const durationSource = [
    JSON.stringify(compactPeriodFacts(facts)),
    ...slides.map((s) => `${s.kicker} ${s.factsNote} ${s.stat?.value ?? ''} ${s.stat?.sublabel ?? ''} ${s.ask}`),
  ].join(' ')
  return {
    totalHours: facts.totalSeconds / 3600,
    hourTolerance: tolerance,
    allowedPercents: guardContextPercents(slides),
    allowedTimes: guardContextTimes(slides),
    allowedDurations: durationTokensIn(durationSource),
    // Period facts carry no output evidence (no git/notes enrichment rides a
    // period wrap today), so completion claims are always unverified here.
    outputVerified: false,
    // The fact-table backstop: every numeric token in a line must match the
    // period's fact table or a number the writer was shown.
    groundedNumericForms: groundingFormsForRuntime(buildPeriodFactTable(facts), durationSource),
  }
}

export function buildPeriodPrompts(facts: WrappedPeriodFacts): { systemPrompt: string; userMessage: string } {
  const label = periodWord(facts.period)
  const slides = planPeriodWrapSlides(facts)

  const systemPrompt = [
    VOICE_SYSTEM_PROMPT,
    `You are Daylens, writing a Spotify-Wrapped-style ${label} recap for one person, slide by slide, as if an AI who watched the whole ${label} sat down at its end and reflected on it with them. Every reveal should feel written for THIS ${label}, never a template.`,
    `You will receive a compact JSON facts object summed from this ${label}'s frozen daily snapshots, plus the list of slides with the exact facts each slide shows. Phrase ONLY what is in them. Never invent a number, an app, a project, a record, or a superlative.`,
    DECK_JSON_CONTRACT,
    PERIOD_TIME_LITERACY,
    ...EVIDENCE_HONESTY_DIRECTIVES,
    // Interpretation half only, for the same reason as the day deck.
    ...INTERPRETATION_DIRECTIVES,
    'Each slide line is one or two sentences, written to the person ("you"), specific, never generic. Stat/caption slides stay tight (under ~200 characters); the thread and story beats may run to two full sentences. The curious question stays under ~200 characters and contains NO clock time and NO percentage.',
    'ADD A READ, DO NOT RESTATE. On every stat slide the slide\'s OWN big number is already printed huge on the card. Do not make that one number the subject of your sentence and do not merely repeat it. Lead with what it MEANS. BUT your line must still be concrete: anchor it in at least one real detail that is NOT that headline number, for example the real thread or work, a real day, or a real supporting figure. Never go vague or generic to avoid the number.',
    'THE REGISTER, by example (never copy these, match their honesty): "Tuesday morning you went straight into the code and stayed there for two and a half hours before your first break." / "Wednesday carried the week and Thursday paid for it, which is a fair trade." / "Three of the five days ended after 11pm, and the work shows where those hours went."',
    'IN A THREAD OR STORY BEAT, CHOOSE, DO NOT ENUMERATE. Name the one or two things that mattered most, never a long list; listing everything reads like a report and runs too long.',
    'If the user profile gives their first name, use it naturally on one or two slides at most, like a friend would, especially when giving earned credit.',
    'EARNED PRAISE IS ALLOWED and welcome when the facts back it: the longest stretch, the biggest day, a thread carried across many days. Say it plainly, with their name if you have it. You may end AT MOST ONE line in the whole deck with a single celebratory emoji from this set: 🏆 🔥 🌙 🎯 ☕ ✨. Never more than one emoji total, never mid-sentence, never unearned.',
    'STATE ONLY WHAT THE FACTS GIVE YOU. Do not add comparative or consistency claims the facts do not contain ("more than the rest combined", "held even across the week", "every day", "back to back"); if a fact does not state it, do not imply it. A smaller true detail beats a bigger claim you cannot ground.',
    'NAME THE WORK, NEVER THE FILE. Use the humanized thread names in the facts. Never print a filename, folder, repo, branch, tab title, or video title.',
    'Tools and apps may be named ONLY on the slides whose facts contain them (timesink, apps, forgotten, leisure). Everywhere else, say what was being made. A tool (Claude Code, Cursor, Warp, Canva) is the instrument, never the thing being made.',
    `Main mode = facts.dominantWorkCategory, the actual WORK, never leisure. A working person's ${label} is never "mostly entertainment" because a few videos played on the side.`,
    'NEVER grade: no focus score, no drift, no productivity score. Write a percentage ONLY on the work-versus-leisure split slide, and only the exact percentages that slide hands you; never put a percentage on any other slide.',
    'BANNED WORDS, never write any of them, not even to negate them: "productive", "productivity", "drift", "focused", "focus score", "dinnertime". "Distraction" may name the live distraction profile or a leisure surface; do not use it to scold. Part-of-day words ("morning", "midday", "the evenings", "late into the night") are free prose; use them naturally and accurately. But "noon" and "midnight" are CLOCK TIMES, exactly like "12pm" and "12am": write them ONLY when that exact time is in the slide\'s own facts. A night that ended at 11:55pm ended at 11:55pm, never "midnight"; copy the listed clock or say "late into the night".',
    'DO NOT DEFEND OR JUSTIFY REST OR LEISURE. Never argue that downtime was "not drift", "not a distraction", "deliberate", or "earned". Rest is allowed and needs no defense; say plainly what happened and move on.',
    'Never state how MANY meetings there were; the facts only know the total meeting time.',
    `NEVER predict the next ${label}, NEVER say anything carries forward or needs picking up, NEVER assign homework. The recap looks back, never ahead.`,
    'Never use an em dash anywhere. Use a comma, a period, or "and". Use "to" for ranges, never a dash.',
    'Copy every duration exactly as the facts pre-format it; never round or invent a duration (if the facts say 42m, never write "45 minutes"). Never re-express a total in other units ("nearly two full days of meetings"); say the pre-formatted duration or nothing.',
    'Never describe yourself as a model.',
    PERIOD_ANGLES[seedFromDate(facts.anchorDate) % PERIOD_ANGLES.length],
  ].join(' ')

  const userMessage = [
    `Period: ${label}`,
    `Range: ${facts.rangeLabel}`,
    '',
    'Compact facts JSON:',
    JSON.stringify(compactPeriodFacts(facts), null, 2),
    '',
    deckPromptSection(slides),
    '',
    'Return ONLY the JSON object.',
  ].join('\n')

  return { systemPrompt, userMessage }
}

/** The model-facing projection: pre-formatted durations, no epoch numbers.
 *  Exported so ask-anything answers ground in what the wrap narrated. */
export function compactPeriodFacts(facts: WrappedPeriodFacts) {
  const hm = (s: number) => formatHm(s)
  return {
    period: facts.period,
    range: facts.rangeLabel,
    total: hm(facts.totalSeconds),
    split: { work: hm(facts.workSeconds), leisure: hm(facts.leisureSeconds), personal: hm(facts.personalSeconds) },
    activeDays: facts.daysWithActivity,
    previousPeriodTotal: facts.previousPeriodSeconds > 0 ? hm(facts.previousPeriodSeconds) : null,
    mainMode: facts.dominantWorkCategory,
    threads: facts.threads.map((t) => ({ subject: t.subject, time: hm(t.seconds), days: t.daysActive })),
    apps: facts.topApps.map((a) => ({ name: a.appName, time: hm(a.seconds) })),
    workByKind: facts.categories.map((c) => ({ kind: c.category, time: hm(c.seconds) })),
    leisureSurfaces: facts.leisureSurfaces,
    days: facts.days.map((d) => ({ day: d.dayLabel, total: hm(d.totalSeconds), work: hm(d.workSeconds), leisure: hm(d.leisureSeconds) })),
    busiestDay: facts.busiestDay ? { day: facts.busiestDay.dayLabel, total: hm(facts.busiestDay.totalSeconds) } : null,
    quietestDay: facts.quietestActiveDay ? { day: facts.quietestActiveDay.dayLabel, total: hm(facts.quietestActiveDay.totalSeconds) } : null,
    longestStretch: facts.longestStretch
      ? { time: hm(facts.longestStretch.seconds), day: facts.longestStretch.dayLabel, from: facts.longestStretch.startClock ?? null }
      : null,
    meetings: facts.meetingsSeconds > 0 ? hm(facts.meetingsSeconds) : null,
    dayEdges: facts.dayEdges.map((e) => ({ day: e.dayLabel, first: e.firstClock, last: e.lastClock })),
  }
}

/** Parse the model's raw response into the deck JSON object, or null. */
export function parsePeriodWrapResponse(raw: string): Record<string, unknown> | null {
  const jsonText = stripCodeFence(raw).trim()
  if (!jsonText) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  return parsed as Record<string, unknown>
}

export interface PeriodNarrativeValidation {
  /** Null only when the OPENING died — the wrap has no lead to show. */
  narrative: WrappedPeriodNarrative | null
  /** Every rejected piece with its writer-facing reason (repair-round input). */
  rejections: WrapLineRejection[]
}

/** Validate a parsed period deck response, recording every guard death with
 *  its reason so one repair round can rewrite exactly the failed pieces. */
export function validatePeriodNarrativeObject(
  obj: Record<string, unknown>,
  facts: WrappedPeriodFacts,
  factsHash: string,
): PeriodNarrativeValidation {
  const slides = planPeriodWrapSlides(facts)
  const ctx = guardContext(facts, slides)
  const linesRaw = (obj.lines && typeof obj.lines === 'object') ? obj.lines as Record<string, unknown> : null
  const { lines, rejections } = validateDeckLinesDetailed(linesRaw, slides, ctx)

  const question = wrapQuestionViolation(obj.question, ctx)
  if (question.reason) rejections.push({ id: 'question', candidate: typeof obj.question === 'string' ? obj.question : null, reason: question.reason })
  const reflection = wrapReflectionViolation(obj.reflection, ctx)
  if (reflection.reason) rejections.push({ id: 'reflection', candidate: typeof obj.reflection === 'string' ? obj.reflection : null, reason: reflection.reason })

  // Per-line emoji rules passed; now the DECK contract: at most one emoji in
  // the whole wrap. Later emoji-bearing pieces die and go to the repair round.
  const budget = enforceDeckEmojiBudget(lines, slides, question.value, reflection.value)
  rejections.push(...budget.rejections)

  const lead = budget.lines.opening
  if (!lead) return { narrative: null, rejections }

  return {
    narrative: {
      period: facts.period,
      lead,
      lines: budget.lines,
      question: budget.question,
      reflection: budget.reflection,
      source: 'ai',
      factsHash,
    },
    rejections,
  }
}

export function validatePeriodNarrativeResponse(
  raw: string,
  facts: WrappedPeriodFacts,
  factsHash: string,
): WrappedPeriodNarrative | null {
  const obj = parsePeriodWrapResponse(raw)
  if (!obj) return null
  return validatePeriodNarrativeObject(obj, facts, factsHash).narrative
}

/** The repair-round user message for this period's rejections. */
export function buildPeriodRepairMessage(facts: WrappedPeriodFacts, rejections: WrapLineRejection[]): string {
  return buildRepairUserMessage(planPeriodWrapSlides(facts), rejections)
}

/** Overlay the repair round's rewrites onto the original response object —
 *  ONLY for the pieces that were rejected; accepted lines are final. */
export function mergePeriodWrapRepair(
  original: Record<string, unknown>,
  repairRaw: string,
  rejections: WrapLineRejection[],
): Record<string, unknown> {
  const repair = parsePeriodWrapResponse(repairRaw)
  if (!repair) return original
  const rejectedIds = new Set(rejections.map((r) => r.id))
  const originalLines = (original.lines && typeof original.lines === 'object') ? original.lines as Record<string, unknown> : {}
  const repairLines = (repair.lines && typeof repair.lines === 'object') ? repair.lines as Record<string, unknown> : {}
  const mergedLines: Record<string, unknown> = { ...originalLines }
  for (const [id, value] of Object.entries(repairLines)) {
    if (rejectedIds.has(id)) mergedLines[id] = value
  }
  return {
    ...original,
    lines: mergedLines,
    question: rejectedIds.has('question') && repair.question != null ? repair.question : original.question,
    reflection: rejectedIds.has('reflection') && repair.reflection != null ? repair.reflection : original.reflection,
  }
}

// ─── Deterministic baseline ─────────────────────────────────────────────────
// Template text must never be shown as the wrap. This baseline is
// the internal last resort when a CONNECTED provider returns unusable output:
// every slide renders its deterministic fallbackLine.

// ─── Fact-only weekly brief line (deterministic) ─────────────────────────────
// The weekly brief's honest floor, mirroring the evening recap's
// factOnlyRecapLine: when no provider can write the brief, the notification
// carries a line made ONLY of the week's summed frozen-snapshot facts — the
// same totals the week wrap and Timeline show — or nothing at all.
// Fallback order: this line, then silence. Never a canned teaser.

export function factOnlyWeeklyLine(facts: WrappedPeriodFacts): string | null {
  if (facts.period !== 'week') return null
  if (facts.totalSeconds <= 0 || facts.daysWithActivity <= 0) return null
  const total = formatHm(facts.totalSeconds)
  const days = facts.daysWithActivity === 1
    ? 'one tracked day'
    : `${facts.daysWithActivity} tracked days`
  const top = facts.threads[0]
  const thread = top?.subject ? `, the biggest thread ${top.subject}` : ''
  return `${total} on screen across ${days}${thread}.`
}

export function buildPeriodFallbackNarrative(
  facts: WrappedPeriodFacts,
  factsHash: string,
): WrappedPeriodNarrative {
  const label = periodWord(facts.period)

  if (facts.totalSeconds <= 0) {
    return {
      period: facts.period,
      // Honest and product-voice-legal: the app never narrates in its own name
      // (voice.md §2.8) — the old copy ("Daylens did not see ...") broke the
      // very rule the overclaim guard enforces on AI lines.
      lead: `Not enough tracked this ${label} to tell a real story yet.`,
      lines: {}, question: null, reflection: null,
      source: 'fallback',
      factsHash,
    }
  }

  const slides = planPeriodWrapSlides(facts)
  const opening = slides.find((s) => s.id === 'opening')
  const question = slides.find((s) => s.id === 'question')
  const reflection = slides.find((s) => s.id === 'reflection')
  return {
    period: facts.period,
    lead: opening?.fallbackLine ?? `${formatHm(facts.totalSeconds)} this ${label}.`,
    lines: {},
    question: question?.fallbackLine ?? null,
    reflection: reflection?.fallbackLine ?? null,
    source: 'fallback',
    factsHash,
  }
}
