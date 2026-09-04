// DEV-487 reproduction: the morning/evening notifier's Timeline + Wrapped data
// paths, run against a read-only copy of the real profile. Prints the failing
// frame when the main process overflows its stack.
//
//   npm run repro:dev487 -- [YYYY-MM-DD]
import { stageReadOnlyCopyOfRealDb, cleanupRealDbCopy } from '../tests/ai-behaviour/realDb'

function fail(label: string, error: unknown): void {
  const err = error as Error
  console.error(`\n### ${label} THREW: ${err?.name}: ${err?.message}`)
  const frames = (err?.stack ?? '').split('\n').slice(1)
  const uniq: string[] = []
  const seen = new Map<string, number>()
  for (const f of frames) {
    const key = f.trim().replace(/:\d+:\d+\)?$/, '')
    seen.set(key, (seen.get(key) ?? 0) + 1)
    if ((seen.get(key) ?? 0) <= 2) uniq.push(f)
  }
  console.error(uniq.slice(0, 25).join('\n'))
  const repeats = [...seen.entries()].filter(([, n]) => n > 2).sort((a, b) => b[1] - a[1])
  if (repeats.length > 0) {
    console.error('\n--- repeated frames (recursion signature) ---')
    for (const [frame, n] of repeats.slice(0, 6)) console.error(`  x${n}  ${frame}`)
  }
}

async function main(): Promise<void> {
  const ctx = await stageReadOnlyCopyOfRealDb()
  try {
    const { initDb, getDb } = await import('../src/main/services/database')
    initDb()
    const db = getDb()

    const dates: string[] = process.argv[2]
      ? [process.argv[2]]
      : (db.prepare(`
          SELECT date(start_time/1000,'unixepoch','localtime') AS d, COUNT(*) c
          FROM app_sessions GROUP BY d ORDER BY c DESC LIMIT 5
        `).all() as { d: string; c: number }[]).map((r) => r.d)

    console.log('candidate days (heaviest first):', dates.join(', '))

    const { getTimelineDayPayload } = await import('../src/main/services/workBlocks')
    for (const date of dates) {
      const n = (db.prepare(`
        SELECT COUNT(*) c FROM app_sessions
        WHERE date(start_time/1000,'unixepoch','localtime') = ?
      `).get(date) as { c: number }).c
      process.stdout.write(`\n[${date}] app_sessions=${n}  getTimelineDayPayload... `)
      let payload: unknown = null
      try {
        payload = getTimelineDayPayload(db, date, null)
        console.log('ok')
      } catch (error) {
        fail(`getTimelineDayPayload(${date})`, error)
        continue
      }

      process.stdout.write(`[${date}] getWrappedNarrative... `)
      try {
        const { getWrappedNarrative } = await import('../src/main/services/wrappedNarrative')
        await getWrappedNarrative(payload as never, { triggerSource: 'system', onStale: 'reuse' } as never)
        console.log('ok')
      } catch (error) {
        fail(`getWrappedNarrative(${date})`, error)
      }
    }
    // The weekly brief path (Monday morning window) — sums a whole period.
    const { buildWrappedPeriodFacts, getWrappedPeriodWrap } = await import('../src/main/services/wrappedPeriodNarrative')
    const anchors = (db.prepare(`
      SELECT DISTINCT date(start_time/1000,'unixepoch','localtime') AS d
      FROM app_sessions ORDER BY d DESC LIMIT 3
    `).all() as { d: string }[]).map((r) => r.d)
    for (const period of ['week', 'month', 'year'] as const) {
      for (const anchor of anchors.slice(0, 1)) {
        process.stdout.write(`\n[${period} @ ${anchor}] buildWrappedPeriodFacts... `)
        let facts: unknown = null
        try {
          facts = buildWrappedPeriodFacts(period, anchor)
          console.log('ok')
        } catch (error) {
          fail(`buildWrappedPeriodFacts(${period}, ${anchor})`, error)
          continue
        }
        process.stdout.write(`[${period} @ ${anchor}] getWrappedPeriodWrap... `)
        try {
          await getWrappedPeriodWrap(period, anchor, { triggerSource: 'system', onStale: 'reuse' } as never)
          console.log('ok')
        } catch (error) {
          fail(`getWrappedPeriodWrap(${period}, ${anchor})`, error)
        }
      }
    }
  } finally {
    await cleanupRealDbCopy(ctx)
  }
}

void main()
