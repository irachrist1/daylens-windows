// Diagnostic for INDEX.md A2: the Apps view domain breakdown reports far less
// time than the day summary does for the same domains on the same day.
//
// Runs all three read paths against a read-only copy of the real DB and prints
// them side by side:
//   1. getCorrectedWebsiteSummariesForRange — domain intervals (day summary, AI)
//   2. getBrowserActivityBreakdown          — per-page claim pool (Apps view)
//   3. getCorrectedPageFactsForRange        — the coverage shortfall report
//
//   npm run diag:domains -- 2026-08-10 Dia
import { stageReadOnlyCopyOfRealDb, cleanupRealDbCopy } from '../tests/ai-behaviour/realDb'

const DATE = process.argv[2] ?? new Date().toISOString().slice(0, 10)
const APP_QUERY = (process.argv[3] ?? 'Dia').toLowerCase()

function dayBounds(date: string): { from: number; to: number } {
  const [y, m, d] = date.split('-').map(Number)
  return {
    from: new Date(y, m - 1, d, 0, 0, 0, 0).getTime(),
    to: new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime(),
  }
}

function hms(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`
  return `${s}s`
}

async function main(): Promise<void> {
  const ctx = await stageReadOnlyCopyOfRealDb()
  try {
    const { initDb, getDb } = await import('../src/main/services/database')
    initDb()
    const db = getDb()
    const { from, to } = dayBounds(DATE)

    const facts = await import('../src/main/services/activityFacts')
    const queries = await import('../src/main/db/queries')

    // Which evidence table actually holds this range? reconcileWebsiteVisits
    // falls back to getSessionsForRange (app_sessions only) when no sessions
    // are passed — dead weight if this install writes focus_events instead.
    const count = (sql: string): number => {
      try { return (db.prepare(sql).get() as { n: number }).n } catch { return -1 }
    }
    console.log(`\n=== evidence tables, ${DATE} ===`)
    console.log(`  app_sessions rows in range : ${count(`SELECT COUNT(*) n FROM app_sessions WHERE start_time >= ${from} AND start_time < ${to}`)}`)
    console.log(`  app_sessions rows total    : ${count('SELECT COUNT(*) n FROM app_sessions')}`)
    console.log(`  focus_events rows in range : ${count(`SELECT COUNT(*) n FROM focus_events WHERE start_time >= ${from} AND start_time < ${to}`)}`)
    console.log(`  focus_events rows total    : ${count('SELECT COUNT(*) n FROM focus_events')}`)
    console.log(`  evidenceSource             : ${facts.getCorrectedSessionFactsForRange(db, from, to).evidenceSource}`)

    const apps = facts.getCorrectedAppSummariesForRange(db, from, to)
    const app = apps.find((a) => a.appName.toLowerCase().includes(APP_QUERY))
      ?? apps.find((a) => (a.canonicalAppId ?? a.bundleId).toLowerCase().includes(APP_QUERY))
    if (!app) {
      console.log(`No app matching "${APP_QUERY}" on ${DATE}. Apps present:`)
      for (const a of apps) console.log(`  ${a.appName}  ${hms(a.totalSeconds)}`)
      return
    }
    const canonicalId = app.canonicalAppId ?? app.bundleId

    console.log(`\n=== ${app.appName} — ${DATE} ===`)
    console.log(`app header total (getCorrectedAppSummariesForRange): ${hms(app.totalSeconds)}  [${canonicalId}]`)

    // ---- Path 1: domain intervals ----
    const summaries = facts.getCorrectedWebsiteSummariesForRange(db, from, to)
      .filter((s) => (s.canonicalBrowserId ?? s.browserBundleId) === canonicalId)
    const path1Total = summaries.reduce((sum, s) => sum + s.totalSeconds, 0)

    // ---- Path 2: per-page claim pool (what the Apps view renders) ----
    const sessions = facts.getCorrectedSessionsForRange(db, from, to)
    const breakdown = queries.getBrowserActivityBreakdown(db, from, to, canonicalId, { sessions })
    const path2ByDomain = new Map(breakdown.domains.map((d) => [d.domain, d.totalSeconds]))
    const path2Total = breakdown.attributedSeconds

    // ---- Path 3: coverage report ----
    const pageFacts = facts.getCorrectedPageFactsForRange(db, from, to)
    const coverage = pageFacts.coverage.find((c) => c.canonicalBrowserId === canonicalId)

    console.log(`\n  path 1  domain intervals   : ${hms(path1Total)}  (${summaries.length} domains)`)
    console.log(`  path 2  Apps view breakdown: ${hms(path2Total)}  (${breakdown.domains.length} domains)`)
    if (coverage) {
      console.log(`  path 3  coverage report    : in front ${hms(coverage.foregroundSeconds)}, pages cover ${hms(coverage.pageCoveredSeconds)}`)
      console.log(`          material shortfall : ${facts.hasMaterialPageCoverageShortfall(coverage)}`)
    }

    // ---- Path 2a: same reconcile, WITHOUT the Apps view's second foreground
    // clip. Isolates whether that clip is what loses the time.
    const reconciled = queries.getReconciledWebsiteVisitsForRange(db, from, to, sessions)
    const path2aByDomain = new Map<string, { start: number; end: number }[]>()
    for (const { visit, freeIntervals } of reconciled) {
      if ((visit.canonicalBrowserId ?? visit.browserBundleId) !== canonicalId) continue
      const list = path2aByDomain.get(visit.domain) ?? []
      for (const i of freeIntervals) list.push(i)
      path2aByDomain.set(visit.domain, list)
    }
    const unionSec = (intervals: { start: number; end: number }[]): number => {
      const sorted = [...intervals].sort((a, b) => a.start - b.start)
      let total = 0
      let cursor = Number.NEGATIVE_INFINITY
      for (const p of sorted) {
        const s = Math.max(p.start, cursor)
        if (p.end > s) total += p.end - s
        cursor = Math.max(cursor, p.end)
      }
      return Math.round(total / 1000)
    }
    const path2aTotal = [...path2aByDomain.values()].reduce((sum, iv) => sum + unionSec(iv), 0)
    console.log(`  path 2a reconcile, no clip : ${hms(path2aTotal)}  (${path2aByDomain.size} domains)`)

    // ---- Path 2b: reconcile the OLD way (no sessions passed), still no clip.
    // If this is large, the old loss was credit landing outside foreground and
    // being clipped away. If it is already small, the reconciler itself gave
    // this browser less credit when it had to guess its own foreground.
    const reconciledOld = queries.getReconciledWebsiteVisitsForRange(db, from, to)
    const path2bByDomain = new Map<string, { start: number; end: number }[]>()
    for (const { visit, freeIntervals } of reconciledOld) {
      if ((visit.canonicalBrowserId ?? visit.browserBundleId) !== canonicalId) continue
      const list = path2bByDomain.get(visit.domain) ?? []
      for (const i of freeIntervals) list.push(i)
      path2bByDomain.set(visit.domain, list)
    }
    const path2bTotal = [...path2bByDomain.values()].reduce((sum, iv) => sum + unionSec(iv), 0)
    console.log(`  path 2b old reconcile, no clip: ${hms(path2bTotal)}  (${path2bByDomain.size} domains)`)

    // Raw vs corrected sessions: the reconciler falls back to getSessionsForRange
    // when no sessions are passed. If raw rows carry a different identity for
    // this browser, its foreground lookup misses and its visits get no window.
    const raw = queries.getSessionsForRange(db, from, to)
    const rawOwn = raw.filter((s) => (s.canonicalAppId ?? s.bundleId) === canonicalId || s.bundleId === canonicalId)
    const rawSec = rawOwn.reduce((n, s) => n + s.durationSeconds, 0)
    const corrOwn = sessions.filter((s) => (s.canonicalAppId ?? s.bundleId) === canonicalId || s.bundleId === canonicalId)
    const corrSec = corrOwn.reduce((n, s) => n + s.durationSeconds, 0)
    console.log(`\n  raw getSessionsForRange       : ${raw.length} sessions total, ${rawOwn.length} for ${app.appName} = ${hms(rawSec)}`)
    console.log(`  corrected getCorrectedSessions: ${sessions.length} sessions total, ${corrOwn.length} for ${app.appName} = ${hms(corrSec)}`)
    const rawIds = new Set(raw.filter((s) => s.appName.toLowerCase().includes(APP_QUERY)).map((s) => `${s.bundleId} / ${s.canonicalAppId ?? 'null'}`))
    console.log(`  raw identity forms for ${app.appName}: ${[...rawIds].join('  |  ') || '(none by name)'}`)

    // Hypothesis: getBrowserActivityBreakdown bounds each foreground window to
    // startTime + durationSeconds, taking the PREFIX of a session whose active
    // seconds are fewer than its wall-clock span. Anything browsed after that
    // prefix is clipped away. Measure the gap.
    const own = sessions.filter((s) => (s.canonicalAppId ?? s.bundleId) === canonicalId)
    let spanMs = 0
    let durMs = 0
    let truncated = 0
    let worstMs = 0
    for (const s of own) {
      const end = s.endTime ?? (s.startTime + s.durationSeconds * 1000)
      const span = end - s.startTime
      const dur = s.durationSeconds * 1000
      spanMs += span
      durMs += dur
      if (span > dur + 1000) { truncated += 1; worstMs = Math.max(worstMs, span - dur) }
    }
    console.log(`\n  sessions for ${app.appName}: ${own.length}`)
    console.log(`    wall-clock span sum : ${hms(spanMs / 1000)}`)
    console.log(`    durationSeconds sum : ${hms(durMs / 1000)}`)
    console.log(`    sessions where span > duration: ${truncated}  (worst single gap ${hms(worstMs / 1000)})`)

    const allDomains = new Set<string>([...summaries.map((s) => s.domain), ...path2ByDomain.keys()])
    const rows = [...allDomains].map((domain) => ({
      domain,
      path1: summaries.filter((s) => s.domain === domain).reduce((sum, s) => sum + s.totalSeconds, 0),
      path2: path2ByDomain.get(domain) ?? 0,
    })).sort((a, b) => Math.max(b.path1, b.path2) - Math.max(a.path1, a.path2))

    console.log(`\n  ${'domain'.padEnd(34)}${'day summary'.padStart(12)}${'apps view'.padStart(12)}${'ratio'.padStart(9)}`)
    console.log(`  ${'-'.repeat(66)}`)
    for (const row of rows.slice(0, 20)) {
      const ratio = row.path2 > 0 ? `${(row.path1 / row.path2).toFixed(1)}x` : (row.path1 > 0 ? 'missing' : '-')
      console.log(`  ${row.domain.slice(0, 33).padEnd(34)}${hms(row.path1).padStart(12)}${hms(row.path2).padStart(12)}${ratio.padStart(9)}`)
    }
    console.log()
  } finally {
    const { closeDb } = await import('../src/main/services/database')
    try { closeDb() } catch { /* already closed */ }
    cleanupRealDbCopy(ctx)
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
