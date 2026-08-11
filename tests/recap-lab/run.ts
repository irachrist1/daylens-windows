// The recap lab (DEV-292) — read several recaps of one of YOUR real days,
// side by side, and pick the one that is both accurate and reads well.
//
// The recap is judged on two things: whether it is true about what you actually
// did, and how it sounds. Neither is answerable by reasoning about a prompt, so
// this runs every variant in src/main/ai/recapVariants.ts against a day from a
// read-only copy of your real database, prints the day's evidence first so you
// can check each claim against it, and reports each variant's latency and any
// findings from the recap voice check.
//
// Picking a winner means editing SHIPPED_RECAP_VARIANT_ID in recapVariants.ts.
// The latency column is what sets the day_summary job budget.
//
// Run with:
//   npm run lab:recap                 # yesterday
//   npm run lab:recap YYYY-MM-DD      # a specific day
//   npm run lab:recap YYYY-MM-DD colleague,terse   # only some variants
//
// Nothing here writes to your real database: it works on a copy, like the
// behavioural harness.

import fs from 'node:fs'
import path from 'node:path'
import { stageReadOnlyCopyOfRealDb, cleanupRealDbCopy } from '../ai-behaviour/realDb'
import { RECAP_VARIANTS, SHIPPED_RECAP_VARIANT_ID, type RecapPromptVariant } from '../../src/main/ai/recapVariants'
import { recapVoiceFindings } from '../../src/shared/labelVoice'
import type { AIProviderMode } from '@shared/types'

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
}
const color = (key: keyof typeof ANSI, value: string): string =>
  process.stdout.isTTY ? `${ANSI[key]}${value}${ANSI.reset}` : value

const RULE = '─'.repeat(74)

function yesterdayLocal(): string {
  const date = new Date()
  date.setDate(date.getDate() - 1)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// Wrap prose to the terminal so a recap reads as a paragraph, not one long line.
function wrap(text: string, width = 72, indent = '  '): string {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (line && (line.length + 1 + word.length) > width) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(line)
  return lines.map((entry) => `${indent}${entry}`).join('\n')
}

function formatMs(ms: number): string {
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 1000).toFixed(2)}s`
}

const PANEL_WIDTH = 68

// The recap panel as the person actually sees it after clicking the button —
// the same elements in the same order as the day inspector renders: the
// degraded banner when the recap could not be written, the recap itself, the
// divider, and the button row. Reading a variant means reading THIS, not a
// developer dump of it, so a wording problem is visible where it will land.
function renderRecapPanel(opts: {
  heading: string
  summary: string
  degraded: boolean
  degradedReason: string | null
  needsAction: boolean
}): string[] {
  const inner = PANEL_WIDTH - 4
  const lines: string[] = []
  const push = (text: string, style: keyof typeof ANSI | null = null) => {
    const padded = `│ ${text.padEnd(inner + 1)} │`
    lines.push(style ? color(style, padded) : padded)
  }
  const blank = () => push('')
  const soft = (text: string, style: keyof typeof ANSI) => {
    for (const line of wrap(text, inner, '').split('\n')) push(line, style)
  }

  lines.push(color('gray', `┌─ ${opts.heading} `.padEnd(PANEL_WIDTH - 1, '─') + '┐'))
  blank()
  if (opts.degraded) {
    // Verbatim from the inspector: nothing fails silently, and the reason is
    // passed straight through to the person.
    soft(
      opts.degradedReason
        ? `The full recap couldn't be generated — ${opts.degradedReason} Showing the day's facts; ${opts.needsAction ? 'generate again once that is sorted.' : 'Generate recap retries.'}`
        : "The full recap couldn't be generated. Showing the day's facts; Generate recap retries.",
      'dim',
    )
    blank()
  }
  for (const line of wrap(opts.summary || '(nothing)', inner, '').split('\n')) push(line)
  blank()
  // Styling goes through push's style argument, never baked into the text:
  // padEnd counts escape sequences and would shorten the visible line.
  push('─'.repeat(inner), 'gray')
  // A past day shows both buttons; the recap one reads "Regenerate" once a
  // recap exists, which it does by the time this panel is drawn.
  push('[ Re-analyze with AI ]  [ Regenerate recap ]', 'dim')
  blank()
  lines.push(color('gray', '└'.padEnd(PANEL_WIDTH - 1, '─') + '┘'))
  return lines
}

// The app logs breaker state and provider stack traces on failure. Useful when
// hunting a provider problem, noise when reading recap prose, so it is held
// back unless --verbose and reprinted under the panel when something failed.
function captureAppLogs<T>(verbose: boolean, run: () => Promise<T>): Promise<{ value: T; logs: string[] }> {
  if (verbose) return run().then((value) => ({ value, logs: [] }))
  const logs: string[] = []
  const original = { log: console.log, warn: console.warn, error: console.error }
  const sink = (...args: unknown[]) => { logs.push(args.map(String).join(' ')) }
  console.log = sink
  console.warn = sink
  console.error = sink
  const restore = () => { console.log = original.log; console.warn = original.warn; console.error = original.error }
  return run().then(
    (value) => { restore(); return { value, logs } },
    (error) => { restore(); throw error },
  )
}

async function main(): Promise<void> {
  const verbose = process.argv.includes('--verbose')
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
  const dateStr = args[0] && /^\d{4}-\d{2}-\d{2}$/.test(args[0]) ? args[0] : yesterdayLocal()
  const variantFilter = (args[0] && !/^\d{4}-\d{2}-\d{2}$/.test(args[0]) ? args[0] : args[1]) ?? ''

  let variants: RecapPromptVariant[] = RECAP_VARIANTS
  if (variantFilter) {
    const wanted = new Set(variantFilter.split(',').map((entry) => entry.trim()).filter(Boolean))
    variants = RECAP_VARIANTS.filter((variant) => wanted.has(variant.id))
    if (variants.length === 0) {
      console.error(color('red', `\n[fatal] No variant matched "${variantFilter}".`))
      console.error(`Known variants: ${RECAP_VARIANTS.map((variant) => variant.id).join(', ')}`)
      process.exit(2)
    }
  }

  console.log(color('bold', `\n=== Daylens recap lab — ${dateStr} ===\n`))

  // The copy must be staged before anything reads app.getPath('userData').
  const dbCtx = await stageReadOnlyCopyOfRealDb()
  console.log(color('dim', `[setup] real DB copy: ${dbCtx.copiedDbPath}`))

  const { initDb } = await import('../../src/main/services/database')
  await captureAppLogs(verbose, async () => initDb())

  const { getApiKey, setSettings, getSettings } = await import('../../src/main/services/settings')
  const provider = (process.env.DAYLENS_EVAL_PROVIDER ?? getSettings().aiProvider ?? 'anthropic') as AIProviderMode
  const isCliProvider = provider.endsWith('-cli')
  const apiKey = await getApiKey(provider)
  if (!apiKey && !isCliProvider) {
    console.error(color('red', `\n[fatal] No ${provider} key in keytar.`))
    console.error('Open Daylens → Settings → AI and save your key, then re-run.')
    cleanupRealDbCopy(dbCtx)
    process.exit(2)
  }
  if (apiKey) {
    if (provider === 'anthropic') process.env.ANTHROPIC_API_KEY = apiKey
    if (provider === 'openai') process.env.OPENAI_API_KEY = apiKey
    if (provider === 'google') { process.env.GOOGLE_API_KEY = apiKey; process.env.GEMINI_API_KEY = apiKey }
  }
  try {
    await setSettings({ aiProvider: provider })
  } catch { /* the staged config already names a provider */ }

  const { getDb } = await import('../../src/main/services/database')
  const { getTimelineDayPayload } = await import('../../src/main/services/workBlocks')
  const { generateDaySummary, buildDaySummaryScaffold } = await import('../../src/main/jobs/aiService')
  const { modelForProvider } = await import('../../src/main/services/aiOrchestration')

  const payload = getTimelineDayPayload(getDb(), dateStr, null, { analysis: false })
  if (payload.totalSeconds === 0) {
    console.error(color('red', `\n[fatal] Nothing tracked on ${dateStr}. Pick a day with activity.`))
    cleanupRealDbCopy(dbCtx)
    process.exit(2)
  }

  console.log(color('dim', `[setup] provider=${provider} · model=${modelForProvider(provider)}`))
  console.log(color('dim', `[setup] ${variants.length} variant(s): ${variants.map((v) => v.id).join(', ')}\n`))

  // ── The day itself, so accuracy is checkable ──────────────────────────────
  // The primary bar is whether a recap is TRUE about this day. That cannot be
  // judged from the prose alone, so the evidence goes first and every claim
  // below can be traced back to a line up here.
  console.log(color('bold', 'THE DAY AS RECORDED'))
  console.log(color('gray', RULE))
  const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  for (const block of payload.blocks) {
    const minutes = Math.round((block.endTime - block.startTime) / 60_000)
    console.log(`  ${color('cyan', `${hhmm(block.startTime)}–${hhmm(block.endTime)}`)} ${color('dim', `(${minutes}m)`)}  ${block.label.current}`)
    const apps = block.topApps.slice(0, 3).map((app) => app.appName).join(', ')
    if (apps) console.log(color('gray', `      apps: ${apps}`))
    const named = [
      ...block.topArtifacts.slice(0, 3).map((artifact) => artifact.displayTitle),
      ...block.pageRefs.slice(0, 3).map((page) => page.displayTitle),
    ].filter(Boolean)
    if (named.length > 0) console.log(color('gray', `      named: ${named.join(' · ')}`))
    if (block.label.narrative) console.log(color('gray', wrap(block.label.narrative, 66, '      ')))
  }
  for (const meeting of payload.scheduledMeetings ?? []) {
    console.log(`  ${color('cyan', `${hhmm(meeting.startMs)}–${hhmm(meeting.endMs)}`)} ${color('dim', '(calendar)')}  ${meeting.title} ${color('dim', `· ${meeting.marked ?? meeting.attendance}`)}`)
  }
  console.log(color('gray', RULE))
  const scaffoldChars = buildDaySummaryScaffold(payload).length
  console.log(color('dim', `  ${payload.blocks.length} blocks · scaffold ${scaffoldChars} chars\n`))

  // ── The variants ──────────────────────────────────────────────────────────
  const results: Array<{
    id: string
    description: string
    summary: string
    ms: number
    degraded: boolean
    degradedReason: string | null
    voiceFindings: Array<{ phrase: string; reason: string }>
  }> = []

  const dayHeading = new Date(`${dateStr}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  })

  for (const [index, variant] of variants.entries()) {
    const shipped = variant.id === SHIPPED_RECAP_VARIANT_ID
    console.log(color('bold', `[${index + 1}/${variants.length}] ${variant.id}${shipped ? color('dim', '  (currently shipped)') : ''}`))
    console.log(color('gray', `  ${variant.description}\n`))

    const startedAt = Date.now()
    let summary = ''
    let degraded = false
    let degradedReason: string | null = null
    let needsAction = false
    let appLogs: string[] = []
    try {
      const { value, logs } = await captureAppLogs(verbose, () =>
        generateDaySummary(dateStr, { variant, bypassCache: true }))
      appLogs = logs
      summary = value.summary
      degraded = value.degraded === true
      degradedReason = value.degradedReason ?? null
      needsAction = value.degradedNeedsAction === true
    } catch (error) {
      degraded = true
      degradedReason = error instanceof Error ? error.message : String(error)
      summary = ''
    }
    const ms = Date.now() - startedAt

    // What the person sees, first and largest — the thing being judged.
    for (const line of renderRecapPanel({ heading: `Timeline · ${dayHeading}`, summary, degraded, degradedReason, needsAction })) {
      console.log(`  ${line}`)
    }

    // Everything below is for whoever is tuning, not for the person.
    const findings = recapVoiceFindings(summary).map((finding) => ({ phrase: finding.phrase, reason: finding.reason }))
    console.log(color('dim', `\n  took ${formatMs(ms)}${degraded ? ' · no recap was written; the panel above is the factual fallback' : ''}`))
    if (!degraded) {
      for (const finding of findings) {
        console.log(color('yellow', `  voice: "${finding.phrase}" — ${finding.reason}`))
      }
    }
    if (degraded && appLogs.length > 0) {
      console.log(color('gray', '  ─── why it failed ───'))
      for (const line of appLogs.slice(0, 4)) {
        console.log(color('gray', `  ${line.split('\n')[0].slice(0, 140)}`))
      }
      console.log(color('gray', '  (run with --verbose for the full provider output)'))
    }
    console.log('')

    results.push({ id: variant.id, description: variant.description, summary, ms, degraded, degradedReason, voiceFindings: findings })
  }

  // ── Summary table: what to ship, and what budget it needs ─────────────────
  console.log(color('bold', 'AT A GLANCE'))
  console.log(color('gray', RULE))
  for (const result of results) {
    const state = result.degraded
      ? color('red', 'failed')
      : result.voiceFindings.length > 0
        ? color('yellow', `${result.voiceFindings.length} voice flag${result.voiceFindings.length === 1 ? '' : 's'}`)
        : color('green', 'clean')
    console.log(`  ${result.id.padEnd(16)} ${formatMs(result.ms).padStart(7)}  ${state}`)
  }
  console.log(color('gray', RULE))

  const slowest = results.reduce((worst, result) => (result.ms > worst.ms ? result : worst), results[0])
  if (slowest && !slowest.degraded) {
    // The budget question, answered from measurement rather than a guess —
    // the same way the wrapped narrative's 90s was set.
    console.log(color('dim', `  slowest completed run: ${formatMs(slowest.ms)} (${slowest.id}). The day_summary`))
    console.log(color('dim', `  budget must clear this with room on a heavier day.`))
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = path.join(process.cwd(), '.recap-lab')
  fs.mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, `${dateStr}-${stamp}.json`)
  fs.writeFileSync(outPath, JSON.stringify({ date: dateStr, provider, model: modelForProvider(provider), results }, null, 2))
  console.log(color('dim', `\n  written: ${outPath}`))
  console.log(color('dim', '  To ship one: set SHIPPED_RECAP_VARIANT_ID in src/main/ai/recapVariants.ts\n'))

  cleanupRealDbCopy(dbCtx)
}

main().catch((error) => {
  console.error(color('red', `\n[fatal] ${error instanceof Error ? error.stack ?? error.message : String(error)}`))
  process.exit(1)
})
