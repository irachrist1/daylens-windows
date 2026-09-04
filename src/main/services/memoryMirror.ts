// Readable memory mirror (positioning.md §2 "The processing layer", decision 2).
//
// One Markdown file per day, written from the same corrected facts Timeline and
// Apps render. Two readers, one format:
//
//   a person  — opens the file, sees what Daylens recorded, deletes it if wrong
//   an agent  — reads the frontmatter for numbers and the body for meaning
//
// The invariant that makes it useful to the second reader: EVERY number lives in
// the frontmatter, and the prose below is descriptive only. An agent that needs
// a duration parses YAML instead of re-deriving it from a sentence — which is
// the failure class that produced "ten minutes" for a three-hour-forty-three
// session. The renderer does not mutate prose to enforce this (stripping a
// duration mid-sentence breaks grammar); it exposes proseDurationViolations()
// so the label pipeline and tests can catch a violation at its source.
//
// LOCAL-ONLY. These files are a projection of local data and never leave the
// machine on their own.
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const MEMORY_MIRROR_FORMAT = 'daylens-memory/1'

/** Written under the Codex memories convention so Codex and Claude Code read
 *  Daylens the same way they read their own extensions. Deliberately NOT
 *  `skysight/` — that directory belongs to another product. */
export const CODEX_EXTENSION_NAME = 'daylens'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export interface MirrorBlock {
  id: string
  startMs: number
  endMs: number
  /** Outcome title, past tense, no duration. */
  title: string
  /** One descriptive sentence, or null when the block was never labeled. */
  narrative: string | null
  /** Display names, most time first. */
  apps: string[]
  category: string
  /** True when a person corrected this block; an agent should trust it over
   *  anything it infers. */
  corrected: boolean
}

export interface MirrorApp {
  name: string
  bundleId: string | null
  seconds: number
}

export interface DayMemoryInput {
  date: string
  generatedAtMs: number
  timezone: string
  trackedSeconds: number
  blocks: MirrorBlock[]
  apps: MirrorApp[]
  entities: string[]
  /** Day-level sentence. Descriptive only. */
  narrative: string | null
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function clockIn(tz: string, ms: number): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: tz,
    }).format(new Date(ms))
  } catch {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(ms))
  }
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

/** Written out rather than delegated to Intl: ICU versions disagree on the
 *  en-GB separator ("Friday, 14 August" vs "Friday 14 August"), which would
 *  make a file's bytes depend on which runtime wrote it and rewrite unchanged
 *  days. A calendar date's weekday is the same in every timezone, so this needs
 *  no zone input. */
function longDate(date: string): string {
  if (!DATE_RE.test(date)) return date
  const [y, m, d] = date.split('-').map(Number)
  const at = Date.UTC(y, m - 1, d)
  if (Number.isNaN(at)) return date
  const parsed = new Date(at)
  if (parsed.getUTCMonth() !== m - 1 || parsed.getUTCDate() !== d) return date
  return `${WEEKDAYS[parsed.getUTCDay()]}, ${d} ${MONTHS[m - 1]} ${y}`
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.round((total % 3600) / 60)
  if (h > 0 && m > 0) return `${h}h ${m}m`
  if (h > 0) return `${h}h`
  return `${m}m`
}

// ─── Minimal YAML emitter ────────────────────────────────────────────────────
// Small and local rather than a dependency. Only the shapes below are emitted,
// so the quoting rules only have to cover scalars, string lists, and one level
// of object list.

function yamlScalar(value: string | number | boolean | null): string {
  if (value === null) return 'null'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  const needsQuote =
    value === '' ||
    /^[\s]|[\s]$/.test(value) ||
    /[:#\-?*&!|>'"%@`{}[\],]/.test(value) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(value) ||
    /^[\d.+-]/.test(value)
  if (!needsQuote) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`
}

function yamlStringList(values: readonly string[]): string {
  if (values.length === 0) return '[]'
  return `[${values.map((v) => yamlScalar(v)).join(', ')}]`
}

// ─── Prose rule ──────────────────────────────────────────────────────────────

const DURATION_IN_PROSE_RE =
  /\b\d+\s?(?:h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\b/gi

/** Duration-shaped tokens found in prose. Non-empty means the sentence carries
 *  a number the frontmatter is already authoritative for — the two can drift
 *  and contradict each other on one screen. */
export function proseDurationViolations(text: string | null | undefined): string[] {
  if (!text) return []
  return Array.from(text.matchAll(DURATION_IN_PROSE_RE), (m) => m[0])
}

// ─── Render ──────────────────────────────────────────────────────────────────

function sortedApps(apps: readonly MirrorApp[]): MirrorApp[] {
  return [...apps].sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name))
}

function sortedBlocks(blocks: readonly MirrorBlock[]): MirrorBlock[] {
  return [...blocks].sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id))
}

/** Deterministic: the same input renders byte-identical output, so an unchanged
 *  day does not rewrite its file and does not churn the user's filesystem. */
export function renderDayMemoryMarkdown(input: DayMemoryInput): string {
  const tz = input.timezone
  const blocks = sortedBlocks(input.blocks)
  const apps = sortedApps(input.apps)
  const entities = [...input.entities].sort((a, b) => a.localeCompare(b))

  const lines: string[] = []

  lines.push('---')
  lines.push(`format: ${MEMORY_MIRROR_FORMAT}`)
  lines.push(`date: ${input.date}`)
  lines.push(`generated_at: ${new Date(input.generatedAtMs).toISOString()}`)
  lines.push(`timezone: ${yamlScalar(tz)}`)
  lines.push(`tracked_seconds: ${Math.max(0, Math.round(input.trackedSeconds))}`)
  lines.push(`tracked: ${yamlScalar(formatDuration(input.trackedSeconds))}`)
  lines.push(`block_count: ${blocks.length}`)

  lines.push('blocks:')
  if (blocks.length === 0) {
    lines[lines.length - 1] = 'blocks: []'
  } else {
    for (const block of blocks) {
      const seconds = Math.max(0, Math.round((block.endMs - block.startMs) / 1000))
      lines.push(`  - id: ${yamlScalar(block.id)}`)
      lines.push(`    title: ${yamlScalar(block.title)}`)
      lines.push(`    start: ${yamlScalar(clockIn(tz, block.startMs))}`)
      lines.push(`    end: ${yamlScalar(clockIn(tz, block.endMs))}`)
      lines.push(`    start_ms: ${block.startMs}`)
      lines.push(`    end_ms: ${block.endMs}`)
      lines.push(`    seconds: ${seconds}`)
      lines.push(`    duration: ${yamlScalar(formatDuration(seconds))}`)
      lines.push(`    category: ${yamlScalar(block.category)}`)
      lines.push(`    corrected: ${block.corrected ? 'true' : 'false'}`)
      lines.push(`    apps: ${yamlStringList(block.apps)}`)
    }
  }

  if (apps.length === 0) {
    lines.push('apps: []')
  } else {
    lines.push('apps:')
    for (const app of apps) {
      lines.push(`  - name: ${yamlScalar(app.name)}`)
      lines.push(`    bundle_id: ${yamlScalar(app.bundleId)}`)
      lines.push(`    seconds: ${Math.max(0, Math.round(app.seconds))}`)
      lines.push(`    duration: ${yamlScalar(formatDuration(app.seconds))}`)
    }
  }

  lines.push(`entities: ${yamlStringList(entities)}`)
  lines.push('---')
  lines.push('')
  lines.push(`# ${longDate(input.date)}`)
  lines.push('')

  if (input.narrative) {
    lines.push(input.narrative)
    lines.push('')
  }

  if (blocks.length === 0) {
    lines.push('No tracked activity was recorded for this day.')
    lines.push('')
  }

  for (const block of blocks) {
    lines.push(`## ${block.title}`)
    const meta = `${clockIn(tz, block.startMs)} – ${clockIn(tz, block.endMs)}`
    lines.push(block.apps.length > 0 ? `${meta} · ${block.apps.join(', ')}` : meta)
    lines.push('')
    if (block.narrative) {
      lines.push(block.narrative)
      lines.push('')
    }
  }

  return `${lines.join('\n').trimEnd()}\n`
}

// ─── Index ───────────────────────────────────────────────────────────────────
// An agent pointed at a directory of 600 day files will try to read all of
// them: at ~4 KB a day that is roughly 600k tokens, which overflows any context
// window and fails by silently truncating to whatever it read first. The index
// is the fix — one small file that says what every day contains, so an agent
// reads it once and then opens only the days it needs.
//
// Newest first, deliberately: if anything truncates the list, recent days are
// what survives, and they are what nearly every question is about.

export const MEMORY_INDEX_FILE = 'INDEX.md'

/** Per-day line in the index. Derived from the day files themselves, so the
 *  index is always rebuildable from disk and cannot drift out of agreement
 *  with them. */
export interface MemoryDaySummary {
  date: string
  tracked: string
  titles: string[]
  entities: string[]
}

const MAX_INDEX_TITLES = 4

/** Days beyond this keep their line — so every day stays listed and linkable —
 *  but drop their titles, which are the bulk of a line. Without this the index
 *  grows past a comfortable read at multi-year scale; with it, five years costs
 *  about what one year of full detail does. */
const DETAILED_DAYS = 180

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  return trimmed
}

function parseInlineList(value: string): string[] {
  const trimmed = value.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return []
  const inner = trimmed.slice(1, -1).trim()
  if (inner === '') return []
  // Split on commas outside quotes — entity and app names may contain commas.
  const parts: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (ch === '"' && inner[i - 1] !== '\\') inQuotes = !inQuotes
    if (ch === ',' && !inQuotes) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts.map((part) => unquote(part)).filter((part) => part.length > 0)
}

/** Reads back the fields the index needs from a file this module wrote. Narrow
 *  by design: it understands exactly the shape renderDayMemoryMarkdown emits
 *  and returns null for anything else, so a stray file cannot corrupt the
 *  index. */
export function summarizeMemoryFile(text: string): MemoryDaySummary | null {
  if (!text.startsWith('---\n')) return null
  const end = text.indexOf('\n---\n', 4)
  if (end === -1) return null
  const lines = text.slice(4, end).split('\n')

  let date = ''
  let tracked = ''
  let entities: string[] = []
  const titles: string[] = []
  let inBlocks = false

  for (const line of lines) {
    if (/^[a-z_]+:/.test(line)) inBlocks = line.startsWith('blocks:')
    if (line.startsWith('date:')) date = unquote(line.slice(5))
    else if (line.startsWith('tracked:')) tracked = unquote(line.slice(8))
    else if (line.startsWith('entities:')) entities = parseInlineList(line.slice(9))
    else if (inBlocks && line.startsWith('    title:')) titles.push(unquote(line.slice(10)))
  }

  if (!DATE_RE.test(date)) return null
  return { date, tracked: tracked || '0m', titles, entities }
}

export function renderMemoryIndexMarkdown(summaries: readonly MemoryDaySummary[]): string {
  const ordered = [...summaries].sort((a, b) => b.date.localeCompare(a.date))
  const lines: string[] = []

  lines.push('# Daylens memory')
  lines.push('')
  lines.push(
    'A private, local record of what happened on this computer, one Markdown file per day.',
  )
  lines.push('')
  lines.push('## For agents')
  lines.push('')
  lines.push(
    'Read this index first, then open only the day files you need. Do not read every',
  )
  lines.push('file — the whole directory does not fit in a context window.')
  lines.push('')
  lines.push(
    'Each day file opens with a YAML block holding the numbers: `tracked_seconds`, and',
  )
  lines.push(
    'per block `seconds`, `start`, `end`, `apps`, and `corrected`. **Those numbers are',
  )
  lines.push(
    'authoritative — take durations and totals from them, never from the prose.** The',
  )
  lines.push('prose says what happened; it deliberately carries no figures.')
  lines.push('')
  lines.push('`corrected: true` means a person fixed that block by hand. Prefer it over')
  lines.push('anything inferred from the surrounding evidence.')
  lines.push('')
  lines.push(`## Days (${ordered.length}, newest first)`)
  lines.push('')

  if (ordered.length === 0) {
    lines.push('No days recorded yet.')
  } else {
    for (const [position, day] of ordered.entries()) {
      const entities = day.entities.length > 0 ? ` · ${day.entities.join(', ')}` : ''
      let body = ''
      if (position < DETAILED_DAYS) {
        const titles = day.titles.slice(0, MAX_INDEX_TITLES).join('; ')
        const more =
          day.titles.length > MAX_INDEX_TITLES
            ? ` (+${day.titles.length - MAX_INDEX_TITLES} more)`
            : ''
        body = titles ? ` — ${titles}${more}` : ''
      } else if (day.titles.length > 0) {
        body = ` — ${day.titles.length} block${day.titles.length === 1 ? '' : 's'}`
      }
      lines.push(`- [${day.date}](${day.date}.md) · ${day.tracked}${body}${entities}`)
    }
    if (ordered.length > DETAILED_DAYS) {
      lines.push('')
      lines.push(
        `Days past the most recent ${DETAILED_DAYS} are listed without their block titles. Open a day file to see them.`,
      )
    }
  }

  return `${lines.join('\n').trimEnd()}\n`
}

// ─── Paths ───────────────────────────────────────────────────────────────────

export function memoryMirrorRoot(userDataDir: string): string {
  return path.join(userDataDir, 'memories')
}

/** `$CODEX_HOME/memories/extensions/daylens`, defaulting to `~/.codex`. */
export function codexMemoryRoot(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const codexHome = env.CODEX_HOME?.trim() || path.join(home, '.codex')
  return path.join(codexHome, 'memories', 'extensions', CODEX_EXTENSION_NAME)
}

/** A date is used as a filename, so it is validated rather than trusted. */
export function memoryFileName(date: string): string {
  if (!DATE_RE.test(date)) throw new Error(`refusing to build a memory filename from ${JSON.stringify(date)}`)
  return `${date}.md`
}

// ─── Write ───────────────────────────────────────────────────────────────────

export interface WriteDayMemoryOptions {
  /** Daylens's own directory. Always written. */
  mirrorRoot: string
  /** Codex extension directory. Written only when export is enabled. */
  codexRoot?: string | null
}

export type WriteOutcome = 'written' | 'unchanged'

export interface WriteDayMemoryResult {
  date: string
  mirrorPath: string
  codexPath: string | null
  outcome: WriteOutcome
  bytes: number
}

async function writeIfChanged(target: string, contents: string): Promise<WriteOutcome> {
  try {
    if ((await fs.readFile(target, 'utf8')) === contents) return 'unchanged'
  } catch {
    // Missing or unreadable — fall through and write.
  }
  await fs.mkdir(path.dirname(target), { recursive: true })
  // Same directory keeps the rename atomic; a cross-device rename is not.
  const tmp = `${target}.${createHash('sha256').update(contents).digest('hex').slice(0, 8)}.tmp`
  await fs.writeFile(tmp, contents, { encoding: 'utf8', mode: 0o600 })
  try {
    await fs.rename(tmp, target)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
  return 'written'
}

export async function writeDayMemory(
  input: DayMemoryInput,
  options: WriteDayMemoryOptions,
): Promise<WriteDayMemoryResult> {
  const name = memoryFileName(input.date)
  const contents = renderDayMemoryMarkdown(input)
  const mirrorPath = path.join(options.mirrorRoot, name)
  const outcome = await writeIfChanged(mirrorPath, contents)

  let codexPath: string | null = null
  if (options.codexRoot) {
    codexPath = path.join(options.codexRoot, name)
    await writeIfChanged(codexPath, contents)
  }

  return { date: input.date, mirrorPath, codexPath, outcome, bytes: Buffer.byteLength(contents, 'utf8') }
}

/** Deleting a day's memory removes it from both roots. A file the person cannot
 *  fully delete is worse than one we never wrote. */
export async function deleteDayMemory(
  date: string,
  options: WriteDayMemoryOptions,
): Promise<string[]> {
  const name = memoryFileName(date)
  const removed: string[] = []
  for (const root of [options.mirrorRoot, options.codexRoot]) {
    if (!root) continue
    const target = path.join(root, name)
    try {
      await fs.rm(target)
      removed.push(target)
    } catch {
      // Already gone.
    }
  }
  return removed
}

/** Rebuilds the index from the day files themselves, so it self-heals: a file
 *  written by an older version, deleted outside the app, or half-written is
 *  reconciled on the next rebuild rather than tracked in parallel state. */
export async function rebuildMemoryIndex(options: WriteDayMemoryOptions): Promise<number> {
  const dates = await listDayMemories(options.mirrorRoot)
  const summaries: MemoryDaySummary[] = []
  for (const date of dates) {
    try {
      const text = await fs.readFile(path.join(options.mirrorRoot, memoryFileName(date)), 'utf8')
      const summary = summarizeMemoryFile(text)
      if (summary) summaries.push(summary)
    } catch {
      // Unreadable: leave it out rather than failing the whole index.
    }
  }
  const contents = renderMemoryIndexMarkdown(summaries)
  for (const root of [options.mirrorRoot, options.codexRoot]) {
    if (!root) continue
    await writeIfChanged(path.join(root, MEMORY_INDEX_FILE), contents)
  }
  return summaries.length
}

export async function listDayMemories(mirrorRoot: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(mirrorRoot)
    return entries
      .filter((name) => name.endsWith('.md') && DATE_RE.test(name.slice(0, -3)))
      .map((name) => name.slice(0, -3))
      .sort()
  } catch {
    return []
  }
}
