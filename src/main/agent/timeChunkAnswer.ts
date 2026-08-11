import { isUsefulLabel, naturalizeLabel } from '@shared/blockLabel'
import { rawLabelForm } from '@shared/labelVoice'

interface TimeChunkActivity {
  appName: string
  windowTitle: string | null
  seconds: number
}

interface TimeChunkPage {
  pageTitle: string | null
}

interface TimeChunkRow {
  startTime: string
  endTime: string
  durationMinutes: number
  /** The covering timeline block's label: what the time WAS, not just the app. */
  blockLabel?: string | null
  activity: TimeChunkActivity[]
  pages: TimeChunkPage[]
  gap: { label: string; kind?: string | null } | null
}

export interface TimeChunkResult {
  found: boolean
  date: string
  incrementMinutes: number
  chunks: TimeChunkRow[]
}

// Titles arrive as the app wrote them, and plenty of apps put an em dash in
// their window title ("Gemini — Digital File Organization Strategy"). Echoing
// one into the table would break the voice contract's punctuation rule on a
// surface Daylens composes itself, so the separator is normalized here, the
// same place the title is already shortened for display.
function concise(value: string, limit = 72): string {
  const normalized = value.trim().replace(/\s+/g, ' ').replace(/\s*—\s*/g, ': ')
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1).trimEnd()}…`
}

function userVisibleWindowTitle(value: string | null): string | null {
  const title = value?.trim() ?? ''
  if (!title) return null
  if (/Wants to run|AskUserQuestion|tool[_ -]?call|\b(?:get|list|search|create|read)_[a-z0-9_]+\b|\{\s*"/i.test(title)) return null
  return title
}

/**
 * A captured title reduced to something that describes what the person was
 * doing, or null when it describes nothing.
 *
 * A raw title is evidence, not a description (AC-VIC-001.4). The same forms
 * that disqualify a Timeline label disqualify a chunk row: a bare URL, browser
 * tab soup, a filename, an email address lifted out of a calendar window, a
 * notification count. Those used to be printed here verbatim, which made the
 * chunk table the one surface where the label policy did not apply.
 *
 * Em dashes are normalized to colons *before* naturalizeLabel: that helper
 * splits on em dashes and would otherwise keep only the app name from a title
 * like "Gemini — Digital File Organization Strategy".
 */
function describableTitle(value: string | null | undefined): string | null {
  const title = userVisibleWindowTitle(value ?? null)
  if (!title) return null
  // Reject the raw forms on the captured title itself. naturalizeLabel can
  // salvage tab soup into a fragment that looks fine ("Unread (12)") and would
  // otherwise slip past as a description — the policy must see the original.
  if (rawLabelForm(title)) return null
  const withoutEmDash = title.replace(/\s*—\s*/g, ': ')
  const natural = naturalizeLabel(withoutEmDash).trim()
  if (!natural || rawLabelForm(natural)) return null
  return concise(natural)
}

/**
 * The covering Timeline label is already the resolved, user-visible wording
 * (`userVisibleBlockLabel`), including a user override. Trust a useful label
 * verbatim: applying `rawLabelForm` here would strip a person's own name for
 * the stretch (AC-VIC-004). A generic floor label ("Development", "Browsing")
 * is not a description — leave the subject empty so captured titles can name
 * the actual work instead of burying it under the category word.
 */
function finalizedBlockLabel(value: string | null | undefined): string | null {
  const text = value?.trim()
  if (!text) return null
  if (!isUsefulLabel(text)) return null
  return concise(text)
}

function formatList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? ''
  return `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`
}

// A gap is preserved as a gap: the row says what the machine was doing, or that
// nothing was captured, and never guesses at the person. The producer's own
// labels characterized unobserved time ("likely away or idle"), which is the
// same claim the wrap validator rejects as an overclaim — unobserved time is
// unknown, never idle, and never a judgment about someone's attention.
function gapKind(gap: { label: string; kind?: string | null }): string {
  const kind = (gap.kind ?? '').toLowerCase()
  const label = gap.label.toLowerCase()
  if (kind.includes('asleep') || label.includes('asleep')) return 'asleep'
  if (kind.includes('locked') || label.includes('locked')) return 'locked'
  if (kind.includes('untracked') || label.includes('no data captured') || label.includes('tracking failure')) return 'untracked'
  return 'quiet'
}

function gapDescription(gap: { label: string; kind?: string | null } | null): string {
  if (!gap) return 'nothing was captured here'
  switch (gapKind(gap)) {
    case 'asleep':
      return 'the machine was asleep or locked'
    case 'locked':
      return 'the machine was locked'
    case 'untracked':
      return 'nothing was captured here, which can mean tracking stopped'
    default:
      return 'nothing was captured here'
  }
}

/**
 * One row's description, under the shared activity-description policy: the
 * understood activity first, the apps it was observed through as tail
 * attribution, and one plain sentence when the evidence cannot name the
 * activity at all (AC-VIC-001.3, AC-VIC-001.4, AC-VIC-003.1).
 *
 * The old shape led with the app ("Editor: Project review", or just "Terminal"),
 * which is the raw telemetry standing in for the description.
 */
function rowDescription(chunk: TimeChunkRow): string {
  if (chunk.activity.length === 0) return gapDescription(chunk.gap)

  const subjects: string[] = []
  const seen = new Set<string>()
  const push = (value: string | null): void => {
    if (!value) return
    const key = value.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    subjects.push(value)
  }

  // The covering block names what the stretch WAS; it is already the resolved
  // label the Timeline shows (including a user override), so it leads. When it
  // is present, window and page titles stay evidence — they do not compete as
  // a second subject beside the label the person is already looking at.
  push(finalizedBlockLabel(chunk.blockLabel))
  if (subjects.length === 0) {
    for (const item of chunk.activity) push(describableTitle(item.windowTitle))
    for (const page of chunk.pages) push(describableTitle(page.pageTitle))
  }

  const apps: string[] = []
  for (const item of chunk.activity) {
    const name = item.appName.trim()
    if (!name || apps.some((existing) => existing.toLowerCase() === name.toLowerCase())) continue
    apps.push(name)
    if (apps.length >= 3) break
  }
  const attribution = apps.length > 0 ? formatList(apps) : null

  if (subjects.length === 0) {
    // Naming the app and stopping would make the tool the activity. Say what is
    // actually known and say the limit plainly, once, without guessing.
    return attribution
      ? `${attribution} ${apps.length === 1 ? 'was' : 'were'} open, and what they were used for was not captured`
      : 'what happened here was not captured'
  }

  const lead = subjects.slice(0, 3).join('; ')
  return attribution ? `${lead} (${attribution})` : lead
}

// Does the question ask for the day broken into fixed increments? Gates the
// deterministic chunk-table override in chatAgent: the table must take over
// for every increment-shaped phrasing (including follow-up refinements like
// "make it 15-minute rows instead"), but never hijack a turn that merely
// consulted get_time_chunks while researching something else.
const CHUNK_NOUNS = /\b(?:chunks?|increments?|intervals?|segments?|buckets?)\b/i
const SPLIT_INTO = /\b(?:break|split|divide|chop)(?:\s+\S+){0,5}\s+(?:into|in|by)\b/i
const HOURLY = /\bhour(?:ly|[- ]by[- ]hour)\b/i
const N_MINUTES = /\b\d{1,3}[- ]?min(?:ute)?s?\b/i
const HALF_HOUR = /\bhalf[- ]hours?\b/i

export function wantsTimeChunkTable(question: string): boolean {
  return CHUNK_NOUNS.test(question)
    || SPLIT_INTO.test(question)
    || HOURLY.test(question)
    || N_MINUTES.test(question)
    || HALF_HOUR.test(question)
}

export function renderTimeChunkAnswer(result: TimeChunkResult): string | null {
  if (!result.found || !result.date || !result.incrementMinutes || result.chunks.length === 0) return null
  const date = new Date(`${result.date}T12:00:00`)
  const label = Number.isNaN(date.getTime())
    ? result.date
    : date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  const rows = result.chunks.map((chunk) => (
    `| ${chunk.startTime}–${chunk.endTime} | ${rowDescription(chunk).replace(/\|/g, '\\|')} |`
  ))
  return [
    `${label} in ${result.incrementMinutes}-minute chunks:`,
    '',
    '| Time | Activity |',
    '|---|---|',
    ...rows,
  ].join('\n')
}
