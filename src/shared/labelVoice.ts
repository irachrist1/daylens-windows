import { looksLikeRawArtifactLabel } from './blockLabel'
import { workNameGuardLabelViolation } from './workNameGuards'

// The executable label-voice rubric (label-voice.md). A block label describes
// what the person was doing in their own everyday words; this module turns that
// recorded definition into named, deterministic checks so the real-day review
// and the hermetic timeline evaluation score produced labels instead of leaving
// label quality to reviewer mood.
//
// Two tiers:
// - invariant: holds for EVERY produced label, including deterministic
//   fallbacks. A violation is a defect in the labeling path.
// - target: the final voice the labeling path aims for. A deterministic
//   fallback label may miss a target rule when evidence is thin; misses are
//   scored and named, never silently absorbed.

export type LabelVoiceTier = 'invariant' | 'target'

export interface LabelVoiceRule {
  id: LabelVoiceRuleId
  tier: LabelVoiceTier
  requirement: string
}

export type LabelVoiceRuleId =
  | 'nonempty-bounded'
  | 'no-raw-artifact-forms'
  | 'no-plumbing-or-hype'
  | 'no-judgment'
  | 'leisure-activity-shaped'
  | 'activity-not-software'
  | 'no-verbatim-window-title'
  | 'concrete-over-generic'
  | 'short-activity-phrase'

export const LABEL_VOICE_RULES: readonly LabelVoiceRule[] = [
  {
    id: 'nonempty-bounded',
    tier: 'invariant',
    requirement:
      'A label exists and stays a short phrase: never empty, at most 90 characters and 12 words, no trailing sentence punctuation.',
  },
  {
    id: 'no-raw-artifact-forms',
    tier: 'invariant',
    requirement:
      'No raw machine forms: URLs, bare domains, email addresses, data/office file extensions, underscore filenames, SCREAMING identifiers, notification counts, browser-tab soup, or trailing browser names.',
  },
  {
    id: 'no-plumbing-or-hype',
    tier: 'invariant',
    requirement:
      'Everyday words: no capture/telemetry vocabulary and none of the banned marketing filler from the voice contract.',
  },
  {
    id: 'no-judgment',
    tier: 'invariant',
    requirement:
      'A label never judges productivity, focus, distraction, or personal worth.',
  },
  {
    id: 'leisure-activity-shaped',
    tier: 'invariant',
    requirement:
      'A leisure label reads as the activity ("Watching…", "On…", "Listening…", "Browsing…"), never a bare page or video title.',
  },
  {
    id: 'activity-not-software',
    tier: 'target',
    requirement:
      'The label names what the person was doing, never a bare app or browser name with or without filler ("Cursor", "Chrome browsing", "Editor activity").',
  },
  {
    id: 'no-verbatim-window-title',
    tier: 'target',
    requirement:
      'The label never reproduces a captured window or page title verbatim.',
  },
  {
    id: 'concrete-over-generic',
    tier: 'target',
    requirement:
      'When evidence names a subject, the label names it too: no generic category or fallback label on a block that carries window titles, pages, or files.',
  },
  {
    id: 'short-activity-phrase',
    tier: 'target',
    requirement: 'The label reads like a 2-7 word activity phrase.',
  },
]

export interface LabelVoiceContext {
  /** Names of the apps observed in the block, browsers included. */
  appNames?: string[]
  /** Captured window titles for the block. */
  windowTitles?: string[]
  /** Captured page / site titles for the block. */
  pageTitles?: string[]
  /** Effective block kind ('work' | 'leisure' | 'personal') when known. */
  kind?: string | null
  /** True when the block carries subject evidence (titles, pages, files). */
  hasSubjectEvidence?: boolean
}

export interface LabelVoiceFinding {
  rule: LabelVoiceRuleId
  tier: LabelVoiceTier
  passed: boolean
  /** Why the rule failed, naming the offending fragment. Null when passed. */
  detail: string | null
}

const MAX_LABEL_CHARS = 90
const MAX_LABEL_WORDS = 12
const TARGET_MIN_WORDS = 2
const TARGET_MAX_WORDS = 7

const RAW_URL_RE = /https?:\/\/|www\./i
const RAW_FILE_EXTENSION_RE = /\.(ipynb|pdf|docx?|xlsx?|pptx?|csv|key|numbers|pages)\b/i
const UNDERSCORE_FILENAME_RE = /[a-z0-9]_[a-z0-9]/i
const NOTIFICATION_COUNT_RE = /^\(\d+\)\s/
// A label that is nothing but a date is an internal key, not an activity, and
// must never rank as "what mattered". Rejects a bare ISO or slashed date as the
// WHOLE label; a date inside a real phrase ("Reviewed the FY2026 report") is
// untouched.
const BARE_DATE_RE = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/
// Common web TLDs only, so a code filename ("run.ts") never reads as a domain.
const BARE_DOMAIN_RE = /^(?:[a-z0-9-]+\.)+(?:com|org|io|dev|app|net|ai|co|edu|gov)$/i
// An email address is a machine form wherever it sits in the label. The bare-
// domain rule missed these because the "@" stops the whole string matching, so
// two of one real day's ten blocks were headlined
// "christian.tonny@rw.Andersen.com" — lifted out of a Microsoft Teams calendar
// window title. An address is never what a person was doing.
const EMAIL_ADDRESS_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i
const TRAILING_BROWSER_RE =
  /\s[-—–]\s(?:Google Chrome|Safari|Arc|Firefox|Brave|Microsoft Edge|Chrome|Dia)$/i

// Capture plumbing a person would never say about their own day. Kept tight to
// unambiguous telemetry vocabulary so real work ("Reviewing evidence for the
// Harris case") is never punished for its subject matter.
const PLUMBING_TERMS = [
  'foreground',
  'window title',
  'app session',
  'browser session',
  'captured signal',
  'capture source',
  'telemetry',
  'bundle id',
]

// The subset of the assistant voice contract's banned vocabulary that could
// plausibly surface in a short label.
const HYPE_TERMS = [
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
]

// The block observation contract: never judge productivity, focus, distraction,
// or personal worth. Naming a real focus-timer session stays allowed, so
// "focus" itself is not in this list.
const JUDGMENT_RE =
  /\b(?:productive|unproductive|productivity|wasted|wasting|time.wasting|distraction|distracted|procrastinat\w*|lazy|slacking|doomscroll\w*)\b/i

const LEISURE_ACTIVITY_SHAPE_RE = /^(watching|on |listening|browsing)/i

// Fallback filler that turns an app name into a fake activity ("Chrome
// browsing", "Editor activity", "Cursor session").
const SOFTWARE_FILLER_RE = /\s+(?:activity|session|work|browsing|time|usage|use)$/i

// Labels that name a category or announce failure instead of the activity.
// Acceptable as a floor when a block truly has no subject evidence; a miss when
// it does.
const GENERIC_FALLBACK_LABELS = new Set(
  [
    'AI Tools',
    'Browsing',
    'Building & Testing',
    'Communication',
    'Computer activity',
    'Design',
    'Development',
    'Editor activity',
    'Email',
    'Entertainment',
    'General Browsing',
    'General Productivity',
    'Inbox Triage',
    'Insufficient Data',
    'Insufficient Data For Label',
    'Meeting',
    'Meetings',
    'Misc Tasks',
    'Mixed Browsing',
    'Mixed Work',
    'Productivity',
    'Research',
    'Research & AI Chat',
    'Social',
    'System',
    'Terminal Session',
    'Terminal Work',
    'Uncategorized',
    'Unlabeled activity',
    'Untitled',
    'Untitled Block',
    'Untracked time',
    'Web Session',
    'Writing',
  ].map((value) => normalizeForComparison(value)),
)

function normalizeForComparison(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function wordCount(value: string): number {
  return value.split(/\s+/).filter(Boolean).length
}

// A label that is one token ending in a file extension is the artifact, not
// the activity ("handoff.md", "run.ts"). DEV-276 recorded that a filename is
// never a label — including ordinary code filenames, which an earlier design
// allowed as deterministic fallbacks. Requires a letter-led extension so a
// version number ("1.0.45") or trailing ellipsis never matches.
const BARE_FILENAME_RE = /^[\w()[\]#@~+-]+\.[a-z][a-z0-9]{0,5}$/i
// Structural JSON: an opening brace, an array of objects/strings, or a quoted
// key whose colon is followed by a JSON value opener. A colon in prose
// ("Sprint planning: retro", 'Reviewed the "Q3 Roadmap": key priorities') and
// a bracketed title fragment ("[Week 1]") never match.
const JSON_FRAGMENT_RE = /^\{|^\[\s*[{["]|"[^"]*"\s*:\s*[{[\d"]/
// A label that is nothing but a bracketed fragment is tab-title cruft
// ("[Week 1]"), never an activity.
const BRACKETED_FRAGMENT_RE = /^\[[^\]]*\]$/

/**
 * The raw machine form a label carries, or null when it carries none.
 * Also used for intent subjects: a subject must not be a machine artifact
 * either. Repo paths ("src/main") remain allowed; single filenames do not
 * (DEV-276: a raw window title, a filename, a ticket description, or a JSON
 * string is never a label).
 */
// The two-tab sibling of "browser-tab soup". A browsing block's floor label is
// built by joining the two biggest site names with " + ", which produced
// "Campus + App" (campus.datacamp.com + app.datacamp.com), "Coursera +
// Datacamp", "Instagram + Google", "X (Twitter) + Factory", "Netflix +
// YouTube". Each names software, never an activity.
//
// Deliberately narrow, because "+" is legitimate mid-phrase: both sides must be
// at most two words AND every word must be capitalised, which is the shape of
// joined proper names and not of a written phrase. "Design + build the
// onboarding" keeps its lowercase "build" and survives.
function isTwoTabMashup(text: string): boolean {
  const parts = text.split(/\s\+\s/)
  if (parts.length !== 2) return false
  return parts.every((part) => {
    const words = part.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0 || words.length > 2) return false
    return words.every((word) => {
      const firstLetter = word.replace(/^[^\p{L}]+/u, '')[0]
      return firstLetter === undefined || firstLetter === firstLetter.toUpperCase()
    })
  })
}

export function rawLabelForm(value: string | null | undefined): string | null {
  const text = (value ?? '').trim()
  if (!text) return null
  if (RAW_URL_RE.test(text)) return 'raw URL'
  if (BARE_DATE_RE.test(text)) return 'bare date'
  if (BARE_DOMAIN_RE.test(text)) return 'bare domain'
  if (EMAIL_ADDRESS_RE.test(text)) return 'email address'
  if (RAW_FILE_EXTENSION_RE.test(text)) return 'file extension'
  if (UNDERSCORE_FILENAME_RE.test(text)) return 'underscore filename'
  if (looksLikeRawArtifactLabel(text)) return 'machine identifier'
  if (BARE_FILENAME_RE.test(text)) return 'filename'
  if (JSON_FRAGMENT_RE.test(text)) return 'JSON fragment'
  if (BRACKETED_FRAGMENT_RE.test(text)) return 'bracketed title fragment'
  if (NOTIFICATION_COUNT_RE.test(text)) return 'notification count'
  if (text.split(/\s*\|\s*/).filter(Boolean).length >= 3) return 'browser-tab soup'
  if (isTwoTabMashup(text)) return 'browser-tab mashup'
  if (TRAILING_BROWSER_RE.test(text)) return 'trailing browser name'
  return null
}

function checkNonemptyBounded(label: string): string | null {
  if (!label.trim()) return 'label is empty'
  if (label.length > MAX_LABEL_CHARS) return `label is ${label.length} characters (max ${MAX_LABEL_CHARS})`
  const words = wordCount(label)
  if (words > MAX_LABEL_WORDS) return `label is ${words} words (max ${MAX_LABEL_WORDS})`
  if (/[.!?]$/.test(label.trim())) return 'label ends like a sentence'
  return null
}

function checkPlumbingOrHype(label: string): string | null {
  const lower = label.toLowerCase()
  const plumbing = PLUMBING_TERMS.find((term) => lower.includes(term))
  if (plumbing) return `telemetry vocabulary "${plumbing}"`
  const hype = HYPE_TERMS.find((term) => lower.includes(term))
  if (hype) return `banned vocabulary "${hype}"`
  return null
}

function checkJudgment(label: string): string | null {
  const match = JUDGMENT_RE.exec(label)
  return match ? `judgment word "${match[0]}"` : null
}

function checkLeisureShape(label: string, context: LabelVoiceContext): string | null {
  if (context.kind !== 'leisure') return null
  if (LEISURE_ACTIVITY_SHAPE_RE.test(label.trim())) return null
  return 'leisure label is not activity-shaped'
}

function checkActivityNotSoftware(label: string, context: LabelVoiceContext): string | null {
  const appNames = context.appNames ?? []
  if (appNames.length === 0) return null
  const stripped = normalizeForComparison(label.replace(SOFTWARE_FILLER_RE, ''))
  if (!stripped) return null
  for (const appName of appNames) {
    const normalizedApp = normalizeForComparison(appName)
    if (!normalizedApp) continue
    if (stripped === normalizedApp) return `label is the app name "${appName}"`
    const appTokens = normalizedApp.split(' ').filter((token) => token.length >= 4)
    if (appTokens.includes(stripped)) return `label is the app name "${appName}"`
  }
  const normalizedLabel = normalizeForComparison(label)
  const appList = appNames.map(normalizeForComparison).filter(Boolean)
  // The "App, App and App — activity" floor is an honest fallback, not the voice.
  if (appList.length > 1 && normalizedLabel === `${appList.slice(0, -1).join(' ')} and ${appList.at(-1)} activity`) {
    return 'label is a list of app names'
  }
  return null
}

function checkVerbatimWindowTitle(label: string, context: LabelVoiceContext): string | null {
  const normalizedLabel = normalizeForComparison(label)
  if (!normalizedLabel) return null
  for (const title of [...(context.windowTitles ?? []), ...(context.pageTitles ?? [])]) {
    if (title && normalizeForComparison(title) === normalizedLabel) {
      return `label reproduces the captured title "${title}"`
    }
  }
  return null
}

function checkConcreteOverGeneric(label: string, context: LabelVoiceContext): string | null {
  if (!context.hasSubjectEvidence) return null
  if (GENERIC_FALLBACK_LABELS.has(normalizeForComparison(label))) {
    return `generic label "${label}" while the block carries subject evidence`
  }
  return null
}

function checkShortActivityPhrase(label: string): string | null {
  const words = wordCount(label)
  if (words < TARGET_MIN_WORDS) return `label is ${words} word (target ${TARGET_MIN_WORDS}-${TARGET_MAX_WORDS})`
  if (words > TARGET_MAX_WORDS) return `label is ${words} words (target ${TARGET_MIN_WORDS}-${TARGET_MAX_WORDS})`
  return null
}

/** Every rule, evaluated against one produced label. One finding per rule. */
export function evaluateLabelVoice(
  label: string,
  context: LabelVoiceContext = {},
): LabelVoiceFinding[] {
  const details: Record<LabelVoiceRuleId, string | null> = {
    'nonempty-bounded': checkNonemptyBounded(label),
    'no-raw-artifact-forms': ((form) => (form ? `label carries a ${form}` : null))(
      rawLabelForm(label),
    ),
    'no-plumbing-or-hype': checkPlumbingOrHype(label),
    'no-judgment': checkJudgment(label),
    'leisure-activity-shaped': checkLeisureShape(label, context),
    'activity-not-software': checkActivityNotSoftware(label, context),
    'no-verbatim-window-title': checkVerbatimWindowTitle(label, context),
    'concrete-over-generic': checkConcreteOverGeneric(label, context),
    'short-activity-phrase': checkShortActivityPhrase(label),
  }
  return LABEL_VOICE_RULES.map((rule) => ({
    rule: rule.id,
    tier: rule.tier,
    passed: details[rule.id] === null,
    detail: details[rule.id],
  }))
}

/**
 * The ONE relabel-time rejection both AI label paths enforce — the direct
 * relabel (generateWorkBlockInsight's labelRejection in jobs/aiService.ts)
 * and the interpretation agent (agentLabelViolation): every invariant rule,
 * the two target rules that catch echoed window titles and bare app names,
 * and the shared work-name-guard vocabulary (tool brands/surfaces, command
 * lines, joined tab titles, site surfaces — including a disqualified subject
 * hiding behind a verb lead, "Working on Cursor Agents"). Returns the
 * violation to feed the one corrective retry, or null when the label passes.
 */
export function labelCandidateViolation(
  label: string | null | undefined,
  context: LabelVoiceContext = {},
): string | null {
  const candidate = label?.trim()
  if (!candidate) return 'the label was empty'
  for (const finding of evaluateLabelVoice(candidate, context)) {
    if (finding.passed) continue
    if (finding.tier === 'invariant'
      || finding.rule === 'no-verbatim-window-title'
      || finding.rule === 'activity-not-software') {
      return finding.detail ?? finding.rule
    }
  }
  return workNameGuardLabelViolation(candidate)
}

/**
 * Context for a label evaluation, read off a timeline block. Field access is
 * structural and defensive because the projection and payload paths carry
 * slightly different page-reference shapes.
 */
export interface LabelVoiceBlockEvidence {
  topApps?: Array<{ appName?: string | null }> | null
  websites?: Array<{ topTitle?: string | null }> | null
  pageRefs?: Array<{ displayTitle?: string | null; title?: string | null; pageTitle?: string | null }> | null
  evidenceSummary?: {
    windowTitles?: Array<{ title?: string | null }> | null
    files?: Array<{ filename?: string | null }> | null
  } | null
}

export function labelVoiceContextForBlock(
  block: LabelVoiceBlockEvidence,
  kind?: string | null,
): LabelVoiceContext {
  const appNames = (block.topApps ?? [])
    .map((app) => (app.appName ?? '').trim())
    .filter(Boolean)
  const windowTitles = (block.evidenceSummary?.windowTitles ?? [])
    .map((entry) => (entry.title ?? '').trim())
    .filter(Boolean)
  const pageTitles = [
    ...(block.pageRefs ?? []).map((page) =>
      (page.displayTitle ?? page.title ?? page.pageTitle ?? '').trim(),
    ),
    ...(block.websites ?? []).map((site) => (site.topTitle ?? '').trim()),
  ].filter(Boolean)
  const files = (block.evidenceSummary?.files ?? [])
    .map((file) => (file.filename ?? '').trim())
    .filter(Boolean)
  return {
    appNames,
    windowTitles,
    pageTitles,
    kind: kind ?? null,
    hasSubjectEvidence: windowTitles.length > 0 || pageTitles.length > 0 || files.length > 0,
  }
}

export interface EvaluatedLabel {
  label: string
  findings: LabelVoiceFinding[]
}

export interface LabelVoiceRuleOutcome {
  rule: LabelVoiceRuleId
  tier: LabelVoiceTier
  requirement: string
  passed: number
  failed: number
  /** First failing detail, as the concrete example the report shows. */
  example: string | null
}

export interface LabelVoiceSummary {
  labelsEvaluated: number
  labelsMeetingInvariants: number
  labelsMeetingTarget: number
  rules: LabelVoiceRuleOutcome[]
}

export function summarizeLabelVoice(evaluated: EvaluatedLabel[]): LabelVoiceSummary {
  const rules: LabelVoiceRuleOutcome[] = LABEL_VOICE_RULES.map((rule) => {
    let passed = 0
    let failed = 0
    let example: string | null = null
    for (const entry of evaluated) {
      const finding = entry.findings.find((candidate) => candidate.rule === rule.id)
      if (!finding) continue
      if (finding.passed) passed += 1
      else {
        failed += 1
        example ??= `"${entry.label}" — ${finding.detail}`
      }
    }
    return { rule: rule.id, tier: rule.tier, requirement: rule.requirement, passed, failed, example }
  })
  return {
    labelsEvaluated: evaluated.length,
    labelsMeetingInvariants: evaluated.filter((entry) =>
      entry.findings.every((finding) => finding.tier !== 'invariant' || finding.passed),
    ).length,
    labelsMeetingTarget: evaluated.filter((entry) =>
      entry.findings.every((finding) => finding.passed),
    ).length,
    rules,
  }
}

// ── Recap voice ────────────────────────────────────────────────────────────
// The day recap and block narrative are prose a person reads about their own
// day. They must not leak internal vocabulary ("trusted blocks", "strongest
// evidence", "clearest named block") or read as a stat dump ("focus held for X
// of tracked time"). This check fails those shapes and passes calm prose.

// Internal vocabulary and template scaffolding a person would never write about
// their own day. Matched case-insensitively as substrings.
const RECAP_INTERNAL_PHRASES = [
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
]

export interface RecapVoiceFinding {
  phrase: string
  reason: string
}

/** Voice violations in a generated recap or block narrative. Empty = clean. */
export function recapVoiceFindings(text: string | null | undefined): RecapVoiceFinding[] {
  const value = (text ?? '').trim()
  if (!value) return []
  const lower = value.toLowerCase()
  const findings: RecapVoiceFinding[] = []
  for (const phrase of RECAP_INTERNAL_PHRASES) {
    if (lower.includes(phrase)) findings.push({ phrase, reason: 'internal vocabulary / template phrasing' })
  }
  for (const term of PLUMBING_TERMS) {
    if (lower.includes(term)) findings.push({ phrase: term, reason: 'capture/telemetry vocabulary' })
  }
  for (const term of HYPE_TERMS) {
    if (lower.includes(term)) findings.push({ phrase: term, reason: 'marketing filler' })
  }
  const judgment = JUDGMENT_RE.exec(value)
  if (judgment) findings.push({ phrase: judgment[0], reason: 'judges productivity/worth' })
  return findings
}

/** Markdown-ready lines for a review report's label-voice section. */
export function labelVoiceReportLines(summary: LabelVoiceSummary): string[] {
  const lines = [
    `Labels evaluated: ${summary.labelsEvaluated}; meeting invariants: ${summary.labelsMeetingInvariants}; meeting the full voice: ${summary.labelsMeetingTarget}.`,
    '',
    '| Rule | Tier | Pass | Fail | Example failure |',
    '| --- | --- | --- | --- | --- |',
  ]
  for (const rule of summary.rules) {
    lines.push(
      `| ${rule.rule} | ${rule.tier} | ${rule.passed} | ${rule.failed} | ${rule.example ?? '—'} |`,
    )
  }
  return lines
}
