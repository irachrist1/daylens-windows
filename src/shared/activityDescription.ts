// The one executable activity-description policy (REQ-VIC-001, REQ-VIC-003).
//
// Every surface that turns captured activity into words — a Timeline label, a
// day recap, a Wrapped line, a chat answer, a time-chunk row — describes the
// SAME understood activity under the SAME rules. Before this module the policy
// existed three times: label rules in labelVoice.ts, prose directives in
// voiceContract.ts, and a third prose scan (recapVoiceFindings) that lived in
// labelVoice.ts and re-scanned the label lists. A term added to one never bound
// on the others.
//
// This module is the single definition site. It sits in `shared` because
// labelVoice.ts is shared and cannot import from `main`; voiceContract.ts (main)
// importing from here is the direction the codebase already uses.
//
// Two halves, and the split is ADR-002 of the Voice & Interpretation Contract:
// INTERPRETATION (what the evidence supports) is separate from EXPRESSION (the
// selected tone, in summaryVoice.ts). Nothing here reads or changes a tone.

// ── Vocabulary: one definition site, two scopes ────────────────────────────

// Marketing filler and assistant tics. The full list, for generated prose.
export const BANNED_VOCAB = [
  'dive into',
  'unleash',
  'navigate the landscape',
  "this isn't X, it's Y",
  "in today's fast-paced world",
  'game-changing',
  'seamless',
  'elevate',
  'great question',
  "let's explore",
  'at the end of the day',
  'fascinating perspective',
  "you're absolutely right",
  'harness the power',
  'empower',
  'robust',
  'streamline',
  'crush it',
  "you've got this",
  'great work',
  "let's dive in",
] as const

// The subset of BANNED_VOCAB that could plausibly surface in a short label,
// plus "deep dive", which is label-shaped and not a prose tic.
export const LABEL_HYPE_VOCAB = [
  'dive into',
  'deep dive',
  'unleash',
  'game-changing',
  'seamless',
  'elevate',
  'harness the power',
  'empower',
  'streamline',
  'navigate the landscape',
] as const

// The words Daylens uses for its own machinery, in the scope of a generated
// ANSWER. They are accurate and they are how the tools and the prompts talk,
// which is exactly why a model reaches for them: an answer that says
// "page-level detail covers 0m" is describing the capture pipeline instead of
// the person's day.
//
// Deliberately narrow. "window titles" and "tracked activity" are NOT here: the
// honest capability answer has to name window titles as something Daylens
// captures, and the wrap's honesty line reports how much tracked activity a day
// was built from. Only terms that are wrong in every answer belong on this list.
export const PROSE_PLUMBING_VOCAB = [
  'foreground',
  'page-level detail',
  'page detail',
  'app sessions',
  'captured signal',
  'page coverage',
  'the data shows',
  'based on the data',
] as const

// The same ban in the scope of a LABEL, where the bar is higher: a label reading
// "window title" or "app session" is always wrong, even though an answer may
// legitimately name window titles as a thing Daylens captures. Kept tight to
// unambiguous telemetry vocabulary so real work ("Reviewing evidence for the
// Harris case") is never punished for its subject matter.
export const LABEL_PLUMBING_VOCAB = [
  'foreground',
  'window title',
  'app session',
  'browser session',
  'captured signal',
  'capture source',
  'telemetry',
  'bundle id',
] as const

// Generated prose ABOUT a day (a recap, a wrap line, a block narrative) is held
// to both scopes: it is an answer, so the prose list binds, and it describes one
// stretch of activity, so the label list's stricter terms bind too.
export const DESCRIPTION_PLUMBING_VOCAB = [
  ...new Set<string>([...PROSE_PLUMBING_VOCAB, ...LABEL_PLUMBING_VOCAB]),
] as readonly string[]

// The observation contract: never judge productivity, focus, distraction, or
// personal worth. Naming a real focus-timer session stays allowed, so "focus"
// itself is not in this pattern.
export const JUDGMENT_RE =
  /\b(?:productive|unproductive|productivity|wasted|wasting|time.wasting|distraction|distracted|procrastinat\w*|lazy|slacking|doomscroll\w*)\b/i

// Internal vocabulary and template scaffolding a person would never write about
// their own day. These name Daylens's own reasoning ("trusted blocks",
// "strongest evidence") or its stat shapes ("focus held for X of tracked time").
export const INTERNAL_TEMPLATE_PHRASES = [
  'trusted block',
  'strongest evidence',
  'evidence included',
  'clearest named block',
  'clearest block',
  'named block',
  'based on the available titles',
  'supporting context',
  'focus held for',
  'of tracked time',
  'top apps',
  'based on the provided data',
  'work intent',
  'dominant category',
] as const

// Wording that describes nothing: a description that says only that activity
// occurred. AC-VIC-001.4 names these "weak activity phrases".
const WEAK_ACTIVITY_RE =
  /\b(?:some (?:work|activity|browsing)|various (?:tasks|things|activities)|general (?:work|activity|browsing|use)|mixed (?:work|activity|browsing)|computer (?:work|activity|use)|worked on (?:stuff|things)|misc(?:ellaneous)? (?:work|tasks?))\b/i

export const EM_DASH = '—'

// ── The interpretation contract (ADR-002: interpretation, not expression) ──

/** What kind of captured evidence supports a named detail. A detail with no
 *  entry here is not supported and must not be named (AC-VIC-001.2). */
export type EvidenceKind =
  | 'window-title'
  | 'page'
  | 'file'
  | 'artifact'
  | 'calendar'
  | 'git'
  | 'app-session'
  | 'user-stated'

/** The five fact kinds that belong to the evidence boundary, never to a model
 *  (AC-VIC-003.3). A model interprets and summarizes them; it cannot originate
 *  one. */
export const EVIDENCE_OWNED_FACTS = ['duration', 'identity', 'url', 'file', 'event'] as const
export type EvidenceOwnedFact = (typeof EVIDENCE_OWNED_FACTS)[number]

/** A subject, project, client, person, or outcome the evidence supports naming. */
export interface SupportedDetail {
  name: string
  kind: EvidenceKind
}

/** Where a piece of user-facing wording came from. `user` wording is the
 *  person's own and is never rewritten or represented as something Daylens
 *  derived (REQ-VIC-004); `model` wording is interpretation and carries no
 *  authority over facts. */
export type DescriptionProvenance = 'evidence' | 'user' | 'model'

/**
 * The one evidence-backed interpretation a surface renders. Every activity
 * surface receives this and applies its own format and the selected tone on
 * top; none of them recomputes a competing reading of the same activity.
 */
export interface SupportedInterpretation {
  /** What the person was doing, in everyday words. */
  activity: string
  /** Where `activity` came from. */
  provenance: DescriptionProvenance
  /** Names the evidence supports. A name absent from here must not appear in a
   *  generated description of this activity. */
  supportedDetails: SupportedDetail[]
  /** Evidence-owned facts this interpretation actually carries, so a
   *  description quoting one can be checked against what was recorded. */
  facts?: Partial<Record<EvidenceOwnedFact, readonly string[]>>
  /** What the capture could not determine, in plain terms ("which pages were
   *  open in Safari"). Drives the single uncertainty sentence. */
  captureLimits?: string[]
}

/** Every supported name, lowercased, for containment checks. */
export function supportedDetailNames(interpretation: SupportedInterpretation): Set<string> {
  return new Set(
    interpretation.supportedDetails
      .map((detail) => detail.name.trim().toLowerCase())
      .filter(Boolean),
  )
}

// ── Rules ──────────────────────────────────────────────────────────────────

export type ActivityDescriptionTier = 'invariant' | 'target'

export type ActivityDescriptionRuleId =
  | 'no-plumbing'
  | 'no-hype'
  | 'no-judgment'
  | 'no-internal-template'
  | 'no-weak-activity'
  | 'no-em-dash'
  | 'no-unsupported-detail'
  | 'activity-before-telemetry'
  | 'evidence-owned-facts'

export interface ActivityDescriptionRule {
  id: ActivityDescriptionRuleId
  tier: ActivityDescriptionTier
  /** The acceptance criterion this rule makes executable. */
  criterion: string
  requirement: string
}

export const ACTIVITY_DESCRIPTION_RULES: readonly ActivityDescriptionRule[] = [
  {
    id: 'no-plumbing',
    tier: 'invariant',
    criterion: 'AC-VIC-001.4',
    requirement:
      'No capture or telemetry vocabulary: the description says what the person was doing, never how Daylens observed it.',
  },
  {
    id: 'no-hype',
    tier: 'invariant',
    criterion: 'AC-VIC-001.4',
    requirement: 'No marketing filler or assistant tics.',
  },
  {
    id: 'no-judgment',
    tier: 'invariant',
    criterion: 'AC-VIC-003.2',
    requirement:
      'No productivity, focus, distraction, or personal-worth judgment.',
  },
  {
    id: 'no-internal-template',
    tier: 'invariant',
    criterion: 'AC-VIC-001.4',
    requirement:
      'No internal vocabulary or template scaffolding: a person never writes "trusted blocks" or "focus held for" about their own day.',
  },
  {
    id: 'no-weak-activity',
    tier: 'invariant',
    criterion: 'AC-VIC-001.4',
    requirement:
      'No weak activity phrase that describes nothing ("some work", "various tasks").',
  },
  {
    id: 'no-em-dash',
    tier: 'invariant',
    criterion: 'AC-VIC-001.4',
    requirement: 'No em dash, and no double hyphen standing in for one.',
  },
  {
    id: 'no-unsupported-detail',
    tier: 'invariant',
    criterion: 'AC-VIC-001.2',
    requirement:
      'A named subject, project, client, person, or outcome appears only when the interpretation supports that name.',
  },
  {
    id: 'activity-before-telemetry',
    tier: 'target',
    criterion: 'AC-VIC-001.3',
    requirement:
      'The understood activity is stated before the raw telemetry it was inferred from: an app or window name never opens the description.',
  },
  {
    id: 'evidence-owned-facts',
    tier: 'invariant',
    criterion: 'AC-VIC-003.3',
    requirement:
      'A duration, identity, URL, file, or event appears only when the interpretation carried it as recorded evidence.',
  },
]

export interface ActivityDescriptionContext {
  /** The interpretation the description was written from. Without it, the two
   *  evidence-bound rules cannot be evaluated and report as passed: an
   *  unevaluable rule is not a violation. */
  interpretation?: SupportedInterpretation
  /** App and browser names observed for this activity, for the
   *  activity-before-telemetry check. */
  appNames?: string[]
  /** Candidate names the description might be tested against for support. When
   *  absent, the check reads names out of the interpretation's own details plus
   *  these app names, so it never invents a subject to complain about. */
  candidateDetails?: string[]
}

export interface ActivityDescriptionFinding {
  rule: ActivityDescriptionRuleId
  tier: ActivityDescriptionTier
  criterion: string
  passed: boolean
  /** Why the rule failed, naming the offending fragment. Null when passed. */
  detail: string | null
}

function firstTerm(lower: string, terms: readonly string[]): string | null {
  return terms.find((term) => lower.includes(term.toLowerCase())) ?? null
}

function checkPlumbing(lower: string): string | null {
  const found = firstTerm(lower, DESCRIPTION_PLUMBING_VOCAB)
  return found ? `capture vocabulary "${found}"` : null
}

function checkHype(lower: string): string | null {
  const found = firstTerm(lower, BANNED_VOCAB)
  return found ? `banned vocabulary "${found}"` : null
}

function checkJudgment(text: string): string | null {
  const match = JUDGMENT_RE.exec(text)
  return match ? `judgment word "${match[0]}"` : null
}

function checkInternalTemplate(lower: string): string | null {
  const found = firstTerm(lower, INTERNAL_TEMPLATE_PHRASES)
  return found ? `internal vocabulary "${found}"` : null
}

function checkWeakActivity(text: string): string | null {
  const match = WEAK_ACTIVITY_RE.exec(text)
  return match ? `weak activity phrase "${match[0]}"` : null
}

export function containsEmDash(text: string): boolean {
  return text.includes(EM_DASH) || /(?:^|\s)--(?:\s|$)/.test(text)
}

function checkEmDash(text: string): string | null {
  return containsEmDash(text) ? 'em dash' : null
}

// A name is "present" when it appears as a whole word run, so a client called
// "Ash" is not found inside "dashboard".
function mentions(text: string, name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed) return false
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:[^\\p{L}\\p{N}]|$)`, 'iu').test(text)
}

function checkUnsupportedDetail(text: string, context: ActivityDescriptionContext): string | null {
  const interpretation = context.interpretation
  if (!interpretation) return null
  const supported = supportedDetailNames(interpretation)
  // Only names we were handed as candidates can be judged. Extracting proper
  // nouns from prose would produce false accusations on ordinary sentences,
  // and a false rejection of an honest description is worse than a miss.
  const candidates = context.candidateDetails ?? []
  for (const candidate of candidates) {
    const name = candidate.trim()
    if (!name || supported.has(name.toLowerCase())) continue
    if (mentions(text, name)) return `names "${name}", which the evidence does not support`
  }
  return null
}

function checkActivityBeforeTelemetry(text: string, context: ActivityDescriptionContext): string | null {
  const opening = text.trim()
  if (!opening) return null
  for (const appName of context.appNames ?? []) {
    const name = appName.trim()
    if (!name) continue
    // Only the OPENING counts: naming the app as tail attribution is exactly
    // what the policy asks for ("Reworking the timeline, in Cursor").
    if (new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^\\p{L}\\p{N}]|$)`, 'iu').test(opening)) {
      return `opens with the app name "${name}" instead of the activity`
    }
  }
  return null
}

// Shapes that read as a recorded fact. A description may say "about an hour"
// (interpretation); it may not say "1h 24m" unless that duration was recorded.
// The duration pattern takes a compound run in one bite: "1h 24m" is ONE stated
// duration, and scanning it as "1h" plus "24m" would report two facts that were
// never claimed.
const DURATION_SHAPE_RE =
  /\b\d+\s?(?:h|hr|hrs|hours?|m|min|mins|minutes?)(?:\s+\d+\s?(?:m|min|mins|minutes?|s|sec|secs|seconds?))*\b/gi
const URL_SHAPE_RE = /\bhttps?:\/\/\S+|\b(?:[a-z0-9-]+\.)+(?:com|org|io|dev|app|net|ai|co|edu|gov)\b/gi
const FILE_SHAPE_RE = /\b[\w()[\]#@~+-]+\.[a-z][a-z0-9]{0,5}\b/gi

function factSupported(value: string, recorded: readonly string[] | undefined): boolean {
  if (!recorded || recorded.length === 0) return false
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '')
  return recorded.some((entry) => entry.trim().toLowerCase().replace(/\s+/g, '') === normalized)
}

function checkEvidenceOwnedFacts(text: string, context: ActivityDescriptionContext): string | null {
  const interpretation = context.interpretation
  if (!interpretation) return null
  const facts = interpretation.facts
  // No facts block means the interpretation makes no claim about what was
  // recorded, so there is nothing to contradict. A caller that wants this rule
  // enforced supplies `facts`.
  if (!facts) return null
  // A domain is a URL, not a file, even though "example.dev" fits both shapes.
  // The URL scan runs first and its matches are blanked out of the text the
  // file scan reads, so one stated fact is never reported twice under two names.
  let remaining = text
  const checks: Array<[EvidenceOwnedFact, RegExp, boolean]> = [
    ['duration', DURATION_SHAPE_RE, false],
    ['url', URL_SHAPE_RE, true],
    ['file', FILE_SHAPE_RE, false],
  ]
  for (const [fact, pattern, consume] of checks) {
    pattern.lastIndex = 0
    for (const match of remaining.matchAll(pattern)) {
      const value = match[0]
      if (!factSupported(value, facts[fact])) {
        return `states a ${fact} ("${value}") the evidence did not record`
      }
    }
    if (consume) {
      pattern.lastIndex = 0
      remaining = remaining.replace(pattern, ' ')
    }
  }
  return null
}

/** Every rule, evaluated against one produced description. One finding per rule. */
export function evaluateActivityDescription(
  text: string,
  context: ActivityDescriptionContext = {},
): ActivityDescriptionFinding[] {
  const value = (text ?? '').trim()
  const lower = value.toLowerCase()
  const details: Record<ActivityDescriptionRuleId, string | null> = {
    'no-plumbing': checkPlumbing(lower),
    'no-hype': checkHype(lower),
    'no-judgment': checkJudgment(value),
    'no-internal-template': checkInternalTemplate(lower),
    'no-weak-activity': checkWeakActivity(value),
    'no-em-dash': checkEmDash(value),
    'no-unsupported-detail': checkUnsupportedDetail(value, context),
    'activity-before-telemetry': checkActivityBeforeTelemetry(value, context),
    'evidence-owned-facts': checkEvidenceOwnedFacts(value, context),
  }
  return ACTIVITY_DESCRIPTION_RULES.map((rule) => ({
    rule: rule.id,
    tier: rule.tier,
    criterion: rule.criterion,
    passed: details[rule.id] === null,
    detail: details[rule.id],
  }))
}

export interface DescriptionVoiceFinding {
  phrase: string
  reason: string
}

/**
 * Voice violations in a generated description, as a flat list. This is the
 * check the recap, the block narrative, and the offline evals run: the same
 * rules as `evaluateActivityDescription`, reported as "what is wrong with this
 * text" rather than one finding per rule. Empty means clean.
 *
 * Non-throwing on purpose. Prose that has already streamed to a person cannot
 * be un-shown, so a violation is reported for voice monitoring, never raised.
 */
export function activityDescriptionFindings(
  text: string | null | undefined,
  context: ActivityDescriptionContext = {},
): DescriptionVoiceFinding[] {
  const value = (text ?? '').trim()
  if (!value) return []
  const lower = value.toLowerCase()
  const findings: DescriptionVoiceFinding[] = []
  for (const phrase of INTERNAL_TEMPLATE_PHRASES) {
    if (lower.includes(phrase)) findings.push({ phrase, reason: 'internal vocabulary / template phrasing' })
  }
  for (const term of DESCRIPTION_PLUMBING_VOCAB) {
    if (lower.includes(term)) findings.push({ phrase: term, reason: 'capture/telemetry vocabulary' })
  }
  for (const term of LABEL_HYPE_VOCAB) {
    if (lower.includes(term)) findings.push({ phrase: term, reason: 'marketing filler' })
  }
  const judgment = JUDGMENT_RE.exec(value)
  if (judgment) findings.push({ phrase: judgment[0], reason: 'judges productivity/worth' })
  for (const finding of evaluateActivityDescription(value, context)) {
    if (finding.passed) continue
    if (finding.rule === 'no-unsupported-detail' || finding.rule === 'evidence-owned-facts') {
      findings.push({ phrase: finding.detail ?? finding.rule, reason: `unsupported claim (${finding.criterion})` })
    }
  }
  return findings
}

/** The first prose-scope plumbing term in `text`, or null. Soft: reports for
 *  voice monitoring rather than rewriting anything. */
export function findPlumbingVocab(text: string): string | null {
  const lower = text.toLowerCase()
  return PROSE_PLUMBING_VOCAB.find((term) => lower.includes(term)) ?? null
}

/** The first banned phrase in `text`, or null. Soft, for the same reason. */
export function findBannedVocab(text: string): string | null {
  const lower = text.toLowerCase()
  return BANNED_VOCAB.find((phrase) => lower.includes(phrase.toLowerCase())) ?? null
}

// ── Uncertainty (AC-VIC-003.1, AC-VIC-003.2) ───────────────────────────────

/**
 * One natural-language sentence stating what the evidence could not settle, or
 * null when the interpretation has no limits worth stating.
 *
 * Exactly one sentence, by construction: a paragraph of caveats buries the day
 * behind an apology for the tooling. It never judges, and it never leads —
 * callers append it after the description, never before it.
 */
export function uncertaintyStatement(interpretation: SupportedInterpretation): string | null {
  const limits = (interpretation.captureLimits ?? [])
    .map((limit) => limit.trim().replace(/[.\s]+$/, ''))
    .filter(Boolean)
  if (limits.length === 0) return null
  const listed = limits.length === 1
    ? limits[0]
    : `${limits.slice(0, -1).join(', ')} or ${limits.at(-1)}`
  return `What Daylens cannot tell you here is ${listed}.`
}

/**
 * The evidence-ownership check as a hard assertion (AC-VIC-003.3), for
 * non-streaming pre-commit paths: offline evals, tests, and deterministically
 * composed text. Never call it on a live answer that has already streamed.
 */
export function assertEvidenceOwned(
  text: string,
  interpretation: SupportedInterpretation,
): void {
  const finding = evaluateActivityDescription(text, { interpretation })
    .find((entry) => entry.rule === 'evidence-owned-facts' && !entry.passed)
  if (finding) {
    throw new Error(`Model-originated fact in a description: ${finding.detail}`)
  }
}

// ── Prompt directives: the same policy, stated to a model ──────────────────

// Generated from the same constants the checks read, so the prompt cannot drift
// from what is enforced. A term added to a vocabulary list above appears in the
// prompt on the next build without anyone remembering to update prose.
//
// Split in two because the halves are not equally portable. The interpretation
// half is safe on every surface. The voice half carries vocabulary bans and the
// judgment rule, and a surface with its own richer, fact-gated rules about
// praise (the Wrapped decks) takes the interpretation half only. Composing the
// wrong half into a prompt produces a prompt that argues with itself, which is
// exactly the defect D4 records elsewhere in this codebase.

/** What the evidence supports. Safe on every surface that describes activity. */
export const INTERPRETATION_DIRECTIVES: readonly string[] = [
  'ONE DESCRIPTION POLICY. Every description of the person\'s activity, however short, follows these rules: a Timeline label, a recap line, a chunk row, and a chat answer all describe the same understood activity the same way.',
  'ACTIVITY FIRST, TELEMETRY SECOND. Say what the person was doing, then what it was observed through. "Reworking the timeline, in Cursor" is right; "Cursor, 3h" is a screen-time tracker.',
  `NEVER NARRATE THE PLUMBING. These words describe Daylens's machinery, not the person's day, and none belong in a description even when a tool result or these instructions use them: ${DESCRIPTION_PLUMBING_VOCAB.join(', ')}. Say the human version instead.`,
  'NAME ONLY WHAT THE EVIDENCE SUPPORTS. A subject, project, client, person, or outcome is named only when it appears in the evidence you were given. When the evidence shows the activity but not who or what it was for, describe the activity and stop; never fill the gap with a plausible name.',
  'FACTS ARE NOT YOURS TO CREATE. Durations, identities, URLs, files, and events are recorded evidence. Interpret and summarize them; never originate one. Deriving a figure from evidence you were given is fine, including computing a span from its own recorded start and end. Inventing one nothing recorded is not: if no evidence carries a duration, do not state a duration.',
  'SAY THE LIMIT ONCE, AND NEVER FIRST. When the evidence cannot settle something that matters, state it in one plain sentence after the description. Never open on what could not be seen, and never repeat the limit.',
  'NO WEAK ACTIVITY PHRASES. "Some work", "various tasks", "general browsing", and "computer activity" describe nothing. Name the actual thing, or say plainly that the evidence does not name it.',
  'NEVER COPY A TITLE. A window title, page title, or filename is evidence, not a description. Read it, then say what the person was doing.',
]

/** Vocabulary and judgment. The judgment line is scoped the way AC-VIC-003.2
 *  scopes it: what is banned is grading drawn from thin evidence, not a plain
 *  observation the facts carry. A surface that has earned the right to say
 *  something good about a real, named thing keeps it. */
export const DESCRIPTION_VOICE_DIRECTIVES: readonly string[] = [
  `BANNED VOCABULARY: ${BANNED_VOCAB.join(', ')}.`,
  'NO GRADING. Never rate productivity, focus, distraction, or personal worth, and never imply from thin evidence that a day was well or badly spent. Naming a real thing the evidence carries, including a long stretch on one piece of work, is not grading and stays welcome.',
]

export const ACTIVITY_DESCRIPTION_DIRECTIVES: readonly string[] = [
  ...INTERPRETATION_DIRECTIVES,
  ...DESCRIPTION_VOICE_DIRECTIVES,
]
