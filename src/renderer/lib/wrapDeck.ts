// The Wrapped slide planner — ONE deterministic plan both sides read.
//
// `planDayWrapSlides` / `planPeriodWrapSlides` turn the reconciled facts into an
// ordered list of slide specs. The main process builds the AI prompt from the
// same plan the renderer draws, keyed by slide id, so a line can never land on
// the wrong card and the AI can never add a slide the facts don't support.
// Every number on a spec IS a facts number; the AI only writes prose around it.
//
// Pure (no React, no IPC) so it runs in main for prompts and in tests directly.

import type { WrappedPeriodFacts } from '@shared/types'
import {
  formatHm,
  gapKindPhrase,
  lowerName,
  seedFromDate,
  workActionPhrase,
  type DayWrapFacts,
} from './dayWrapScenes'
import { largestRemainderPercentages, looksLikeRawArtifactLabel } from './wrappedFacts'

export { formatHm }

// ─── Spec shapes ──────────────────────────────────────────────────────────────

export type WrapSlideKind =
  | 'opening'     // the punchy one-line read on the whole period
  | 'stat'        // one big number, revealed with a count-up
  | 'bars'        // a ranked bar list (apps, threads)
  | 'shape'       // the period silhouette (per-day / per-bucket bars)
  | 'split'       // two-sided ratio (work vs leisure)
  | 'compare'     // this period against the previous one
  | 'text'        // prose-led beat (story segments, the forgotten thing)
  | 'coverage'    // what this wrap saw and what it didn't (deterministic, never AI)
  | 'question'    // interactive: the AI asks, the user can answer inline
  | 'reflection'  // the finale paragraph, written like a message
  | 'finale'      // share card + export

export interface WrapSlideStat {
  /** Pre-formatted display value ("3h 41m", "6:12am", "4"). */
  value: string
  /** Present when the value is a duration, for the count-up. */
  seconds?: number
  sublabel?: string
}

export interface WrapSlideBar { name: string; seconds: number; detail?: string }

// ─── Coverage (what the wrap is built on) ─────────────────────────────────────
// Every wrap carries one deterministic coverage slide: the observed window, the
// evidence sources that were actually available, and the ones that weren't — so
// a thin day looks honestly thin instead of dressed up. The AI never writes
// this slide (ask: ''), so it can never overclaim.

export interface WrapCoverageSource { name: string; present: boolean }

export interface WrapCoverageCard {
  /** "11:15am to 8:04pm on this computer", or a day-count line for periods. */
  windowLabel: string | null
  sources: WrapCoverageSource[]
  note: string
}

export interface WrapCoverageInput {
  /** True when browser/tab context was observed this day. */
  browser?: boolean
  /** Connector presence when the caller knows it (preflight / enrichment).
   *  Undefined/null = unknown: the card then lists nothing about connectors
   *  rather than falsely claiming they were absent. */
  connectors?: { calendar: boolean; git: boolean; focus: boolean; notes: boolean } | null
}

export interface WrapSlideSpec {
  /** Stable id — the key the AI's line comes back under. */
  id: string
  kind: WrapSlideKind
  /** Deterministic eyebrow ("THE LONGEST STRETCH", "TUESDAY · 9am to 12pm"). */
  kicker: string
  stat?: WrapSlideStat
  bars?: WrapSlideBar[]
  buckets?: Array<{ label: string; seconds: number; peak: boolean }>
  split?: { aLabel: string; aPct: number; aSeconds: number; bLabel: string; bPct: number; bSeconds: number }
  compare?: { currentLabel: string; currentSeconds: number; previousLabel: string; previousSeconds: number }
  coverage?: WrapCoverageCard
  /** The honest deterministic line shown when the AI line is missing/rejected. */
  fallbackLine: string
  /** What the AI should write for this slide. '' = deterministic-only slide. */
  ask: string
  /** Compact true facts for this slide — echoed into the prompt and into
   *  ask-anything so answers stay grounded in what the card shows. */
  factsNote: string
}

export interface WrapDeckMeta {
  title: string        // "Your day, wrapped" / "Your week, wrapped"
  rangeLabel: string   // "TUESDAY · JUN 24" / "JUN 16 – JUN 22"
  headline: string     // the one number ("8h 59m")
  footer: string       // "wrapped by Daylens"
}

/** The line a slide actually shows: the validated AI line, else the floor. */
export function resolveSlideLine(
  spec: WrapSlideSpec,
  lines: Record<string, string | null> | null | undefined,
): string {
  const line = lines?.[spec.id]
  return (typeof line === 'string' && line.trim()) ? line.trim() : spec.fallbackLine
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function pct2(a: number, b: number): [number, number] {
  const [pa, pb] = largestRemainderPercentages([a, b])
  return [pa, pb]
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** Deterministic per-seed shuffle (LCG + Fisher-Yates). Same seed → same order
 *  (a wrap is stable on reopen); adjacent days get a different middle, so the
 *  deck never feels like the same run-sheet every day. */
export function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = items.slice()
  let state = (seed >>> 0) || 1
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

// ─── Coverage slides (deterministic, never AI-written) ───────────────────────

function buildDayCoverageSlide(facts: DayWrapFacts, input?: WrapCoverageInput): WrapSlideSpec {
  const startClock = facts.mainStartClock ?? facts.ribbonStartClock
  const windowLabel = startClock && facts.ribbonEndClock
    ? `${startClock} to ${facts.ribbonEndClock} on this computer`
    : null
  const sources: WrapCoverageSource[] = [
    { name: 'Apps and windows', present: facts.activeSeconds > 0 },
  ]
  if (input?.browser !== undefined) sources.push({ name: 'Browser activity', present: Boolean(input.browser) })
  if (input?.connectors) {
    sources.push(
      { name: 'Calendar', present: input.connectors.calendar },
      { name: 'Git commits', present: input.connectors.git },
      { name: 'Focus timers', present: input.connectors.focus },
      { name: 'Meeting notes', present: input.connectors.notes },
    )
  }
  const seen = sources.filter((s) => s.present).map((s) => s.name.toLowerCase())
  const absent = sources.filter((s) => !s.present).map((s) => s.name.toLowerCase())
  const fallbackLine = [
    windowLabel
      ? `Built from ${formatHm(facts.activeSeconds)} of tracked activity, ${windowLabel}.`
      : `Built from ${formatHm(facts.activeSeconds)} of tracked activity on this computer.`,
    facts.quality === 'partial' ? 'That is a thin slice of a day, so this wrap stays small.' : null,
    "Time Daylens didn't observe isn't in the story.",
  ].filter(Boolean).join(' ')
  return {
    id: 'coverage', kind: 'coverage', kicker: 'What this wrap is built on',
    coverage: { windowLabel, sources, note: "Time Daylens didn't observe isn't in the story." },
    fallbackLine,
    ask: '', // deterministic by design: the coverage card can never overclaim
    factsNote: `observed ${formatHm(facts.activeSeconds)}${windowLabel ? `, ${windowLabel}` : ''}; sources with data: ${seen.join(', ') || 'none'}${absent.length ? `; no data from: ${absent.join(', ')}` : ''}; unobserved time is not represented`,
  }
}

// ─── Day plan ─────────────────────────────────────────────────────────────────

export function planDayWrapSlides(facts: DayWrapFacts, coverage?: WrapCoverageInput): WrapSlideSpec[] {
  const out: WrapSlideSpec[] = []
  const hm = formatHm

  // 1 · Opening — the one-sentence read. The AI writes it; the fallback is honest.
  out.push({
    id: 'opening', kind: 'opening', kicker: `${facts.weekday} · ${facts.dateLabel}`,
    fallbackLine: facts.isLeisureDay
      ? 'Mostly off the clock today.'
      : facts.activeSeconds >= 6 * 3600 ? 'A long, full day.' : facts.activeSeconds >= 3 * 3600 ? 'A solid working day.' : 'A lighter one.',
    ask: 'One punchy opening sentence on what kind of day this was. Name the one real thing that defined it (the actual work or the true shape of the day), concretely, in plain words. No numbers, and no stack of hyphenated adjectives; a friend naming the day, not a label.',
    factsNote: `total ${hm(facts.activeSeconds)}, work ${hm(facts.workSeconds)}, leisure ${hm(facts.leisureSeconds)}${facts.isLeisureDay ? ', mostly a rest day' : ''}${facts.workActivities[0] ? `, the day was mostly ${workActionPhrase(facts.workActivities[0].name, facts.workActivities[0].category)}` : ''}`,
  })

  // 2 · Headline number. The stat itself IS the number; the line must ADD
  // something (when it started, how it spread) and never restate the total.
  // The day's start is `mainStartClock` — the first REAL beat, never a
  // spillover sliver from last night, so "your day ran 12am to 8pm" cannot happen.
  const startClock = facts.mainStartClock ?? facts.ribbonStartClock
  const spilloverBeat = facts.dayStory.find((s) => s.spillover)
  const span = startClock && facts.ribbonEndClock ? `${startClock} to ${facts.ribbonEndClock}` : null
  out.push({
    id: 'headline', kind: 'stat', kicker: 'The day, in one number',
    stat: { value: hm(facts.activeSeconds), seconds: facts.activeSeconds, sublabel: span ?? 'active time' },
    fallbackLine: span ? `Your day ran from ${startClock} to ${facts.ribbonEndClock}.` : 'That is the whole of it, active time only.',
    ask: 'One short line under the day-total number that ADDS a real read the number does not already say. It MUST name a concrete anchor: the real work that filled the day AND where in the day its weight sat (a part of day, or this slide\'s own start/end clocks). On a rest day the concrete anchor is the real downtime: name the actual leisure surface from the facts, not a shrug; "mid-morning" or "the screen time that showed up" is not an anchor. Do not restate the total, do not write "tracked across the day" or "start to finish", do not lean on vague adjectives, and do not imply the day ran to midnight.',
    factsNote: `total ${hm(facts.activeSeconds)}, the day proper began ${startClock ?? 'unknown'}, last activity ${facts.ribbonEndClock ?? 'unknown'}${facts.isLeisureDay
      ? `. This was MOSTLY A REST DAY, so lead the read with the downtime, not the work${facts.workActivities[0] ? ` (the only real work was ${workActionPhrase(facts.workActivities[0].name, facts.workActivities[0].category)}, a small part of the day)` : ''}`
      : facts.workActivities[0] ? `, the day's main work was ${workActionPhrase(facts.workActivities[0].name, facts.workActivities[0].category)}` : ''}${spilloverBeat ? `. (A short ${hm(spilloverBeat.seconds)} pre-dawn tail belongs to LAST night, not this day's start, so do not frame the day as running late into the night on the strength of it.)` : ''}`,
  })

  // 2b · Coverage — what this wrap saw and what it didn't. Deterministic and
  // pinned right after the headline so a thin day announces its thinness up
  // front instead of dressing up.
  out.push(buildDayCoverageSlide(facts, coverage))

  // 2c · What the day was about — the entities the evidence supports naming
  // (projects, clients, people, meetings, repositories from the durable
  // ledger). Pinned before the story so the day's subjects lead it; absent
  // when the ledger supports nothing, never padded.
  const entities = facts.entities ?? []
  if (entities.length > 0) {
    const [first, second] = entities
    out.push({
      id: 'about', kind: 'bars', kicker: 'What the day was about',
      bars: entities.map((e) => ({ name: e.name, seconds: e.seconds, detail: entityTypeWord(e.type) })),
      fallbackLine: second
        ? `Mostly ${first.name}, with ${second.name} in the mix.`
        : `Mostly ${first.name}.`,
      ask: `The day's own subjects, by evidence: ${entities.slice(0, 3).map((e) => `${e.name} (${entityTypeWord(e.type)})`).join(', ')}. One line on what the day was actually about, naming the one or two that defined it. Use ONLY these names; never invent a project, client, person, or meeting the facts do not list.`,
      factsNote: entities.map((e) => `${e.name} (${entityTypeWord(e.type)}): ${hm(e.seconds)}`).join(', '),
    })
  }

  // 3-6 · The day as a story, in chronological order, from the real segments.
  // dayStory is already ordered late-night → evening; a pre-dawn leftover is its
  // own beat, so it never merges into "morning".
  for (const seg of facts.dayStory) {
    if (seg.items.length === 0) continue
    out.push({
      id: `story-${seg.part}`, kind: 'text', kicker: `${seg.label} · ${seg.clockStart} to ${seg.clockEnd}`,
      fallbackLine: seg.spillover
        ? `Before bed, a last ${hm(seg.seconds)} of ${seg.items.slice(0, 1).map(lowerName).join('')}.`
        : `${seg.label} went to ${seg.items.slice(0, 2).map(lowerName).join(' and ')}.`,
      ask: seg.spillover
        ? 'This short stretch just after midnight was the TAIL OF THE PREVIOUS NIGHT, before bed. One line that frames it as winding down last night, never as starting this day.'
        : `Narrate this ${seg.label.toLowerCase()} stretch like a friend who was there, in at most two sentences. Name only the one or two things that mattered most, never all of them and never as a list.${seg.aside ? ' You may own the leisure aside with one kind clause.' : ''}`,
      factsNote: `${seg.clockStart} to ${seg.clockEnd}, ${hm(seg.seconds)}: ${seg.items.join('; ')}${seg.aside ? `; also some ${seg.aside}` : ''}${seg.spillover ? ' (spillover from last night)' : ''}`,
    })
  }

  // ── The middle: variable, seeded. Collected into a pool and shuffled so the
  // deck's rhythm is different every day but identical on reopen. ──
  const middle: WrapSlideSpec[] = []
  const pushMiddle = (spec: WrapSlideSpec) => middle.push(spec)

  // 6 · The longest unbroken stretch — the focus reveal.
  if (facts.standout) {
    pushMiddle({
      id: 'focus', kind: 'stat', kicker: 'Your longest unbroken stretch',
      stat: { value: hm(facts.standout.seconds), seconds: facts.standout.seconds, sublabel: `${facts.standout.name} · ${facts.standout.startClock} to ${facts.standout.endClock}` },
      fallbackLine: `${hm(facts.standout.seconds)} straight on ${lowerName(facts.standout.name)}, ${facts.standout.startClock} to ${facts.standout.endClock}. Nothing broke it.`,
      ask: 'The longest unbroken stretch of the day. Do not just state the duration (it is on the card); lead with what that run MEANT: the deepest unbroken run of the day, the one thing nothing interrupted, or when in the day that kind of depth landed. Name the real work being done. Never write "focus" or "focused"; the unbroken time is the fact, attention is not observable.',
      factsNote: `${hm(facts.standout.seconds)} on ${facts.standout.name}, ${facts.standout.startClock} to ${facts.standout.endClock}`,
    })
  }

  // 7 · The biggest time sink — named surface, honestly framed.
  const sink = facts.appSites.find((s) => s.kind !== 'other')
  if (sink && sink.seconds >= 20 * 60) {
    pushMiddle({
      id: 'timesink', kind: 'stat', kicker: 'Where the most time pooled',
      stat: { value: hm(sink.seconds), seconds: sink.seconds, sublabel: sink.name },
      fallbackLine: `${sink.name} held ${hm(sink.seconds)}, more than anything else.`,
      ask: `${sink.name} took the most time. Say whether that reads as the work or as the leak, honestly, given its category (${sink.category}). No scolding, no cheerleading.`,
      factsNote: `${sink.name}: ${hm(sink.seconds)}, category ${sink.category}, of ${hm(facts.activeSeconds)} total`,
    })
  }

  // 8 · Where the time went — the one chart card.
  if (facts.appSites.length >= 2) {
    pushMiddle({
      id: 'apps', kind: 'bars', kicker: 'Where the time went',
      bars: facts.appSites.map((s) => ({ name: s.name, seconds: s.seconds })),
      fallbackLine: `${facts.appSites[0].name} led the day.`,
      ask: 'One short caption for the app and site chart, a read on its SHAPE (concentrated in one or two tools, or spread thin), and NAME at least one real app or site from the chart. Never add up or compare the bar values numerically and never claim one nearly matched another; the chart already shows the sizes.',
      // The remainder bucket stays on the rendered bars (the chart must sum to
      // the headline) but never reaches the writer — "Other" is chart
      // plumbing, not a nameable surface of the day.
      factsNote: facts.appSites.filter((s) => s.kind !== 'other').map((s) => `${s.name} ${hm(s.seconds)}`).join(', '),
    })
  }

  // 9 · Work vs leisure, the honest split.
  if (facts.workSeconds > 0 && facts.leisureSeconds > 0) {
    const [wp, lp] = pct2(facts.workSeconds, facts.leisureSeconds)
    pushMiddle({
      id: 'split', kind: 'split', kicker: 'The honest split',
      split: { aLabel: 'Work', aPct: wp, aSeconds: facts.workSeconds, bLabel: 'Leisure', bPct: lp, bSeconds: facts.leisureSeconds },
      fallbackLine: `${wp}% work, ${lp}% leisure. That is the real ratio.`,
      ask: `The day split ${wp}% work to ${lp}% leisure. Frame it honestly, no judgment, no grade. You may reference exactly these percentages.`,
      factsNote: `work ${hm(facts.workSeconds)} (${wp}%), leisure ${hm(facts.leisureSeconds)} (${lp}%)`,
    })
  }

  // 10 · Late night / early start, from the real ribbon clocks.
  if (facts.ribbon.length > 0) {
    const firstHour = new Date(facts.ribbon[0].startMs).getHours()
    const lastHour = new Date(facts.ribbon[facts.ribbon.length - 1].endMs).getHours()
    if (firstHour > 0 && firstHour <= 6) {
      pushMiddle({
        id: 'earlystart', kind: 'stat', kicker: 'An early one',
        stat: { value: facts.ribbonStartClock ?? '', sublabel: 'when the day started' },
        fallbackLine: `The day started at ${facts.ribbonStartClock}. That is early.`,
        ask: 'The day started unusually early. One line that names the real clock time and lets it speak.',
        factsNote: `first activity ${facts.ribbonStartClock}`,
      })
    } else if (lastHour >= 22 || lastHour < 4) {
      pushMiddle({
        id: 'latenight', kind: 'stat', kicker: 'It ran late',
        stat: { value: facts.ribbonEndClock ?? '', sublabel: 'when the day ended' },
        fallbackLine: `The last activity landed at ${facts.ribbonEndClock}.`,
        ask: 'The day ran late. Name the real end-of-day clock time AND add one honest read on what finishing that late says about the day (a long one, still in it, hard to close the laptop), never a scold and never inventing why.',
        factsNote: `last activity ${facts.ribbonEndClock}`,
      })
    }
  }

  // 11 · The thing you probably forgot — a real surface outside the top three.
  const forgotten = facts.appSites.filter((s) => s.kind !== 'other').slice(3).find((s) => s.seconds >= 10 * 60)
  if (forgotten) {
    pushMiddle({
      id: 'forgotten', kind: 'stat', kicker: 'You probably forgot this one',
      stat: { value: hm(forgotten.seconds), seconds: forgotten.seconds, sublabel: forgotten.name },
      fallbackLine: `${forgotten.name} quietly took ${hm(forgotten.seconds)} today.`,
      ask: `${forgotten.name} took ${hm(forgotten.seconds)} without being any of the day's big things. One line that surfaces it as the "oh right, that" moment.`,
      factsNote: `${forgotten.name}: ${hm(forgotten.seconds)}, ranked outside the top 3 surfaces`,
    })
  }

  // 12 · Meetings, when the day actually had them.
  if (facts.meetingsSeconds >= 30 * 60) {
    pushMiddle({
      id: 'meetings', kind: 'stat', kicker: 'In meetings and calls',
      stat: { value: hm(facts.meetingsSeconds), seconds: facts.meetingsSeconds },
      fallbackLine: `${hm(facts.meetingsSeconds)} went to meetings and calls.`,
      ask: 'One line on the meeting time, plain and factual.',
      factsNote: `meetings ${hm(facts.meetingsSeconds)} of ${hm(facts.workSeconds)} work`,
    })
  }

  // 12b · The day's real holes — gaps are facts (day-recap-and-analysis.md).
  // The biggest untracked stretch gets the card; every 45m+ gap rides in the
  // facts so the prose can tell the truth instead of implying a continuous
  // grind. Deterministic fallback says it plainly, with the calendar match
  // when the day's schedule explains the hole.
  const gapFacts = facts.gaps ?? []
  if (gapFacts.length > 0) {
    // A 'passive' gap is screen ON, hands off — headlining it "Off the
    // screen" contradicts its own phrase. The card prefers the biggest gap
    // that really was time away; only a day whose every gap is passive gets
    // the passive card, honestly titled.
    const awayGaps = gapFacts.filter((gap) => gap.kind !== 'passive')
    const biggest = (awayGaps.length > 0 ? awayGaps : gapFacts)
      .reduce((a, b) => (b.minutes > a.minutes ? b : a))
    const passive = biggest.kind === 'passive'
    const gapSeconds = Math.round((biggest.toMs - biggest.fromMs) / 1000)
    const phrase = gapKindPhrase(biggest.kind)
    pushMiddle({
      id: 'away', kind: 'stat', kicker: passive ? 'Screen on, hands off' : 'Off the screen',
      stat: {
        value: hm(gapSeconds),
        seconds: gapSeconds,
        sublabel: `${biggest.fromClock} to ${biggest.toClock}${biggest.matchesEvent ? ` · ${biggest.matchesEvent}` : ''}`,
      },
      fallbackLine: `${biggest.fromClock} to ${biggest.toClock} ${phrase}${biggest.matchesEvent ? `, matching "${biggest.matchesEvent}" on your calendar` : ''}.`,
      ask: `The day had a real hole: ${biggest.fromClock} to ${biggest.toClock} ${phrase}. One plain line that owns it as part of the day's shape${biggest.matchesEvent ? `, naming the calendar event it matches ("${biggest.matchesEvent}")` : '. Daylens does not know what happened during it, so never guess an activity for it'}; time away needs no defense and no apology.`,
      factsNote: gapFacts.map((gap) =>
        `${gap.fromClock} to ${gap.toClock} (${hm(Math.round((gap.toMs - gap.fromMs) / 1000))}) ${gapKindPhrase(gap.kind)}${gap.matchesEvent ? `, matches calendar event "${gap.matchesEvent}"` : ''}`,
      ).join('; '),
    })
  }

  // 12c · The through-line — a subject that recurred across 3+ blocks over 3+
  // hours is the day's real shape (day-recap-and-analysis.md "Day threads").
  const threadFacts = facts.threads ?? []
  const thread = threadFacts[0]
  if (thread) {
    // The stat is the RETURN COUNT, not a duration: a thread's membership
    // includes blocks where the subject was secondary evidence, and those
    // blocks' time belongs to their own headline work.
    pushMiddle({
      id: 'daythread', kind: 'stat', kicker: 'The through-line',
      stat: {
        value: String(thread.blockCount),
        sublabel: `separate blocks of ${thread.name} · ${thread.fromClock} to ${thread.toClock}`,
      },
      fallbackLine: `${thread.name} ran through the day: ${thread.blockCount} separate blocks between ${thread.fromClock} and ${thread.toClock}.`,
      ask: `${lowerName(thread.name)} was not one sitting: it came back in ${thread.blockCount} separate blocks between ${thread.fromClock} and ${thread.toClock}. One line on that shape — the thing the day kept returning to — without judging the interleaving as good or bad.`,
      factsNote: threadFacts.map((t) =>
        `${t.name}: ${t.blockCount} blocks, ${t.fromClock} to ${t.toClock}${t.seconds >= 5 * 60 ? `, ${hm(t.seconds)} where it was the main work` : ''}`,
      ).join('; '),
    })
  }

  // 13 · The wildcard — the computed surprising true thing.
  if (facts.wildcardHook) {
    const hook = facts.wildcardHook
    pushMiddle({
      id: 'wildcard', kind: 'stat', kicker: 'And one more thing',
      stat: hook.seconds != null
        ? { value: hook.value, seconds: hook.seconds }
        : { value: hook.value },
      fallbackLine: `${hook.value}, ${hook.caption}.`,
      ask: `Phrase this true fact so it lands as the "huh, neat" moment: ${hook.caption}. Anchor it in the concrete value (${hook.value}) or the real activity, never stay abstract, and give it meaning by tying it to ONE other real, NAMED fact of the day (the actual work or activity it sat inside, or a real part of day), never a verdict. No filler characterizations ("that is what deep work looks like", "a real slice of the day") and no unstated comparisons or consistency claims (no "more than the rest combined", no "held even all day"); do not claim anything about time you were not given. Use a part-of-day word, never a bare clock time, and do not open by referencing when the day started.`,
      factsNote: `${hook.value} = ${hook.caption}`,
    })
  }

  // The shuffled middle lands between the story and the question. Same seed →
  // same order (stable on reopen); a different day gets a different rhythm.
  out.push(...seededShuffle(middle, facts.seed))

  // 14 · The AI's question — interactive.
  out.push({
    id: 'question', kind: 'question', kicker: 'One thing I\'m curious about',
    fallbackLine: 'What was the best part of the day, the part the numbers can\'t see?',
    ask: '', // the question text comes from narrative.question, not lines
    factsNote: 'interactive slide: the user can answer and you respond in context',
  })

  // 15 · Reflection — the finale paragraph.
  out.push({
    id: 'reflection', kind: 'reflection', kicker: 'If I texted you tonight',
    fallbackLine: facts.isLeisureDay
      ? 'A day mostly off the clock. Rest counts too. That is the whole story, and it is enough.'
      : `You put in ${hm(facts.activeSeconds)} today${facts.workActivities[0] ? `, most of it ${lowerName(workActionPhrase(facts.workActivities[0].name, facts.workActivities[0].category))}` : ''}. That is the day, plainly told.`,
    ask: '', // comes from narrative.reflection
    factsNote: 'the closing paragraph',
  })

  // 16 · Finale share card.
  out.push({
    id: 'finale', kind: 'finale', kicker: 'DAYLENS',
    fallbackLine: 'That\'s the day.',
    ask: '',
    factsNote: 'share card',
  })

  return out
}

export function dayWrapDeckMeta(facts: DayWrapFacts): WrapDeckMeta {
  return {
    title: 'Your day, wrapped',
    rangeLabel: `${facts.weekday} · ${facts.dateLabel}`,
    headline: formatHm(facts.activeSeconds),
    footer: 'wrapped by Daylens',
  }
}

// ─── Period plan (week / month / year) ────────────────────────────────────────

const PERIOD_NOUN: Record<WrappedPeriodFacts['period'], string> = { week: 'week', month: 'month', year: 'year' }

function cleanThreads(facts: WrappedPeriodFacts) {
  return facts.threads.filter((t) => t.subject && !looksLikeRawArtifactLabel(t.subject))
}

export function planPeriodWrapSlides(facts: WrappedPeriodFacts): WrapSlideSpec[] {
  const out: WrapSlideSpec[] = []
  const hm = formatHm
  const noun = PERIOD_NOUN[facts.period]
  const threads = cleanThreads(facts)

  // Opening — what kind of week/month/year this was, in one sentence.
  out.push({
    id: 'opening', kind: 'opening', kicker: facts.rangeLabel.toUpperCase(),
    fallbackLine: facts.daysWithActivity >= 6 ? `A full ${noun}, end to end.` : facts.daysWithActivity >= 3 ? `A ${noun} with a few real days in it.` : `A light ${noun}.`,
    ask: `One punchy sentence on what kind of ${noun} this was overall. Name the one real thing that defined it (the biggest thread by name, or the true shape of the days), concretely. No numbers, and no effort adjectives ("hard", "long", "relentless") standing in for the real thing.`,
    factsNote: `total ${hm(facts.totalSeconds)}, work ${hm(facts.workSeconds)}, leisure ${hm(facts.leisureSeconds)}, ${facts.daysWithActivity} active days${threads[0] ? `, biggest thread: ${threads[0].subject}` : ''}`,
  })

  // The headline number.
  out.push({
    id: 'headline', kind: 'stat', kicker: `The ${noun}, in one number`,
    stat: { value: hm(facts.totalSeconds), seconds: facts.totalSeconds, sublabel: `across ${plural(facts.daysWithActivity, 'active day')}` },
    fallbackLine: `${hm(facts.totalSeconds)} of tracked time across ${plural(facts.daysWithActivity, 'day')}.`,
    ask: `One line under the ${noun}-total number that ADDS a real read. Anchor it concretely in the thread that filled the ${noun} or where the weight of it sat; do not restate the total and do not lean on vague adjectives.`,
    factsNote: `total ${hm(facts.totalSeconds)}, ${facts.daysWithActivity} active days${threads[0] ? `, the ${noun} was mostly ${threads[0].subject}` : ''}`,
  })

  // Coverage — what this wrap saw and what it didn't. Deterministic, pinned
  // right after the headline (the shuffle below starts at index 3).
  out.push({
    id: 'coverage', kind: 'coverage', kicker: 'What this wrap is built on',
    coverage: {
      windowLabel: `${plural(facts.daysWithActivity, 'day')} with tracked activity on this computer`,
      sources: [],
      note: "Days and hours Daylens didn't observe aren't in the story.",
    },
    fallbackLine: `Built from ${plural(facts.daysWithActivity, 'day')} of tracked activity on this computer. Days and hours Daylens didn't observe aren't in the story.`,
    ask: '', // deterministic by design: the coverage card can never overclaim
    factsNote: `built from ${plural(facts.daysWithActivity, 'day')} with tracked activity; unobserved time is not represented`,
  })

  // Consistency — showing up.
  if (facts.period === 'week' && facts.daysWithActivity >= 2) {
    out.push({
      id: 'consistency', kind: 'stat', kicker: 'Days you showed up',
      stat: { value: `${facts.daysWithActivity} of 7` },
      fallbackLine: `You were at it ${facts.daysWithActivity} of the 7 days.`,
      ask: `You worked ${facts.daysWithActivity} of 7 days. One observational line with a real read on the rhythm of showing up (a day plainly taken, or the streak said plainly), never a cheer, never a grade, and never the bare count restated.`,
      factsNote: `${facts.daysWithActivity} of 7 days active`,
    })
  }

  // The shape — per-bucket silhouette.
  if (facts.buckets.length >= 2) {
    const max = Math.max(...facts.buckets.map((b) => b.totalSeconds), 1)
    out.push({
      id: 'shape', kind: 'shape', kicker: `The shape of your ${noun}`,
      buckets: facts.buckets.map((b) => ({ label: b.label, seconds: b.totalSeconds, peak: b.totalSeconds === max && max > 1 })),
      fallbackLine: facts.busiestBucket ? `${facts.busiestBucket.label} carried the most.` : `The ${noun}, day by day.`,
      ask: `One line on the silhouette of the ${noun}: where it peaked, where it thinned. The chart shows the bars.`,
      factsNote: facts.buckets.map((b) => `${b.label} ${hm(b.totalSeconds)}`).join(', '),
    })
  }

  // Best day.
  if (facts.busiestDay) {
    out.push({
      id: 'bestday', kind: 'stat', kicker: `The big day`,
      stat: { value: hm(facts.busiestDay.totalSeconds), seconds: facts.busiestDay.totalSeconds, sublabel: facts.busiestDay.dayLabel },
      fallbackLine: `${facts.busiestDay.dayLabel} carried the most: ${hm(facts.busiestDay.totalSeconds)}.`,
      ask: `${facts.busiestDay.dayLabel} was the fullest day. One line that gives it its due.`,
      factsNote: `${facts.busiestDay.dayLabel}: ${hm(facts.busiestDay.totalSeconds)}`,
    })
  }

  // Worst day — honest, only when there were enough days for it to mean something.
  if (facts.quietestActiveDay && facts.busiestDay
    && facts.quietestActiveDay.dateStr !== facts.busiestDay.dateStr
    && facts.daysWithActivity >= 3) {
    out.push({
      id: 'worstday', kind: 'stat', kicker: 'The quiet one',
      stat: { value: hm(facts.quietestActiveDay.totalSeconds), seconds: facts.quietestActiveDay.totalSeconds, sublabel: facts.quietestActiveDay.dayLabel },
      fallbackLine: `${facts.quietestActiveDay.dayLabel} was the lightest: ${hm(facts.quietestActiveDay.totalSeconds)}.`,
      ask: `${facts.quietestActiveDay.dayLabel} was the thinnest day. Say it honestly and without judgment; a quiet day is allowed to be a quiet day.`,
      factsNote: `${facts.quietestActiveDay.dayLabel}: ${hm(facts.quietestActiveDay.totalSeconds)}`,
    })
  }

  // The longest stretch — with when, if the snapshot knew it.
  if (facts.longestStretch) {
    const when = [facts.longestStretch.dayLabel, facts.longestStretch.startClock ? `from ${facts.longestStretch.startClock}` : null].filter(Boolean).join(', ')
    const label = looksLikeRawArtifactLabel(facts.longestStretch.label) ? null : facts.longestStretch.label
    out.push({
      id: 'focus', kind: 'stat', kicker: 'Your longest unbroken stretch',
      stat: { value: hm(facts.longestStretch.seconds), seconds: facts.longestStretch.seconds, sublabel: [label, when].filter(Boolean).join(' · ') },
      fallbackLine: `${hm(facts.longestStretch.seconds)} without breaking, ${when}.`,
      ask: `The single longest unbroken stretch of the ${noun}: ${when}${label ? `, on ${label}` : ''}. Do not just state the duration (it is on the card); lead with what that run meant and the real work in it. This is the one to be a little proud of.`,
      factsNote: `${hm(facts.longestStretch.seconds)}${label ? ` on ${label}` : ''}, ${when}`,
    })
  }

  // A month gets its biggest week called out by name.
  if (facts.period !== 'week' && facts.busiestBucket && facts.buckets.length >= 2) {
    out.push({
      id: 'bestbucket', kind: 'stat', kicker: 'The big week',
      stat: { value: hm(facts.busiestBucket.totalSeconds), seconds: facts.busiestBucket.totalSeconds, sublabel: facts.busiestBucket.label },
      fallbackLine: `${facts.busiestBucket.label} carried the most: ${hm(facts.busiestBucket.totalSeconds)}.`,
      ask: `${facts.busiestBucket.label} was the fullest stretch of the ${noun}. One line that gives it its due.`,
      factsNote: `${facts.busiestBucket.label}: ${hm(facts.busiestBucket.totalSeconds)}`,
    })
  }

  // Thread deep-dives — the biggest named threads get their own card (two for
  // a week, four for a month/year, so longer periods tell a longer story).
  const threadCards = facts.period === 'week' ? 2 : 4
  threads.slice(0, threadCards).forEach((t, i) => {
    out.push({
      id: `thread-${i}`, kind: 'stat', kicker: i === 0 ? `What the ${noun} was really about` : i === 1 ? 'The other big thread' : `Thread ${i + 1} of the ${noun}`,
      stat: { value: hm(t.seconds), seconds: t.seconds, sublabel: `${t.subject}${t.daysActive > 1 ? ` · ${t.daysActive} days` : ''}` },
      fallbackLine: `${hm(t.seconds)} on ${t.subject}${t.daysActive > 1 ? `, across ${plural(t.daysActive, 'day')}` : ''}.`,
      ask: `${t.subject} took ${hm(t.seconds)}${t.daysActive > 1 ? ` across ${t.daysActive} days` : ''}. One line on what that commitment looked like: how the time actually spread (one deep sitting, or returns across days) and what was being worked at, never filler like "a real commitment".`,
      factsNote: `${t.subject}: ${hm(t.seconds)}, ${plural(t.daysActive, 'day')}`,
    })
  })

  // What mattered — the full thread list as a chart.
  if (threads.length >= 2) {
    out.push({
      id: 'threads', kind: 'bars', kicker: 'What mattered',
      bars: threads.slice(0, 5).map((t) => ({ name: t.subject, seconds: t.seconds, detail: t.daysActive > 1 ? `${t.daysActive}d` : undefined })),
      fallbackLine: `${threads[0].subject} led the ${noun}.`,
      ask: 'One caption over the ranked threads. What the ranking says, not the list restated.',
      factsNote: threads.slice(0, 5).map((t) => `${t.subject} ${hm(t.seconds)}`).join(', '),
    })
  }

  // The biggest time sink.
  const sink = facts.topApps[0]
  if (sink && sink.seconds >= 45 * 60) {
    out.push({
      id: 'timesink', kind: 'stat', kicker: 'Where the most time pooled',
      stat: { value: hm(sink.seconds), seconds: sink.seconds, sublabel: sink.appName },
      fallbackLine: `${sink.appName} held ${hm(sink.seconds)} this ${noun}, more than anything else.`,
      ask: `${sink.appName} took the most raw time this ${noun}. Say honestly whether that reads as the work itself or as the leak, given everything else in the facts. No scolding.`,
      factsNote: `${sink.appName}: ${hm(sink.seconds)} of ${hm(facts.totalSeconds)} total`,
    })
  }

  // Where the time went — apps chart.
  if (facts.topApps.length >= 2) {
    out.push({
      id: 'apps', kind: 'bars', kicker: 'Where the time actually went',
      bars: facts.topApps.slice(0, 6).map((a) => ({ name: a.appName, seconds: a.seconds })),
      fallbackLine: `${facts.topApps[0].appName} led the ${noun}.`,
      ask: 'One caption for the app chart, a read on its SHAPE (concentrated or spread), naming at least one real app. Never add up or compare the bar values numerically; the chart shows the sizes.',
      factsNote: facts.topApps.slice(0, 6).map((a) => `${a.appName} ${hm(a.seconds)}`).join(', '),
    })
  }

  // The work itself, by kind.
  if (facts.categories.length >= 2 && facts.workSeconds > 0) {
    out.push({
      id: 'categories', kind: 'bars', kicker: 'The work, by kind',
      bars: facts.categories.slice(0, 5).map((c) => ({ name: humanCategoryWord(c.category), seconds: c.seconds })),
      fallbackLine: `Most of the work was ${humanCategoryWord(facts.categories[0].category).toLowerCase()}.`,
      ask: 'One line on what kind of work dominated, as a story, not a readout.',
      factsNote: facts.categories.slice(0, 5).map((c) => `${humanCategoryWord(c.category)} ${hm(c.seconds)}`).join(', '),
    })
  }

  // Work vs leisure.
  if (facts.workSeconds > 0 && facts.leisureSeconds > 0) {
    const [wp, lp] = pct2(facts.workSeconds, facts.leisureSeconds)
    out.push({
      id: 'split', kind: 'split', kicker: 'The honest split',
      split: { aLabel: 'Work', aPct: wp, aSeconds: facts.workSeconds, bLabel: 'Leisure', bPct: lp, bSeconds: facts.leisureSeconds },
      fallbackLine: `${wp}% work, ${lp}% leisure. That is the real ratio.`,
      ask: `The ${noun} split ${wp}% work to ${lp}% leisure. Frame the ratio honestly, no grade, no guilt. You may use exactly these percentages. Say nothing about WHEN in the days the leisure sat; this slide's facts hold only the ratio.`,
      factsNote: `work ${hm(facts.workSeconds)} (${wp}%), leisure ${hm(facts.leisureSeconds)} (${lp}%)`,
    })
  }

  // Leisure surfaces, as their own quiet note.
  if (facts.leisureSurfaces.length > 0 && facts.leisureSeconds >= 30 * 60) {
    out.push({
      id: 'leisure', kind: 'text', kicker: 'Off the clock',
      fallbackLine: `${hm(facts.leisureSeconds)} went to ${facts.leisureSurfaces.slice(0, 2).join(' and ')}.`,
      ask: `The downtime went to ${facts.leisureSurfaces.slice(0, 3).join(', ')}. One kind, honest line. Rest is allowed.`,
      factsNote: `leisure ${hm(facts.leisureSeconds)}: ${facts.leisureSurfaces.slice(0, 3).join(', ')}`,
    })
  }

  // Meetings and calls.
  if (facts.meetingsSeconds >= 30 * 60) {
    out.push({
      id: 'meetings', kind: 'stat', kicker: 'In meetings and calls',
      stat: { value: hm(facts.meetingsSeconds), seconds: facts.meetingsSeconds },
      fallbackLine: `${hm(facts.meetingsSeconds)} of the ${noun} went to meetings and calls.`,
      ask: 'One plain line on the meeting time.',
      factsNote: `meetings ${hm(facts.meetingsSeconds)} of ${hm(facts.workSeconds)} work`,
    })
  }

  // The thing you probably forgot.
  const forgotten = facts.topApps.slice(3).find((a) => a.seconds >= 20 * 60)
  if (forgotten) {
    out.push({
      id: 'forgotten', kind: 'stat', kicker: 'You probably forgot this one',
      stat: { value: hm(forgotten.seconds), seconds: forgotten.seconds, sublabel: forgotten.appName },
      fallbackLine: `${forgotten.appName} quietly took ${hm(forgotten.seconds)} this ${noun}.`,
      ask: `${forgotten.appName} took ${hm(forgotten.seconds)} without ever being the main thing. Surface it as the "oh right, that" moment.`,
      factsNote: `${forgotten.appName}: ${hm(forgotten.seconds)}, ranked outside the top 3`,
    })
  }

  // Late nights / early starts, from the real day edges.
  const lateDays = facts.dayEdges.filter((e) => e.lastHour >= 23 || e.lastHour < 4)
  if (lateDays.length > 0) {
    const latest = lateDays[lateDays.length - 1]
    out.push({
      id: 'latenights', kind: 'stat', kicker: 'It ran late',
      stat: { value: String(lateDays.length), sublabel: `${plural(lateDays.length, 'night')} past 11pm · latest ${latest.lastClock} ${latest.dayLabel}` },
      fallbackLine: `${plural(lateDays.length, 'night')} ran past 11pm. The latest ended ${latest.lastClock} on ${latest.dayLabel}.`,
      ask: `${lateDays.length} of the days ran past 11pm, the latest ending ${latest.lastClock} on ${latest.dayLabel}. One observational line, never a scold.`,
      factsNote: lateDays.map((e) => `${e.dayLabel} until ${e.lastClock}`).join(', '),
    })
  }
  const earlyDays = facts.dayEdges.filter((e) => e.firstHour > 0 && e.firstHour <= 6)
  if (earlyDays.length > 0) {
    const earliest = earlyDays.reduce((a, b) => (a.firstHour <= b.firstHour ? a : b))
    out.push({
      id: 'earlystarts', kind: 'stat', kicker: 'The early starts',
      stat: { value: String(earlyDays.length), sublabel: `${plural(earlyDays.length, 'start')} before 7am · earliest ${earliest.firstClock} ${earliest.dayLabel}` },
      fallbackLine: `${plural(earlyDays.length, 'day')} started before 7am, the earliest at ${earliest.firstClock} on ${earliest.dayLabel}.`,
      ask: `${earlyDays.length} days started before 7am, the earliest ${earliest.firstClock} on ${earliest.dayLabel}. One line that names it.`,
      factsNote: earlyDays.map((e) => `${e.dayLabel} from ${e.firstClock}`).join(', '),
    })
  }

  // Against the previous period.
  if (facts.previousPeriodSeconds > 0) {
    const delta = facts.totalSeconds - facts.previousPeriodSeconds
    out.push({
      id: 'compare', kind: 'compare', kicker: `Against last ${noun}`,
      compare: { currentLabel: `This ${noun}`, currentSeconds: facts.totalSeconds, previousLabel: `Last ${noun}`, previousSeconds: facts.previousPeriodSeconds },
      fallbackLine: delta >= 0
        ? `${hm(Math.abs(delta))} more than last ${noun}.`
        : `${hm(Math.abs(delta))} less than last ${noun}.`,
      ask: `This ${noun} was ${hm(Math.abs(delta))} ${delta >= 0 ? 'more' : 'less'} than the last one. One honest line on the comparison; it is arithmetic, not a verdict. Use the ${hm(Math.abs(delta))} difference exactly as given here, never compute your own.`,
      factsNote: `this ${noun} ${hm(facts.totalSeconds)}, last ${noun} ${hm(facts.previousPeriodSeconds)}, difference exactly ${hm(Math.abs(delta))} ${delta >= 0 ? 'more' : 'less'} this ${noun}`,
    })
  }

  // A daily average, plain arithmetic.
  if (facts.daysWithActivity >= 3) {
    const avg = Math.round(facts.totalSeconds / facts.daysWithActivity)
    out.push({
      id: 'average', kind: 'stat', kicker: 'A typical day',
      stat: { value: hm(avg), seconds: avg, sublabel: 'per active day' },
      fallbackLine: `${hm(avg)} on a typical active day.`,
      ask: 'One line on what a typical day looked like, from the per-day average: the kind of pace this volume is, plainly. Never claim how individual days clustered around the average; the facts do not say that.',
      factsNote: `${hm(avg)} per active day (${hm(facts.totalSeconds)} over ${facts.daysWithActivity} days)`,
    })
  }

  // The AI's question — interactive.
  out.push({
    id: 'question', kind: 'question', kicker: 'One thing I\'m curious about',
    fallbackLine: `Which day of this ${noun} would you actually want back?`,
    ask: '',
    factsNote: 'interactive slide: the user can answer and you respond in context',
  })

  // Reflection.
  out.push({
    id: 'reflection', kind: 'reflection', kicker: `If I wrote you at the end of the ${noun}`,
    fallbackLine: `${hm(facts.totalSeconds)} across ${plural(facts.daysWithActivity, 'day')}${threads[0] ? `, most of it on ${threads[0].subject}` : ''}. That is the ${noun}, plainly told.`,
    ask: '',
    factsNote: 'the closing paragraph',
  })

  // Finale.
  out.push({
    id: 'finale', kind: 'finale', kicker: 'DAYLENS',
    fallbackLine: `That's the ${noun}.`,
    ask: '',
    factsNote: 'share card',
  })

  // Shuffle the middle (everything between coverage and question) with a seed
  // from the anchor date, so each week/month deck has its own rhythm but is
  // stable on reopen. Opening, headline, coverage, question, reflection, finale hold.
  const questionIdx = out.findIndex((s) => s.id === 'question')
  const head = out.slice(0, 3)
  const tail = out.slice(questionIdx)
  const shuffledMiddle = seededShuffle(out.slice(3, questionIdx), seedFromDate(facts.anchorDate))
  return [...head, ...shuffledMiddle, ...tail]
}

export function periodWrapDeckMeta(facts: WrappedPeriodFacts): WrapDeckMeta {
  return {
    title: `Your ${PERIOD_NOUN[facts.period]}, wrapped`,
    rangeLabel: facts.rangeLabel.toUpperCase(),
    headline: formatHm(facts.totalSeconds),
    footer: `${PERIOD_NOUN[facts.period]}, wrapped by Daylens`,
  }
}

/** Plain-word tag for an entity type on the "what the day was about" scene. */
function entityTypeWord(type: string): string {
  switch (type) {
    case 'project': return 'project'
    case 'client': return 'client'
    case 'person': return 'person'
    case 'meeting': return 'meeting'
    case 'repository': return 'repository'
    default: return 'subject'
  }
}

// Human words for work categories — mirrors dayWrapScenes.categoryWord but for
// the period charts (which include communication/email rows the day list folds).
function humanCategoryWord(category: string): string {
  switch (category) {
    case 'development': return 'Coding'
    case 'aiTools': return 'Coding'
    case 'writing': return 'Writing'
    case 'design': return 'Design'
    case 'research': return 'Research'
    case 'meetings': return 'Meetings'
    case 'communication': return 'Messages'
    case 'email': return 'Email'
    case 'productivity': return 'Admin'
    // Observational: browser foreground time proves the page was open, not read.
    case 'browsing': return 'On the web'
    default: return 'Other work'
  }
}
