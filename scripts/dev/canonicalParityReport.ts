// Live parity report: rebuild foreground sessions from canonical
// foreground_poll evidence and compare them to the legacy app_sessions rows in
// the same database. Run against a real capture profile:
//
//   ELECTRON_RUN_AS_NODE=1 npx electron --loader ./tests/support/ts-loader.mjs \
//     scripts/dev/canonicalParityReport.ts <path-to-daylens.sqlite>
//
// Tolerance (documented): legacy drops sessions under its 10s floor and splits
// at local midnight; canonical keeps brief switches and single intervals.

import Database from 'better-sqlite3'
import { rebuildPollForegroundSessions } from '../../src/main/services/captureEvidence.ts'

const MIN_SESSION_SEC = 10
const dbPath = process.argv[2]
if (!dbPath) {
  console.error('usage: canonicalParityReport.ts <daylens.sqlite>')
  process.exit(1)
}

const db = new Database(dbPath, { readonly: true })
const legacy = db.prepare(`
  SELECT app_name AS appName, start_time AS startMs, end_time AS endMs
  FROM app_sessions ORDER BY start_time ASC
`).all() as Array<{ appName: string; startMs: number; endMs: number }>

const rebuilt = rebuildPollForegroundSessions(db, 0, Date.now() + 86_400_000)
  .filter((s) => (s.endMs - s.startMs) / 1_000 >= MIN_SESSION_SEC)

console.log('legacy sessions:', legacy.length, ' canonical rebuilt (>=10s):', rebuilt.length)
const rows = Math.max(legacy.length, rebuilt.length)
let mismatches = 0
for (let i = 0; i < rows; i++) {
  const l = legacy[i]
  const r = rebuilt[i]
  const match = l && r && l.appName === r.appName && l.startMs === r.startMs && l.endMs === r.endMs
  if (!match) mismatches++
  console.log(
    match ? 'MATCH   ' : 'MISMATCH',
    'legacy:', l ? `${l.appName} ${l.startMs}..${l.endMs} (${Math.round((l.endMs - l.startMs) / 1000)}s)` : '—',
    '| canonical:', r ? `${r.appName} ${r.startMs}..${r.endMs} (${Math.round((r.endMs - r.startMs) / 1000)}s)` : '—',
  )
}
let overlaps = 0
for (let i = 1; i < rebuilt.length; i++) {
  if (rebuilt[i].startMs < rebuilt[i - 1].endMs) overlaps++
}
console.log(`parity: ${rows - mismatches}/${rows} exact, overlaps: ${overlaps}`)
db.close()
process.exit(mismatches === 0 && overlaps === 0 ? 0 : 2)
