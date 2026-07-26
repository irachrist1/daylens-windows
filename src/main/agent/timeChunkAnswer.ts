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
  activity: TimeChunkActivity[]
  pages: TimeChunkPage[]
  gap: { label: string } | null
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

function rowDescription(chunk: TimeChunkRow): string {
  if (chunk.activity.length === 0) return chunk.gap?.label ?? 'no activity captured'
  const activity: string[] = []
  const known = new Set<string>()
  for (const item of chunk.activity) {
    const title = userVisibleWindowTitle(item.windowTitle)
    // Colon, never an em dash: the voice contract bans em dashes in every
    // surface, including the tables composed here rather than by the model.
    const label = title && title.toLowerCase() !== item.appName.toLowerCase()
      ? `${item.appName}: ${concise(title)}`
      : item.appName
    const key = label.toLowerCase()
    if (known.has(key)) continue
    known.add(key)
    activity.push(label)
    if (activity.length >= 3) break
  }
  for (const page of chunk.pages) {
    const title = page.pageTitle?.trim()
    if (!title || known.has(title.toLowerCase())) continue
    const label = concise(title)
    known.add(label.toLowerCase())
    activity.push(label)
    if (activity.length >= 4) break
  }
  return activity.join('; ')
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
