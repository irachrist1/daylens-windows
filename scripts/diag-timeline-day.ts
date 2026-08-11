// Rebuilds one day's timeline from a read-only copy of the real DB and prints
// each block with the page evidence behind it. Nothing is written back
// (materialize: false, and the DB is a temp copy), so this is safe to run
// against a live install.
//
//   npm run diag:timeline -- 2026-08-10
import { stageReadOnlyCopyOfRealDb, cleanupRealDbCopy } from '../tests/ai-behaviour/realDb'

const DATE = process.argv[2] ?? new Date().toISOString().slice(0, 10)

function hms(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`
  return `${s}s`
}

function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function main(): Promise<void> {
  const ctx = await stageReadOnlyCopyOfRealDb()
  try {
    const { initDb, getDb } = await import('../src/main/services/database')
    initDb()
    const db = getDb()
    const { getTimelineDayPayload } = await import('../src/main/services/workBlocks')

    const payload = getTimelineDayPayload(db, DATE, null, { materialize: false, forceRebuild: true })
    console.log(`\n=== timeline ${DATE} — ${payload.blocks.length} blocks (rebuilt, not persisted) ===\n`)

    for (const block of payload.blocks) {
      const seconds = Math.round((block.endTime - block.startTime) / 1000)
      const label = block.label as unknown as Record<string, unknown>
      const source = String(label.source ?? '?')
      console.log(`${clock(block.startTime)}–${clock(block.endTime)}  ${hms(seconds).padEnd(7)}  [${source.padEnd(8)}] ${block.label.current}`)
      const alt = ['ai', 'rule', 'artifact', 'previous'].filter((k) => label[k])
      if (alt.length > 0) {
        console.log(`        candidates: ${alt.map((k) => `${k}=${JSON.stringify(label[k])}`).join('  ')}`)
      }
      const sites = block.evidenceSummary?.sites ?? []
      if (sites.length === 0) {
        console.log(`        (no site evidence)`)
      } else {
        for (const site of sites.slice(0, 6)) {
          const secs = (site as { totalSeconds?: number }).totalSeconds
          const title = (site as { pageTitle?: string | null }).pageTitle ?? ''
          const domain = (site as { domain?: string }).domain ?? ''
          console.log(`        ${String(domain).slice(0, 28).padEnd(29)}${(secs == null ? '' : hms(secs)).padStart(8)}  ${title.slice(0, 52)}`)
        }
      }
      console.log()
    }
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
