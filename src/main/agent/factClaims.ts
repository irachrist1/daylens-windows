// Factual-claim scanning primitives (WO-53 / REQ-AIA-002).
//
// Both halves of evidence enforcement need to read numbers out of prose the
// same way: the deterministic-fact enforcer has to find the figure an answer
// stated so it can compare it against the computed one, and the coverage pass
// has to find every factual figure so it can look for backing evidence. One
// scanner, so "what counts as a stated duration" cannot drift between them.
//
// Deliberately narrow. A false positive here either rewrites a number the
// model got right or appends an uncertainty line to a grounded answer, and
// both are worse than missing an exotic phrasing. Only shapes that are
// unambiguously a duration, a clock time, or a calendar date are matched.

/** One duration expression found in text, normalized to seconds. */
export interface DurationMatch {
  /** Character offset of the first character of the expression. */
  start: number
  /** Character offset one past the last character. */
  end: number
  /** The matched text exactly as it appeared. */
  text: string
  seconds: number
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
}

const NUM = String.raw`\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve`
// Longest alternative first so "hours" cannot be consumed as "hour" + stray "s".
const HOURS = String.raw`(?:hours|hour|hrs|hr|h)`
const MINUTES = String.raw`(?:minutes|minute|mins|min|m)`

// The unit must not run on into another word: "3 h" is three hours, "3 happy"
// is not, and "3 m" is three minutes while "3 metres" is not. A plain \b would
// reject the very common "3h30m", where a digit legitimately follows the unit,
// so the guard is "no letter next" rather than "a word boundary".
const UNIT_END = String.raw`(?![a-z])`

// Two shapes: "<n> hours [and] [<n> minutes]" and a bare "<n> minutes".
const DURATION_RE = new RegExp(
  String.raw`\b(${NUM})\s*${HOURS}${UNIT_END}(?:\s*(?:and\s+)?(${NUM})\s*${MINUTES}${UNIT_END})?`
  + '|'
  + String.raw`\b(${NUM})\s*${MINUTES}${UNIT_END}`,
  'gi',
)

function numeric(token: string | undefined): number | null {
  if (!token) return null
  const word = NUMBER_WORDS[token.toLowerCase()]
  if (word != null) return word
  const value = Number(token)
  return Number.isFinite(value) ? value : null
}

/**
 * Every duration expression in `text`, in order, normalized to seconds.
 * "3h 12m", "3 hours and 12 minutes", "two hours", "45 mins" all resolve.
 */
export function scanDurations(text: string): DurationMatch[] {
  const matches: DurationMatch[] = []
  if (!text) return matches
  DURATION_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = DURATION_RE.exec(text)) !== null) {
    const hours = numeric(match[1])
    const minutesWithHours = numeric(match[2])
    const bareMinutes = numeric(match[3])
    let seconds: number | null = null
    if (hours != null) seconds = Math.round(hours * 3600 + (minutesWithHours ?? 0) * 60)
    else if (bareMinutes != null) seconds = Math.round(bareMinutes * 60)
    if (seconds == null) continue
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      seconds,
    })
  }
  return matches
}

/**
 * Render seconds the way Daylens renders every other duration. Mirrors the
 * renderer's formatDuration so a repaired figure reads identically to the one
 * the Timeline and Apps screens show for the same evidence.
 */
export function renderDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  if (whole < 60) return `${whole}s`
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  if (hours === 0) return `${minutes}m`
  return `${hours}h ${minutes}m`
}

/** Every bare integer in text, used as the evidence-side number corpus. */
export function scanIntegers(text: string): number[] {
  const values: number[] = []
  for (const raw of text.match(/\b\d{1,10}\b/g) ?? []) {
    const value = Number(raw)
    if (Number.isFinite(value)) values.push(value)
  }
  return values
}

/** HH:MM clock times in text, normalized to 24h "HH:MM" strings. */
export function scanClockTimes(text: string): string[] {
  const found = new Set<string>()
  const pattern = /\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    let hour = Number(match[1])
    const minute = Number(match[2])
    const meridiem = match[3]?.toLowerCase()
    if (meridiem === 'pm' && hour < 12) hour += 12
    if (meridiem === 'am' && hour === 12) hour = 0
    if (hour > 23 || minute > 59) continue
    found.add(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`)
  }
  return [...found]
}

/** ISO calendar dates in text. */
export function scanIsoDates(text: string): string[] {
  return [...new Set(text.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [])]
}
