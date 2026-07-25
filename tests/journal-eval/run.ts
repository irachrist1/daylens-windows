// Journal-anchored day eval runner.
//
//   npm run eval:days                     fast: deterministic dimensions only
//   npm run eval:days -- --judge          + LLM shape judge (1 call/day)
//   npm run eval:days -- --strict         non-zero exit under thresholds
//   npm run eval:days -- 2026-07-22 …     only these days
//   npm run eval:days -- --fresh          restage work DB from pristine first
//
// Scores what the user actually sees — timeline block labels + narratives and
// the wrapped narrative (stored if present, deterministic fallback otherwise;
// never spends a wrap-generation call) — against tests/journal-eval/days/*.yaml.
// Local-only: needs the real-DB snapshot (daylens db snapshot). Results land
// in .journal-eval/results-<stamp>.json plus a table on stdout.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { openHarness } from '../../cli/context'
import { c, fmtDuration, fmtTime } from '../../cli/render'
import type { DayScore, EvalDay } from './schema'
import { scoreDay, type ObservedDay } from './score'

const evalDir = path.dirname(fileURLToPath(import.meta.url))
const daysDir = path.join(evalDir, 'days')
const repoRoot = path.resolve(evalDir, '..', '..')

// Thresholds for --strict. Deliberately not 100% out of the gate: the eval
// exists to measure the distance; ratchet these up as fixes land, never down.
const THRESHOLDS = {
  primaryWorkRate: Number(process.env.EVAL_MIN_PRIMARY ?? 0.60),
  toolSurfaceCleanRate: Number(process.env.EVAL_MIN_CLEAN ?? 0.90),
  gapHonestyRate: Number(process.env.EVAL_MIN_GAPS ?? 0.80),
  shapeJudgeMean: Number(process.env.EVAL_MIN_SHAPE ?? 6.0),
}

function loadDays(filter: string[]): EvalDay[] {
  const files = fs.readdirSync(daysDir).filter((f) => f.endsWith('.yaml')).sort()
  const days: EvalDay[] = []
  for (const file of files) {
    const parsed = yaml.load(fs.readFileSync(path.join(daysDir, file), 'utf8')) as EvalDay
    if (!parsed?.date || !parsed.summary || !Array.isArray(parsed.primaryWork)) {
      throw new Error(`Malformed eval day file: ${file}`)
    }
    if (filter.length === 0 || filter.includes(parsed.date)) days.push(parsed)
  }
  return days
}

async function observeDay(db: import('better-sqlite3').Database, date: string): Promise<{ observed: ObservedDay; rendering: string }> {
  const { getTimelineDayProjection } = await import('../../src/main/core/query/projections')
  const { userVisibleLabelForBlock } = await import('../../src/main/services/workBlocks')
  const { buildDayWrapFacts } = await import('../../src/renderer/lib/dayWrapScenes')
  const { planDayWrapSlides } = await import('../../src/renderer/lib/wrapDeck')
  const { getTimelineDayPayload } = await import('../../src/main/services/workBlocks')

  const projection = getTimelineDayProjection(db, date, null, { materialize: false, analysis: false })
  const blockLabels = projection.blocks.map((b) => userVisibleLabelForBlock(b))
  const blockNarratives = projection.blocks.map((b) => b.label?.narrative ?? '')

  // Wrapped: what the user saw if a narrative is stored; the deterministic
  // fallback line per slide otherwise. Never generates.
  const payload = getTimelineDayPayload(db, date, null, { materialize: false })
  const facts = buildDayWrapFacts(payload)
  const slides = planDayWrapSlides(facts)
  const storedRow = db.prepare(
    `SELECT narrative_json FROM wrapped_narratives WHERE cadence = 'day' AND period_key = ?`,
  ).get(date) as { narrative_json: string } | undefined
  let wrappedLead: string | null = null
  let wrappedLines: string[] = []
  if (storedRow) {
    try {
      const stored = JSON.parse(storedRow.narrative_json) as { lead?: string; lines?: Record<string, string | null>; reflection?: string | null }
      wrappedLead = stored.lead ?? null
      wrappedLines = slides.map((s) => stored.lines?.[s.id] ?? s.fallbackLine)
      if (stored.reflection) wrappedLines.push(stored.reflection)
    } catch {
      wrappedLines = slides.map((s) => s.fallbackLine)
    }
  } else {
    wrappedLines = slides.map((s) => s.fallbackLine)
  }

  const observed: ObservedDay = {
    blockLabels,
    blockBounds: projection.blocks.map((b) => ({ startMs: b.startTime, endMs: b.endTime })),
    blockNarratives,
    wrappedLead,
    wrappedLines,
    blockCount: projection.blocks.length,
    trackedSeconds: projection.totalSeconds,
  }

  const rendering = projection.blocks.map((b, i) =>
    `${fmtTime(b.startTime)}–${fmtTime(b.endTime)} (${fmtDuration((b.endTime - b.startTime) / 1000)})  ${blockLabels[i]}${blockNarratives[i] ? `\n    ${blockNarratives[i]}` : ''}`,
  ).join('\n')

  return { observed, rendering }
}

function rate(scores: DayScore[], pick: (s: DayScore) => { score: number; max: number }): number {
  const totals = scores.reduce(
    (acc, s) => {
      const d = pick(s)
      return { score: acc.score + d.score, max: acc.max + d.max }
    },
    { score: 0, max: 0 },
  )
  return totals.max === 0 ? 1 : totals.score / totals.max
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const strict = args.includes('--strict')
  const useJudge = args.includes('--judge')
  const fresh = args.includes('--fresh')
  const filter = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a))

  const days = loadDays(filter)
  if (days.length === 0) {
    console.error('No eval day files matched. Author files under tests/journal-eval/days/.')
    process.exit(2)
  }

  const ctx = await openHarness({ fresh })
  console.log(c('dim', `[eval] ${days.length} days · db ${ctx.dbPath}`))

  let judgeKey: string | null = null
  if (useJudge) {
    const { getApiKey } = await import('../../src/main/services/settings')
    judgeKey = process.env.DAYLENS_ANTHROPIC_API_KEY ?? (await getApiKey('anthropic'))
    if (!judgeKey) throw new Error('--judge needs an Anthropic key (keytar or DAYLENS_ANTHROPIC_API_KEY).')
  }

  const results: DayScore[] = []
  for (const day of days) {
    const { observed, rendering } = await observeDay(ctx.db, day.date)
    const score = scoreDay(day, observed)
    if (useJudge && judgeKey) {
      const { judgeDayShape } = await import('./judge')
      try {
        const verdict = await judgeDayShape(judgeKey, day, observed, rendering)
        score.shapeJudge = { score: verdict.score, max: 10, violations: verdict.violations, reasoning: verdict.reasoning }
      } catch (error) {
        score.shapeJudge = { score: 0, max: 10, violations: [`judge error: ${String(error)}`], reasoning: 'judge call failed' }
      }
    }
    results.push(score)

    const pw = score.primaryWork
    const ts = score.toolSurfaces
    const gh = score.gapHonesty
    const sj = score.shapeJudge
    console.log(
      `${c('cyan', day.date)} (${day.confidence})  work ${pw.score}/${pw.max}  clean ${ts.score}/${ts.max}  gaps ${gh.score}/${gh.max}` +
      (sj ? `  shape ${sj.score}/10` : ''),
    )
    for (const v of [...pw.violations, ...ts.violations, ...gh.violations, ...(sj?.violations ?? [])]) {
      console.log(c('yellow', `    ✗ ${v}`))
    }
    if (sj?.reasoning) console.log(c('gray', `    judge: ${sj.reasoning}`))
  }

  const summary = {
    primaryWorkRate: rate(results, (s) => s.primaryWork),
    toolSurfaceCleanRate: rate(results, (s) => s.toolSurfaces),
    gapHonestyRate: rate(results, (s) => s.gapHonesty),
    shapeJudgeMean: useJudge
      ? results.reduce((sum, s) => sum + (s.shapeJudge?.score ?? 0), 0) / results.length
      : null,
  }

  console.log('')
  console.log(c('bold', '── Summary ──────────────────────────────'))
  console.log(`primary work named:   ${(summary.primaryWorkRate * 100).toFixed(0)}%  (threshold ${(THRESHOLDS.primaryWorkRate * 100).toFixed(0)}%)`)
  console.log(`tool-surface clean:   ${(summary.toolSurfaceCleanRate * 100).toFixed(0)}%  (threshold ${(THRESHOLDS.toolSurfaceCleanRate * 100).toFixed(0)}%)`)
  console.log(`gap honesty:          ${(summary.gapHonestyRate * 100).toFixed(0)}%  (threshold ${(THRESHOLDS.gapHonestyRate * 100).toFixed(0)}%)`)
  if (summary.shapeJudgeMean !== null) {
    console.log(`shape judge mean:     ${summary.shapeJudgeMean.toFixed(1)}/10  (threshold ${THRESHOLDS.shapeJudgeMean.toFixed(1)})`)
  }

  const outDir = path.join(repoRoot, '.journal-eval')
  fs.mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = path.join(outDir, `results-${stamp}.json`)
  fs.writeFileSync(outPath, JSON.stringify({ summary, thresholds: THRESHOLDS, results }, null, 2))
  console.log(c('dim', `\nresults: ${outPath}`))

  if (strict) {
    const failures: string[] = []
    if (summary.primaryWorkRate < THRESHOLDS.primaryWorkRate) failures.push('primary-work rate under threshold')
    if (summary.toolSurfaceCleanRate < THRESHOLDS.toolSurfaceCleanRate) failures.push('tool-surface clean rate under threshold')
    if (summary.gapHonestyRate < THRESHOLDS.gapHonestyRate) failures.push('gap-honesty rate under threshold')
    if (summary.shapeJudgeMean !== null && summary.shapeJudgeMean < THRESHOLDS.shapeJudgeMean) failures.push('shape-judge mean under threshold')
    if (failures.length > 0) {
      console.error(c('red', `\nSTRICT FAIL: ${failures.join(' · ')}`))
      process.exitCode = 1
    } else {
      console.log(c('green', '\nSTRICT PASS'))
    }
  }
}

main()
  .then(async () => {
    try {
      const { getDb } = await import('../../src/main/services/database')
      getDb()?.close()
    } catch { /* not opened */ }
    setTimeout(() => process.exit(process.exitCode ?? 0), 25)
  })
  .catch((error) => {
    console.error(String(error?.stack ?? error))
    process.exit(1)
  })
