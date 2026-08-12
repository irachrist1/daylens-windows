#!/usr/bin/env node
// Hermetic verification for the user-facing failures tracked in
// docs/V2-SHIP-PRIORITIES.md.
//
// Runs the offline test files that lock the behaviors already fixed on main,
// then prints a status table for every ship-priority item — including those
// that still need an owner regrade on a real day (no private data here).
//
// Usage:
//   npm run verify:ship-priorities
//   node scripts/verify-ship-priorities.mjs

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runTests = path.join(projectRoot, 'scripts', 'run-tests.mjs')

/** @typedef {'verified' | 'partial' | 'open'} PriorityStatus */

/**
 * @type {Array<{
 *   id: string,
 *   surface: string,
 *   summary: string,
 *   status: PriorityStatus,
 *   note: string,
 *   tests?: string[],
 * }>}
 */
const ITEMS = [
  {
    id: 'DEV-232',
    surface: 'Timeline',
    summary: 'Continuous work stays one block; same-label fragments repair',
    status: 'verified',
    note: 'Hermetic: workBlockSplitting, timelineSegmentation, sameLabelFragmentMerge',
    tests: ['workBlockSplitting', 'timelineSegmentation', 'sameLabelFragmentMerge'],
  },
  {
    id: 'DEV-233',
    surface: 'Timeline',
    summary: 'A merge the person asks for always applies (including across absence)',
    status: 'verified',
    note: 'Hermetic: correctionCommands, timelineAbsenceRepair, workBlockSplitting',
    tests: ['correctionCommands', 'timelineAbsenceRepair', 'workBlockSplitting'],
  },
  {
    id: 'DEV-234',
    surface: 'Timeline',
    summary: 'Overlapping blocks/events lay in columns; filters do not collide text',
    status: 'partial',
    note: 'Overlap columns hermetic (timelineBlockLayout). Filter bare-bar has no dedicated test — regrade on Mac.',
    tests: ['timelineBlockLayout'],
  },
  {
    id: 'DEV-230',
    surface: 'Timeline',
    summary: 'Attended / correction toast auto-dismisses',
    status: 'partial',
    note: 'Code path present (CorrectionFlow ~6s). No hermetic UI test — regrade on Mac.',
  },
  {
    id: 'DEV-231',
    surface: 'Timeline',
    summary: 'Re-analyze reports what it actually did',
    status: 'verified',
    note: 'Hermetic: timelineAutoAnalyze returns mergedCount / relabeled outcomes',
    tests: ['timelineAutoAnalyze'],
  },
  {
    id: 'DEV-247-recap',
    surface: 'Recaps',
    summary: 'Recap and wrap stay grounded; no raw dates as activities',
    status: 'partial',
    note: 'Hermetic grounding/honesty green. Wrap still may emit a tall multi-slide PNG by design — owner visual regrade.',
    tests: ['recapVoice', 'dayClarifications', 'wrapNarrativeGrounding', 'wrapHonesty', 'wrapExport'],
  },
  {
    id: 'brutal-day',
    surface: 'Cross-surface',
    summary: 'Adversarial synthetic day through real seams (capture → AI)',
    status: 'verified',
    note: 'Hermetic: brutalDay (16 checks)',
    tests: ['brutalDay'],
  },
  {
    id: 'DEV-237',
    surface: 'Apps',
    summary: '"What you did there" accurate prose on every app',
    status: 'open',
    note: 'No closing hermetic suite for JSON/empty Safari/junk prose. Needs owner Apps regrade + fixture.',
  },
  {
    id: 'DEV-246',
    surface: 'AI',
    summary: 'First numeric answer is correct without pushback',
    status: 'open',
    note: 'aiTimelineParity proves tool↔Timeline same number; does not prove first-answer quality. Needs owner chat regrade.',
    tests: ['aiTimelineParity'],
  },
  {
    id: 'DEV-242',
    surface: 'AI',
    summary: 'Provider/model state identical in Settings and chat picker',
    status: 'open',
    note: 'providerRouting covers job routing only. CLI "not installed" contradiction still possible — regrade on Mac.',
    tests: ['providerRouting', 'aiModelSources'],
  },
  {
    id: 'DEV-244',
    surface: 'AI',
    summary: 'Tool activity is a calm one-line summary, not a chip wall',
    status: 'partial',
    note: 'activityTrail collapse hermetic. Full "Worked for…" greeting-skip packet not locked on main.',
    tests: ['activityTrail'],
  },
  {
    id: 'DEV-243',
    surface: 'AI',
    summary: 'AI tab never sticks on blank "Loading AI…"',
    status: 'partial',
    note: 'Load-error + Retry path exists; no dedicated stuck-loading hermetic. Regrade on Mac.',
  },
  {
    id: 'real-day',
    surface: 'Cross-surface',
    summary: 'Private real-day Timeline / Apps / AI agree',
    status: 'open',
    note: 'Owner-only: npm run verify:real-day against ~/.daylens-real-day. Ticket still open.',
  },
]

function runHermetic(filters) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runTests, ...filters], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => resolve({ code: code ?? 1, out }))
  })
}

const filters = [...new Set(ITEMS.flatMap((item) => item.tests ?? []))]
console.log(`Ship-priority hermetic battery (${filters.length} filters)\n`)

const { code, out } = await runHermetic(filters)
process.stdout.write(out)
if (!out.endsWith('\n')) process.stdout.write('\n')

const hermeticOk = code === 0
const mark = {
  verified: hermeticOk ? 'VERIFIED' : 'BROKEN',
  partial: hermeticOk ? 'PARTIAL' : 'BROKEN',
  open: 'OPEN',
}

console.log(`${'─'.repeat(72)}`)
console.log('Ship-priority status (docs/V2-SHIP-PRIORITIES.md)\n')
for (const item of ITEMS) {
  const status = item.status === 'verified' || item.status === 'partial'
    ? mark[item.status]
    : mark.open
  // OPEN items that also ran optional supporting tests still report OPEN.
  const label = item.status === 'open' ? 'OPEN' : status
  console.log(`${label.padEnd(9)} ${item.id.padEnd(16)} ${item.surface.padEnd(12)} ${item.summary}`)
  console.log(`${''.padEnd(9)} ${item.note}`)
}

console.log(`\n${'─'.repeat(72)}`)
if (!hermeticOk) {
  console.log('Hermetic battery failed — fix regressions before treating Timeline as shipped.')
  process.exit(1)
}

const openCount = ITEMS.filter((i) => i.status === 'open').length
const partialCount = ITEMS.filter((i) => i.status === 'partial').length
console.log(
  `Hermetic battery green. ${openCount} item(s) still OPEN and ${partialCount} PARTIAL — ` +
    'close them with an owner regrade (docs/testing/v2-manual.md + npm run verify:real-day), not by editing this script.',
)
process.exit(0)
