// DEV-87 live boundary proof — runs the REAL resolver/AI path and the REAL
// executeTool (MCP) path against the REAL captured database, with an exclusion
// configured. Not a unit test: it drives the same code the app runs, on real
// pre-existing data, and prints what would reach the model / an MCP client.
//
// Run: ELECTRON_RUN_AS_NODE=1 electron --loader ./tests/support/ts-loader.mjs \
//        ./tests/support/verify-dev87.ts <dbPath> <date>
import Database from 'better-sqlite3'
import { runResolverQueries, serializeFact } from '../../src/main/ai/resolvers'
import { executeTool } from '../../src/main/services/aiTools'
import type { TrackingControlsState } from '../../src/shared/trackingControls'

const dbPath = process.argv[2]
const date = process.argv[3] ?? '2026-06-21'
if (!dbPath) {
  console.error('usage: verify-dev87.ts <dbPath> [date]')
  process.exit(2)
}
const EXCLUDED_APP = 'dia'           // by canonical app id (real top app that day)
const EXCLUDED_SITE = 'youtube.com'  // real top domain that day

const db = new Database(dbPath, { readonly: true })

const OFF: TrackingControlsState = {
  consented: true, enabled: false, paused: false, excludedApps: [], excludedSites: [], skipIncognito: true,
}
const ON: TrackingControlsState = {
  consented: true, enabled: true, paused: false,
  excludedApps: [EXCLUDED_APP], excludedSites: [EXCLUDED_SITE], skipIncognito: true,
}

// A word-bounded search: "dia" must hit the app "Dia" but never "diagram"/"media".
function mentions(haystack: string, token: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^a-z0-9])`, 'i').test(haystack)
}

function aiFactsText(controls: TrackingControlsState): string {
  const facts = runResolverQueries([{ resolver: 'getDay', date }], db, controls)
  return facts.map(serializeFact).join('\n\n')
}

function line(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} ${detail}`)
}

console.log(`\n=== DEV-87 boundary proof — db=${dbPath.split('/').pop()} date=${date} ===`)
console.log(`Excluding app="${EXCLUDED_APP}" (canonical) and site="${EXCLUDED_SITE}"\n`)

let allPass = true
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) allPass = false
  line(label, ok, detail)
}

// ── AI tab boundary (resolver → serialized facts → model) ─────────────────────
const aiOff = aiFactsText(OFF)
const aiOn = aiFactsText(ON)

check('AI: excluded app present WITHOUT exclusion', mentions(aiOff, 'dia'),
  `("dia" in baseline facts: ${mentions(aiOff, 'dia')})`)
check('AI: excluded app ABSENT WITH exclusion', !mentions(aiOn, 'dia'),
  `("dia" in filtered facts: ${mentions(aiOn, 'dia')})`)
check('AI: excluded site present WITHOUT exclusion', aiOff.toLowerCase().includes('youtube'),
  `("youtube" in baseline facts: ${aiOff.toLowerCase().includes('youtube')})`)
check('AI: excluded site ABSENT WITH exclusion', !aiOn.toLowerCase().includes('youtube'),
  `("youtube" in filtered facts: ${aiOn.toLowerCase().includes('youtube')})`)
// Bounded-matching: kept apps survive; nothing benign got corrupted.
check('AI: kept apps survive the filter', ['zen', 'excel', 'codex'].some((a) => mentions(aiOn, a)),
  `(other real apps still present)`)

// ── MCP boundary (executeTool — the exact path the MCP server calls) ──────────
function mcpJson(controls: TrackingControlsState): string {
  return JSON.stringify(executeTool('getDaySummary', { date }, db, controls)).toLowerCase()
}
const mcpOff = mcpJson(OFF)
const mcpOn = mcpJson(ON)

check('MCP: excluded app present WITHOUT exclusion', mentions(mcpOff, 'dia'),
  `("dia" in baseline output: ${mentions(mcpOff, 'dia')})`)
check('MCP: excluded app ABSENT WITH exclusion', !mentions(mcpOn, 'dia'),
  `("dia" in filtered output: ${mentions(mcpOn, 'dia')})`)
check('MCP: excluded site present WITHOUT exclusion', mcpOff.includes('youtube'),
  `("youtube" in baseline output: ${mcpOff.includes('youtube')})`)
check('MCP: excluded site ABSENT WITH exclusion', !mcpOn.includes('youtube'),
  `("youtube" in filtered output: ${mcpOn.includes('youtube')})`)

// ── System noise is stripped even with controls OFF ───────────────────────────
check('AI: system noise (finder/loginwindow) never present',
  !mentions(aiOff, 'loginwindow') && !mentions(aiOff, 'windowserver'),
  '(invisible OS identities excluded at the boundary)')

db.close()
console.log(`\n${allPass ? 'ALL BOUNDARY CHECKS PASS' : 'SOME CHECKS FAILED'}\n`)
process.exit(allPass ? 0 : 1)
