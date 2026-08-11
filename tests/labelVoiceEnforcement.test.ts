import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import type { AppCategory } from '../src/shared/types.ts'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { writeAIBlockLabel } from '../src/main/db/queries.ts'
import { rawLabelForm } from '../src/shared/labelVoice.ts'
import { materializeTimelineDayProjection } from '../src/main/core/query/projections.ts'

// DEV-276: a raw window title, a filename, a ticket description, or a JSON
// string is never a label. The label chooser enforces the voice invariants on
// every candidate (and verbatim-title rejection on interpreted ones), so the
// July 22 shapes — "handoff.md", "[Week 1]", a whole pasted ticket, a JSON
// blob stored as an "ai" label — can never surface as a block's name.

const TEST_DATE = '2026-04-22'

function localMs(hour: number, minute = 0): number {
  return new Date(2026, 3, 22, hour, minute, 0, 0).getTime()
}

function insertSession(
  db: Database.Database,
  title: string,
  startHour: number,
  durationMinutes: number,
  category: AppCategory,
  app: { bundleId: string; name: string },
): void {
  const startTime = localMs(startHour)
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, capture_source, capture_version
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'test', 1)
  `).run(app.bundleId, app.name, startTime, startTime + durationMinutes * 60_000, durationMinutes * 60, category, title, app.name)
}

test('a filename window title never becomes the block label', () => {
  const db = createProductionTestDatabase()
  insertSession(db, 'handoff.md', 9, 90, 'development', { bundleId: 'com.exafunction.windsurf', name: 'Windsurf' })

  const blocks = materializeTimelineDayProjection(db, TEST_DATE, null).blocks.filter((block) => !block.isLive)
  assert.ok(blocks.length >= 1)
  for (const block of blocks) {
    assert.notEqual(block.label.current, 'handoff.md', 'the filename window title is evidence, never the label')
    assert.equal(rawLabelForm(block.label.current), null,
      `label "${block.label.current}" carries a raw machine form`)
  }
  db.close()
})

test('garbage persisted as an "ai" label is re-gated on read and never surfaces', () => {
  const db = createProductionTestDatabase()
  insertSession(db, 'DEV-270 Block detail panel summary', 9, 90, 'development', { bundleId: 'com.todesktop.230313mzl4w4u92', name: 'Cursor' })
  const analyzed = materializeTimelineDayProjection(db, TEST_DATE, null).blocks.filter((block) => !block.isLive)
  assert.ok(analyzed.length >= 1)

  // The July 22 shapes, written straight into the ai-label store.
  const ticketDescription = 'DEV-270 Block detail panel summary is not a collect and accurate representation of where the user actually spent time on each block and the recap is confidently wrong about the day'
  writeAIBlockLabel(db, { blockId: analyzed[0].id, label: ticketDescription })

  const reread = materializeTimelineDayProjection(db, TEST_DATE, null).blocks.filter((block) => !block.isLive)
  for (const block of reread) {
    assert.notEqual(block.label.current, ticketDescription, 'a pasted ticket description never surfaces as a label')
    assert.ok(block.label.current.length <= 90, `label stays bounded; got ${block.label.current.length} chars`)
  }
  db.close()
})

test('a JSON string persisted as an "ai" label never surfaces', () => {
  const db = createProductionTestDatabase()
  insertSession(db, 'Claude Code session', 9, 90, 'development', { bundleId: 'com.mitchellh.ghostty', name: 'Ghostty' })
  const analyzed = materializeTimelineDayProjection(db, TEST_DATE, null).blocks.filter((block) => !block.isLive)
  assert.ok(analyzed.length >= 1)

  const jsonLabel = 'Wants to run AskUserQuestion: {"questions":[{"header":"Scope"}]}'
  writeAIBlockLabel(db, { blockId: analyzed[0].id, label: jsonLabel })

  const reread = materializeTimelineDayProjection(db, TEST_DATE, null).blocks.filter((block) => !block.isLive)
  for (const block of reread) {
    assert.notEqual(block.label.current, jsonLabel)
    assert.equal(rawLabelForm(block.label.current), null,
      `label "${block.label.current}" carries a raw machine form`)
  }
  db.close()
})

test('a verbatim captured window title never becomes an interpreted label', () => {
  const db = createProductionTestDatabase()
  // "Cursor Agents" is the literal window title; the AI store echoes it.
  insertSession(db, 'Cursor Agents', 9, 90, 'development', { bundleId: 'com.todesktop.230313mzl4w4u92', name: 'Cursor' })
  const analyzed = materializeTimelineDayProjection(db, TEST_DATE, null).blocks.filter((block) => !block.isLive)
  assert.ok(analyzed.length >= 1)
  writeAIBlockLabel(db, { blockId: analyzed[0].id, label: 'Cursor Agents' })

  const reread = materializeTimelineDayProjection(db, TEST_DATE, null).blocks.filter((block) => !block.isLive)
  for (const block of reread) {
    assert.notEqual(block.label.current, 'Cursor Agents',
      'a captured window title is evidence inside the block, never its verbatim label')
  }
  db.close()
})
