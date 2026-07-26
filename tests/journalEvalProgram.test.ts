// Hermetic guard over the journal-anchored day eval program. The eval itself
// is local-only (real-DB snapshot + private ground truth); CI cannot run it.
// What CI CAN protect: the day files stay well-formed, and the deterministic
// scorers keep their semantics.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { scoreGapHonesty, scorePrimaryWork, scoreToolSurfaces, type ObservedDay } from './journal-eval/score'
import type { EvalDay } from './journal-eval/schema'

const daysDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'journal-eval', 'days')

function loadAll(): Array<{ file: string; day: EvalDay }> {
  return fs.readdirSync(daysDir)
    .filter((f) => f.endsWith('.yaml'))
    .map((file) => ({ file, day: yaml.load(fs.readFileSync(path.join(daysDir, file), 'utf8')) as EvalDay }))
}

test('every eval day file is well-formed and self-consistent', () => {
  const all = loadAll()
  assert.ok(all.length >= 15, `need at least 15 ground-truth days, have ${all.length}`)
  const months = new Set<string>()
  for (const { file, day } of all) {
    assert.match(day.date, /^\d{4}-\d{2}-\d{2}$/, `${file}: bad date`)
    assert.ok(file.startsWith(day.date), `${file}: filename must match date`)
    assert.ok(['journal', 'machine'].includes(day.confidence), `${file}: bad confidence`)
    assert.ok(day.summary.trim().length >= 80, `${file}: summary too thin to judge against`)
    assert.ok(day.primaryWork.length >= 1, `${file}: no primary work`)
    for (const work of day.primaryWork) {
      assert.ok(work.aliases.length >= 1, `${file}: ${work.name} has no aliases`)
      for (const alias of work.aliases) {
        assert.equal(alias, alias.toLowerCase(), `${file}: alias "${alias}" must be lowercase`)
        assert.ok(alias.length >= 2, `${file}: alias "${alias}" too short — would false-positive`)
      }
    }
    for (const gap of day.gaps ?? []) {
      assert.match(gap.from, /^\d{2}:\d{2}$/, `${file}: bad gap.from`)
      assert.match(gap.to, /^\d{2}:\d{2}$/, `${file}: bad gap.to`)
    }
    months.add(day.date.slice(0, 7))
  }
  assert.ok(months.size >= 4, `days must spread across months (overfitting guard), have ${[...months].join(', ')}`)
})

const baseDay: EvalDay = {
  date: '2026-01-15',
  confidence: 'journal',
  sources: ['test'],
  summary: 'A test day.',
  primaryWork: [{ name: 'Daylens', aliases: ['daylens'] }],
}

function observed(partial: Partial<ObservedDay>): ObservedDay {
  return {
    blockLabels: [],
    blockBounds: [],
    blockNarratives: [],
    wrappedLead: null,
    wrappedLines: [],
    blockCount: 0,
    trackedSeconds: 0,
    ...partial,
  }
}

test('primary work counts a hit anywhere the user can see it', () => {
  const hitInNarrative = scorePrimaryWork(baseDay, observed({
    blockLabels: ['Focused work'],
    blockNarratives: ['You drove the daylens agents all morning.'],
  }))
  assert.equal(hitInNarrative.score, 1)
  const miss = scorePrimaryWork(baseDay, observed({ blockLabels: ['Focused work'] }))
  assert.equal(miss.score, 0)
  assert.equal(miss.violations.length, 1)
})

test('tool-surface labels are violations; banned terms hit labels and wrap lines', () => {
  const result = scoreToolSurfaces(
    { ...baseDay, bannedAsWork: ['cursor agents'] },
    observed({
      blockLabels: ['Working on Cursor Agents', 'Writing the launch post', 'ChatGPT'],
      wrappedLines: ['The morning went to Cursor Agents.'],
    }),
  )
  const labelViolations = result.violations.filter((v) => v.startsWith('block label'))
  assert.equal(labelViolations.length, 2, JSON.stringify(result.violations))
  assert.ok(result.violations.some((v) => v.startsWith('wrapped line')))
  assert.equal(result.score, 1)
})

test('gap honesty: same-day early-morning gaps and cross-midnight gaps both parse', () => {
  const dayStart = new Date('2026-01-15T00:00:00').getTime()
  const hour = 3_600_000
  // Block 13:00–18:00 must NOT violate a 01:30–12:00 morning gap.
  const morningGap = scoreGapHonesty(
    { ...baseDay, gaps: [{ from: '01:30', to: '12:00' }] },
    observed({ blockLabels: ['x'], blockBounds: [{ startMs: dayStart + 13 * hour, endMs: dayStart + 18 * hour }] }),
  )
  assert.equal(morningGap.score, 1, JSON.stringify(morningGap.violations))
  // Block 00:30–13:00 spans it → violation.
  const spanning = scoreGapHonesty(
    { ...baseDay, gaps: [{ from: '01:30', to: '12:00' }] },
    observed({ blockLabels: ['x'], blockBounds: [{ startMs: dayStart + 0.5 * hour, endMs: dayStart + 13 * hour }] }),
  )
  assert.equal(spanning.score, 0)
  // Cross-midnight gap 22:00–01:30: a block 21:00–02:30 (next day) spans it.
  const crossing = scoreGapHonesty(
    { ...baseDay, gaps: [{ from: '22:00', to: '01:30' }] },
    observed({ blockLabels: ['x'], blockBounds: [{ startMs: dayStart + 21 * hour, endMs: dayStart + 26.5 * hour }] }),
  )
  assert.equal(crossing.score, 0)
})
