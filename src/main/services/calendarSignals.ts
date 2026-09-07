// Calendar connector (optional) — what MEETINGS shaped the day.
//
// macOS: a bundled EventKit helper (src/native/calendar-helper). One Calendar
// permission prompt on Daylens.app; every account already in Apple Calendar
// is visible. Windows: Outlook COM via PowerShell until a package-identity
// WinRT path is proven. Linux: no universal store; this function returns
// null. Neither live path touches the network. OAuth is fallback-only and
// is not wired here.
//
// The result contract distinguishes two very different "nothing"s for the
// scan ledger (externalSignals.ts), exactly like gitSignals.ts: an
// UNREACHABLE source (helper missing, permission denied, Outlook missing, a
// subprocess timeout or error) THROWS — the day was never actually checked,
// so it must stay collectable and never be remembered as "collected, empty"
// — while a source that ran and found no events returns null. The caller
// (collectExternalSignals) catches the throw and the wrap proceeds without
// the signal either way. We never include attendee names, locations, or
// notes — only a title, a start time, a duration, and an attendee COUNT.
//
// All-day events are skipped on every platform. There is no honest single
// "start time" for something that spans the whole day, and CalendarEventSignal
// requires one, so we drop them rather than invent a 12:00am/end-of-day time
// that would misrepresent the day's actual schedule.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { CalendarEventSignal, CalendarSignal } from '@shared/types'

const EVENTKIT_HELPER_TIMEOUT_MS = 60_000
const POWERSHELL_TIMEOUT_MS = 12_000
const MAX_TITLE_LENGTH = 120
const MAX_EVENTS = 40

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function execFileP(cmd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
        resolve(error ? null : stdout.toString())
      })
    } catch {
      resolve(null)
    }
  })
}

/** Trim, collapse whitespace, strip control characters, cap length. Applied
 *  to titles only — we never emit attendee names, locations, or notes. */
function cleanTitle(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return ''
  return cleaned.length > MAX_TITLE_LENGTH ? `${cleaned.slice(0, MAX_TITLE_LENGTH - 1)}…` : cleaned
}

/** "11:15am" style: lowercase, no leading zero on the hour, ":00" dropped. */
function formatClock12(hour24: number, minute: number): string {
  const period = hour24 < 12 ? 'am' : 'pm'
  let hour12 = hour24 % 12
  if (hour12 === 0) hour12 = 12
  const minutePart = minute === 0 ? '' : `:${String(minute).padStart(2, '0')}`
  return `${hour12}${minutePart}${period}`
}

function defaultHelperCandidates(): string[] {
  const names = [
    path.join('calendar-helper.app', 'Contents', 'MacOS', 'calendar-helper'),
    'calendar-helper',
  ]
  const roots = [
    typeof process.resourcesPath === 'string' ? path.join(process.resourcesPath, 'build') : null,
    path.join(__dirname, '..', '..', 'build'),
    path.join(process.cwd(), 'build'),
  ].filter((root): root is string => Boolean(root))
  return roots.flatMap((root) => names.map((name) => path.join(root, name)))
}

/** Bundled EventKit helper, or null when this checkout/install has not built it. */
export function resolveCalendarHelperBinary(candidates = defaultHelperCandidates()): string | null {
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    } catch {
      // keep looking
    }
  }
  return null
}

function asFiniteInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.round(value)
}

/** Maps one EventKit helper event onto CalendarEventSignal. Drops junk. */
export function parseEventKitHelperEvent(raw: unknown): CalendarEventSignal | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const title = typeof record.title === 'string' ? cleanTitle(record.title) : ''
  if (!title) return null

  const startHour = asFiniteInt(record.startHour)
  const startMinute = asFiniteInt(record.startMinute)
  const durationMinutes = asFiniteInt(record.durationMinutes)
  if (startHour === null || startHour < 0 || startHour > 23) return null
  if (startMinute === null || startMinute < 0 || startMinute > 59) return null
  if (durationMinutes === null || durationMinutes < 0) return null

  let attendeeCount: number | null = null
  if (record.attendeeCount !== undefined && record.attendeeCount !== null) {
    const count = asFiniteInt(record.attendeeCount)
    if (count === null || count < 0) return null
    attendeeCount = count
  }

  return {
    title,
    startClock: formatClock12(startHour, startMinute),
    durationMinutes,
    attendeeCount,
  }
}

/** Parses the helper's one-line JSON object. Throws on denial or a bad payload
 *  so the day is never ledgered as an empty successful read. */
export function parseEventKitHelperOutput(output: string): CalendarEventSignal[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new Error('EventKit helper failed: invalid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('EventKit helper failed: invalid payload')
  }
  const record = parsed as Record<string, unknown>
  if (record.ok !== true) {
    const code = typeof record.error === 'string' && record.error ? record.error : 'unknown'
    throw new Error(`EventKit helper failed: ${code}`)
  }
  if (!Array.isArray(record.events)) {
    throw new Error('EventKit helper failed: events missing')
  }
  return record.events
    .map(parseEventKitHelperEvent)
    .filter((event): event is CalendarEventSignal => event !== null)
    .slice(0, MAX_EVENTS)
}

async function collectMacCalendarEvents(
  date: string,
  opts: CollectCalendarOptions,
): Promise<CalendarSignal | null> {
  const binary = (opts.resolveHelper ?? resolveCalendarHelperBinary)()
  if (!binary) throw new Error('EventKit helper unavailable: calendar-helper not built')
  const output = await (opts.run ?? execFileP)(binary, [date], EVENTKIT_HELPER_TIMEOUT_MS)
  if (output == null) throw new Error('EventKit helper failed: subprocess error or timeout')
  const events = parseEventKitHelperOutput(output)
  if (events.length === 0) return null
  return { events }
}

// ─── Windows: Outlook COM via PowerShell (fallback) ─────────────────────────

/** Parses one line of our PowerShell invocation's output: exactly four
 *  tab-separated fields (Subject, "HH:mm" start time, duration in minutes,
 *  recipient count). Any line that doesn't split into exactly four fields,
 *  or whose time/number fields don't parse, is dropped. */
export function parsePowerShellCalendarLine(line: string): CalendarEventSignal | null {
  const parts = line.split('\t')
  if (parts.length !== 4) return null
  const [subjectRaw, startRaw, durationRaw, recipientRaw] = parts

  const title = cleanTitle(subjectRaw)
  if (!title) return null

  const timeMatch = startRaw.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!timeMatch) return null
  const hour = Number(timeMatch[1])
  const minute = Number(timeMatch[2])
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 23 || minute > 59) return null

  const durationMinutes = Number(durationRaw.trim())
  if (!Number.isFinite(durationMinutes) || durationMinutes < 0) return null

  const recipientCount = Number(recipientRaw.trim())
  const attendeeCount = Number.isFinite(recipientCount) && recipientCount >= 0 ? Math.round(recipientCount) : null

  return {
    title,
    startClock: formatClock12(hour, minute),
    durationMinutes: Math.round(durationMinutes),
    attendeeCount,
  }
}

/** Parses the full stdout of our PowerShell invocation. */
export function parsePowerShellCalendarOutput(output: string): CalendarEventSignal[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parsePowerShellCalendarLine)
    .filter((e): e is CalendarEventSignal => e !== null)
    .slice(0, MAX_EVENTS)
}

/** Builds the single -Command script: restricts the default Outlook
 *  calendar folder to [date, date+1) and prints one tab-separated line per
 *  timed event. All-day events are skipped up front in the script itself.
 *  [char]9 / [char]39 stand in for tab and single-quote so the filter string
 *  never needs fragile in-string escaping. */
function buildOutlookScript(date: string): string {
  return [
    '$ErrorActionPreference = "Stop"',
    `$dayStart = [DateTime]::ParseExact("${date}", "yyyy-MM-dd", $null)`,
    '$dayEnd = $dayStart.AddDays(1)',
    '$outlook = New-Object -ComObject Outlook.Application',
    '$namespace = $outlook.GetNamespace("MAPI")',
    '$calendar = $namespace.GetDefaultFolder(9)',
    '$items = $calendar.Items',
    // Outlook COM requires Sort("[Start]") BEFORE IncludeRecurrences = true,
    // or recurring appointments expand unreliably.
    '$items.Sort("[Start]")',
    '$items.IncludeRecurrences = $true',
    '$q = [char]39',
    '$filter = "[Start] >= " + $q + $dayStart.ToString("g") + $q + " AND [Start] < " + $q + $dayEnd.ToString("g") + $q',
    '$restricted = $items.Restrict($filter)',
    'foreach ($item in $restricted) {',
    '  if ($item.AllDayEvent) { continue }',
    '  $subject = ($item.Subject -replace "`t", " ") -replace "`r|`n", " "',
    '  $startTime = $item.Start.ToString("HH:mm")',
    '  $duration = [Math]::Round(($item.End - $item.Start).TotalMinutes)',
    '  $recipientCount = 0',
    '  if ($item.Recipients) { $recipientCount = $item.Recipients.Count }',
    '  Write-Output ($subject + [char]9 + $startTime + [char]9 + $duration + [char]9 + $recipientCount)',
    '}',
  ].join('\n')
}

async function collectWindowsCalendarEvents(
  date: string,
  opts: CollectCalendarOptions,
): Promise<CalendarSignal | null> {
  const script = buildOutlookScript(date)
  const output = await (opts.run ?? execFileP)(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    POWERSHELL_TIMEOUT_MS,
  )
  if (output == null) throw new Error('Outlook unavailable: PowerShell/COM error or timeout')
  const events = parsePowerShellCalendarOutput(output)
  if (events.length === 0) return null
  return { events }
}

// ─── Entry point ────────────────────────────────────────────────────────────

/** Injectable seams so the unavailable-vs-empty contract is testable without
 *  a Mac GUI, EventKit permission, or a real Outlook process. */
export interface CollectCalendarOptions {
  platform?: NodeJS.Platform
  resolveHelper?: () => string | null
  run?: (cmd: string, args: string[], timeoutMs: number) => Promise<string | null>
}

/** The day's calendar: event titles, start times, durations, and attendee
 *  counts only. Null when the source RAN and the date has no timed events;
 *  THROWS when no source could actually be read (helper missing, Calendar
 *  permission denied, Outlook missing, a subprocess timeout/error), so an
 *  unchecked day is never remembered as "collected, empty". Linux returns
 *  null — no universal store, a permanent property of the install. */
export async function collectCalendarEvents(
  date: string,
  opts: CollectCalendarOptions = {},
): Promise<CalendarSignal | null> {
  if (!DATE_RE.test(date)) return null
  const platform = opts.platform ?? process.platform
  if (platform === 'win32') return await collectWindowsCalendarEvents(date, opts)
  if (platform === 'darwin') return await collectMacCalendarEvents(date, opts)
  return null
}
