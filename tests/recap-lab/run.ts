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

async function main(): Promise<void> {
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
  initDb()

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

  for (const [index, variant] of variants.entries()) {
    const shipped = variant.id === SHIPPED_RECAP_VARIANT_ID
    console.log(color('bold', `[${index + 1}/${variants.length}] ${variant.id}${shipped ? color('dim', '  (currently shipped)') : ''}`))
    console.log(color('gray', `  ${variant.description}`))

    const startedAt = Date.now()
    let summary = ''
    let degraded = false
    let degradedReason: string | null = null
    try {
      const result = await generateDaySummary(dateStr, { variant, bypassCache: true })
      summary = result.summary
      degraded = result.degraded === true
      degradedReason = result.degradedReason ?? null
    } catch (error) {
      degraded = true
      degradedReason = error instanceof Error ? error.message : String(error)
      summary = ''
    }
    const ms = Date.now() - startedAt

    if (degraded) {
      // A degraded result means the model never produced a recap: what is
      // printed is the deterministic factual line, not this variant's output.
      console.log(color('red', `  FAILED after ${formatMs(ms)} — ${degradedReason ?? 'no reason given'}`))
      console.log(color('dim', wrap(summary || '(nothing)', 72, '  ')))
    } else {
      console.log(color('dim', `  ${formatMs(ms)}`))
      console.log('')
      console.log(wrap(summary))
    }

    const findings = recapVoiceFindings(summary).map((finding) => ({ phrase: finding.phrase, reason: finding.reason }))
    if (!degraded && findings.length > 0) {
      console.log('')
      for (const finding of findings) {
        console.log(color('yellow', `  voice: "${finding.phrase}" — ${finding.reason}`))
      }
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
