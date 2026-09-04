// Times the three surfaces a person waits on, against a read-only copy of the
// real profile: Timeline day load, Apps list, and AI chat context assembly.
//
//   npm run bench:surfaces
import { stageReadOnlyCopyOfRealDb, cleanupRealDbCopy } from '../tests/ai-behaviour/realDb'

const ms = () => Number(process.hrtime.bigint() / 1_000_000n)

async function time<T>(label: string, fn: () => T | Promise<T>): Promise<T | null> {
  const t0 = ms()
  try {
    const out = await fn()
    const dt = ms() - t0
    const bar = '█'.repeat(Math.min(60, Math.round(dt / 50)))
    console.log(`  ${label.padEnd(46)} ${String(dt).padStart(6)} ms ${bar}`)
    return out
  } catch (error) {
    console.log(`  ${label.padEnd(46)} ${'FAILED'.padStart(6)}    ${(error as Error).message.slice(0, 60)}`)
    return null
  }
}

async function main(): Promise<void> {
  const ctx = await stageReadOnlyCopyOfRealDb()
  try {
    const { initDb, getDb } = await import('../src/main/services/database')
    initDb()
    const db = getDb()

    const days = (db.prepare(`
      SELECT date(start_time/1000,'unixepoch','localtime') AS d, COUNT(*) c
      FROM app_sessions GROUP BY d ORDER BY c DESC LIMIT 3
    `).all() as { d: string; c: number }[])

    const { getTimelineDayPayload } = await import('../src/main/services/workBlocks')
    console.log('\nTIMELINE — the day view a person opens first')
    for (const { d, c } of days) {
      await time(`getTimelineDayPayload ${d} (${c} sessions)`, () => getTimelineDayPayload(db, d, null))
    }

    console.log('\nAPPS — the list and its per-app detail')
    const q = await import('../src/main/db/queries')
    const day = days[0].d
    for (const name of ['getAppUsageForRange', 'getAllAppsForLabeling', 'getAppSessionsForRange'] as const) {
      const fn = (q as Record<string, unknown>)[name]
      if (typeof fn !== 'function') { console.log(`  ${name.padEnd(46)}   (not exported)`); continue }
      const from = new Date(`${day}T00:00:00`).getTime()
      const to = from + 86_400_000
      await time(`${name} (one day)`, () => (fn as (...a: unknown[]) => unknown)(db, from, to))
      await time(`${name} (one year)`, () => (fn as (...a: unknown[]) => unknown)(db, to - 365 * 86_400_000, to))
    }

    console.log('\nAI CHAT — what the model waits on before it can answer')
    try {
      const cp = await import('../src/main/services/contextPacket')
      const build = (cp as Record<string, unknown>).buildContextPacket
        ?? (cp as Record<string, unknown>).assembleContextPacket
      if (typeof build === 'function') {
        await time('context packet assembly', () => (build as (...a: unknown[]) => unknown)(db, { date: day }))
      } else {
        console.log('  context packet: export name not found —', Object.keys(cp).filter((k) => /build|assemble|packet/i.test(k)).join(', '))
      }
    } catch (error) {
      console.log('  context packet: import failed —', (error as Error).message.slice(0, 80))
    }
    console.log('')
  } finally {
    await cleanupRealDbCopy(ctx)
  }
}

void main()
