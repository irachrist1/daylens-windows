// Correction commands (timeline spec, Corrections; DEV-172): every
// non-destructive correction previews its exact cross-surface effect without
// persisting, applies atomically, and can be undone — and the corrected facts
// reach Timeline, Apps, and search immediately and survive a rebuild.
import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import type { AppCategory, CorrectionCommand } from '../src/shared/types.ts'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { EDITABLE_BLOCK_CATEGORY_OPTIONS } from '../src/shared/activityCategories.ts'
import {
  applyCorrection,
  previewCorrection,
  undoCorrection,
} from '../src/main/services/correctionCommands.ts'
import { getTimelineDayPayload } from '../src/main/services/workBlocks.ts'
import {
  getCorrectedAppSummariesForRange,
  getCorrectedSessionsForRange,
  getCorrectedWebsiteSummariesForRange,
} from '../src/main/services/activityFacts.ts'
import { searchAll, searchBrowser, searchSessions } from '../src/main/db/queries.ts'
import { localDayBounds } from '../src/main/lib/localDate.ts'

const TEST_DATE = '2026-04-22'

function localMs(hour: number, minute = 0): number {
  return new Date(2026, 3, 22, hour, minute, 0, 0).getTime()
}

function insertSession(
  db: Database.Database,
  payload: {
    bundleId?: string
    appName?: string
    title: string
    startMinute: number
    durationMinutes: number
    category?: AppCategory
  },
): void {
  const startTime = localMs(9, payload.startMinute)
  const endTime = startTime + payload.durationMinutes * 60_000
  const bundleId = payload.bundleId ?? 'com.google.Chrome'
  const appName = payload.appName ?? 'Google Chrome'
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, capture_source, capture_version
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'test', 1)
  `).run(
    bundleId, appName, startTime, endTime, payload.durationMinutes * 60,
    payload.category ?? 'browsing', payload.title, appName,
  )
}

function insertVisit(
  db: Database.Database,
  payload: { domain: string; pageTitle: string; startMinute: number; durationSeconds: number },
): void {
  const startTime = localMs(9, payload.startMinute)
  db.prepare(`
    INSERT INTO website_visits (
      browser_bundle_id, canonical_browser_id, visit_time, visit_time_us,
      duration_sec, url, normalized_url, domain, page_title
    ) VALUES ('com.google.Chrome', 'com.google.Chrome', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    startTime, startTime * 1000, payload.durationSeconds,
    `https://${payload.domain}/`, `https://${payload.domain}/`,
    payload.domain, payload.pageTitle,
  )
}

function seedTwoTopicDay(db: Database.Database): void {
  insertSession(db, { title: 'Camera comparison research - DPReview - Google Chrome', startMinute: 0, durationMinutes: 25 })
  insertSession(db, { title: 'City council election results - Local News - Google Chrome', startMinute: 25, durationMinutes: 25 })
}

function correctionLedgerCounts(db: Database.Database): { reviews: number; boundary: number; exclusions: number; undoLog: number } {
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
  return {
    reviews: count('timeline_block_reviews'),
    boundary: count('timeline_boundary_corrections'),
    exclusions: count('evidence_exclusions'),
    undoLog: count('correction_undo_log'),
  }
}

test('preview reports the rename delta without persisting anything', () => {
  const db = createProductionTestDatabase()
  seedTwoTopicDay(db)
  const payload = getTimelineDayPayload(db, TEST_DATE)
  const target = payload.blocks[0]
  const before = correctionLedgerCounts(db)

  const preview = previewCorrection(db, {
    kind: 'edit', date: TEST_DATE, blockId: target.id, label: 'Acme camera research',
  }, null)

  assert.match(preview.description, /Rename/)
  assert.equal(preview.blocks[0].labelAfter, 'Acme camera research')
  assert.equal(preview.totalSecondsBefore, preview.totalSecondsAfter)
  assert.ok(preview.surfaces.some((note) => note.includes('Acme camera research')))

  // Nothing persisted: the ledger row counts and the rendered label are unchanged.
  const after = getTimelineDayPayload(db, TEST_DATE)
  assert.equal(after.blocks[0].label.current, target.label.current)
  assert.deepEqual(correctionLedgerCounts(db), before)
  db.close()
})

test('a rename applies atomically, reaches search immediately, and undo restores it', () => {
  const db = createProductionTestDatabase()
  seedTwoTopicDay(db)
  const target = getTimelineDayPayload(db, TEST_DATE).blocks[0]

  const { correctionId } = applyCorrection(db, {
    kind: 'edit', date: TEST_DATE, blockId: target.id, label: 'Acme camera research',
  }, null)

  const renamed = getTimelineDayPayload(db, TEST_DATE)
  assert.ok(renamed.blocks.some((block) => block.label.current === 'Acme camera research'))
  const hits = searchAll(db, 'Acme camera', { startDate: TEST_DATE, endDate: TEST_DATE })
  assert.ok(hits.length > 0, 'the corrected label is searchable with no rebuild')

  const undo = undoCorrection(db, correctionId)
  assert.equal(undo.undone, true)
  const restored = getTimelineDayPayload(db, TEST_DATE)
  assert.ok(!restored.blocks.some((block) => block.label.current === 'Acme camera research'))
  assert.equal(restored.blocks[0].label.current, target.label.current)
  db.close()
})

test('a category correction reaches Timeline and Apps and undo restores both', () => {
  const db = createProductionTestDatabase()
  seedTwoTopicDay(db)
  const [dayFromMs, dayToMs] = localDayBounds(TEST_DATE)
  const target = getTimelineDayPayload(db, TEST_DATE).blocks[0]
  assert.notEqual(target.dominantCategory, 'research')

  const { correctionId } = applyCorrection(db, {
    kind: 'edit', date: TEST_DATE, blockId: target.id, category: 'research',
  }, null)

  const corrected = getTimelineDayPayload(db, TEST_DATE)
  const correctedBlock = corrected.blocks.find((block) =>
    block.startTime <= target.startTime && block.endTime >= target.endTime)
  assert.equal(correctedBlock?.dominantCategory, 'research')
  const apps = getCorrectedAppSummariesForRange(db, dayFromMs, dayToMs)
  assert.ok(apps.some((app) => app.category === 'research'), 'Apps reads the corrected category')

  undoCorrection(db, correctionId)
  const restored = getTimelineDayPayload(db, TEST_DATE)
  assert.equal(restored.blocks[0].dominantCategory, target.dominantCategory)
  db.close()
})

test('correction descriptions speak the human category vocabulary, never raw enums', () => {
  // DEV-271: "change its category to aiTools" is machine talk. Every category
  // a person can pick must be described with its human label ("AI Tools"),
  // and the raw enum token must never leak into the description or notes.
  const db = createProductionTestDatabase()
  seedTwoTopicDay(db)
  const target = getTimelineDayPayload(db, TEST_DATE).blocks[0]
  for (const { value, label } of EDITABLE_BLOCK_CATEGORY_OPTIONS) {
    if (value === target.dominantCategory) continue
    const preview = previewCorrection(db, {
      kind: 'edit', date: TEST_DATE, blockId: target.id, category: value,
    }, null)
    assert.ok(
      preview.description.includes(`to ${label}`),
      `description must use "${label}", got: ${preview.description}`,
    )
    assert.ok(
      !preview.description.includes(`to ${value}`),
      `raw enum "${value}" leaked into: ${preview.description}`,
    )
    assert.ok(
      preview.surfaces.some((note) => note.includes(`as ${label}.`)),
      `surface note must use "${label}", got: ${preview.surfaces.join(' | ')}`,
    )
    assert.ok(
      !preview.surfaces.some((note) => note.includes(`as ${value}.`)),
      `raw enum "${value}" leaked into a surface note: ${preview.surfaces.join(' | ')}`,
    )
  }
  db.close()
})

test('merge previews the block-count change, applies, survives a rebuild, and undoes', () => {
  const db = createProductionTestDatabase()
  seedTwoTopicDay(db)
  const before = getTimelineDayPayload(db, TEST_DATE).blocks
  assert.equal(before.length, 2)

  const command: CorrectionCommand = {
    kind: 'merge', date: TEST_DATE, blockIds: [before[0].id, before[1].id],
  }
  const preview = previewCorrection(db, command, null)
  assert.equal(preview.blockCountBefore, 2)
  assert.equal(preview.blockCountAfter, 1)
  assert.equal(getTimelineDayPayload(db, TEST_DATE).blocks.length, 2, 'preview persisted nothing')
  // DEV-271: the note says what the person gets, in their words.
  assert.ok(
    preview.surfaces.some((note) => note.includes('one block') && note.includes('come back')),
    'the merge note must promise one block that is kept when they leave and return',
  )
  assert.ok(
    !preview.surfaces.some((note) => /re-analysis|survives/.test(note)),
    'system internals must not leak into the merge note',
  )

  const { correctionId } = applyCorrection(db, command, null)
  assert.equal(getTimelineDayPayload(db, TEST_DATE).blocks.length, 1)

  // The merge survives a forced rebuild (correction durability).
  db.prepare(`UPDATE timeline_blocks SET heuristic_version = 'timeline-v3'`).run()
  assert.equal(getTimelineDayPayload(db, TEST_DATE).blocks.length, 1)

  undoCorrection(db, correctionId)
  assert.equal(getTimelineDayPayload(db, TEST_DATE).blocks.length, 2)
  db.close()
})

test('split at a chosen time cuts the block in two and undo rejoins it', () => {
  const db = createProductionTestDatabase()
  insertSession(db, { title: 'Camera comparison research - DPReview - Google Chrome', startMinute: 0, durationMinutes: 50 })
  const before = getTimelineDayPayload(db, TEST_DATE).blocks
  assert.equal(before.length, 1)

  const cutMs = localMs(9, 25)
  const command: CorrectionCommand = {
    kind: 'split', date: TEST_DATE, blockId: before[0].id, cutMs,
  }
  const preview = previewCorrection(db, command, null)
  assert.equal(preview.blockCountAfter, 2)
  assert.equal(getTimelineDayPayload(db, TEST_DATE).blocks.length, 1, 'preview persisted nothing')

  const { correctionId } = applyCorrection(db, command, null)
  const split = getTimelineDayPayload(db, TEST_DATE).blocks
  assert.equal(split.length, 2)
  assert.equal(split[0].endTime, cutMs)
  assert.equal(split[1].startTime, cutMs)

  undoCorrection(db, correctionId)
  assert.equal(getTimelineDayPayload(db, TEST_DATE).blocks.length, 1)
  db.close()
})

test('excluding a block removes it from Timeline, Apps, and search; undo brings it back', () => {
  const db = createProductionTestDatabase()
  seedTwoTopicDay(db)
  const [dayFromMs, dayToMs] = localDayBounds(TEST_DATE)
  const before = getTimelineDayPayload(db, TEST_DATE)
  const target = before.blocks[1]

  const command: CorrectionCommand = { kind: 'exclude-block', date: TEST_DATE, blockId: target.id }
  const preview = previewCorrection(db, command, null)
  assert.ok(preview.totalSecondsAfter < preview.totalSecondsBefore)
  assert.equal(preview.blocks[0].labelAfter, null, 'the excluded block is gone in the preview')

  const { correctionId } = applyCorrection(db, command, null)
  const excluded = getTimelineDayPayload(db, TEST_DATE)
  assert.ok(excluded.totalSeconds < before.totalSeconds)
  const appsSeconds = getCorrectedAppSummariesForRange(db, dayFromMs, dayToMs)
    .reduce((sum, app) => sum + app.totalSeconds, 0)
  assert.equal(appsSeconds, Math.round(excluded.totalSeconds), 'Apps and Timeline agree after the exclusion')
  assert.equal(
    searchSessions(db, 'election', { startDate: TEST_DATE, endDate: TEST_DATE }).length,
    0,
    'the excluded stretch is gone from search',
  )

  undoCorrection(db, correctionId)
  const restored = getTimelineDayPayload(db, TEST_DATE)
  assert.equal(Math.round(restored.totalSeconds), Math.round(before.totalSeconds))
  assert.ok(searchSessions(db, 'election', { startDate: TEST_DATE, endDate: TEST_DATE }).length > 0)
  db.close()
})

test('excluding one site hides it from the block, Apps, and search without touching raw rows', () => {
  const db = createProductionTestDatabase()
  insertSession(db, { title: 'Camera comparison research - DPReview - Google Chrome', startMinute: 0, durationMinutes: 50 })
  insertVisit(db, { domain: 'dpreview.com', pageTitle: 'Camera comparison', startMinute: 5, durationSeconds: 600 })
  insertVisit(db, { domain: 'secretsite.example', pageTitle: 'Private reading', startMinute: 20, durationSeconds: 600 })
  const [dayFromMs, dayToMs] = localDayBounds(TEST_DATE)
  const block = getTimelineDayPayload(db, TEST_DATE).blocks[0]

  const command: CorrectionCommand = {
    kind: 'exclude-evidence', date: TEST_DATE, blockId: block.id,
    evidence: { kind: 'site', domain: 'secretsite.example' },
  }
  const { correctionId } = applyCorrection(db, command, null)

  const blockAfter = getTimelineDayPayload(db, TEST_DATE).blocks[0]
  assert.ok(!blockAfter.websites.some((site) => site.domain === 'secretsite.example'))
  assert.ok(!getCorrectedWebsiteSummariesForRange(db, dayFromMs, dayToMs)
    .some((site) => site.domain === 'secretsite.example'))
  assert.equal(searchBrowser(db, 'Private reading', { startDate: TEST_DATE, endDate: TEST_DATE }).length, 0)
  const rawRows = (db.prepare(`SELECT COUNT(*) AS c FROM website_visits WHERE domain = 'secretsite.example'`).get() as { c: number }).c
  assert.equal(rawRows, 1, 'raw capture is untouched — the exclusion is reversible')

  undoCorrection(db, correctionId)
  assert.ok(getCorrectedWebsiteSummariesForRange(db, dayFromMs, dayToMs)
    .some((site) => site.domain === 'secretsite.example'))
  assert.ok(searchBrowser(db, 'Private reading', { startDate: TEST_DATE, endDate: TEST_DATE }).length > 0)
  db.close()
})

test('excluding one app removes its minutes from the day and undo restores them', () => {
  const db = createProductionTestDatabase()
  insertSession(db, { title: 'Camera comparison research - DPReview - Google Chrome', startMinute: 0, durationMinutes: 25 })
  insertSession(db, {
    bundleId: 'com.spotify.client', appName: 'Spotify', title: 'Lo-fi beats',
    startMinute: 5, durationMinutes: 10, category: 'entertainment',
  })
  const [dayFromMs, dayToMs] = localDayBounds(TEST_DATE)
  const block = getTimelineDayPayload(db, TEST_DATE).blocks[0]
  const appsBefore = getCorrectedAppSummariesForRange(db, dayFromMs, dayToMs)
  assert.ok(appsBefore.some((app) => app.appName === 'Spotify'))

  const { correctionId } = applyCorrection(db, {
    kind: 'exclude-evidence', date: TEST_DATE, blockId: block.id,
    evidence: { kind: 'app', bundleId: 'com.spotify.client', appName: 'Spotify' },
  }, null)

  const appsAfter = getCorrectedAppSummariesForRange(db, dayFromMs, dayToMs)
  assert.ok(!appsAfter.some((app) => app.appName === 'Spotify'))

  undoCorrection(db, correctionId)
  assert.ok(getCorrectedAppSummariesForRange(db, dayFromMs, dayToMs)
    .some((app) => app.appName === 'Spotify'))
  db.close()
})

test('assigning a client updates work sessions atomically and undo restores the prior owner', () => {
  const db = createProductionTestDatabase()
  seedTwoTopicDay(db)
  const block = getTimelineDayPayload(db, TEST_DATE).blocks[0]
  const now = Date.now()
  db.prepare(`
    INSERT INTO clients (id, name, created_at, updated_at) VALUES ('client_acme', 'Acme', ?, ?)
  `).run(now, now)
  db.prepare(`
    INSERT INTO work_sessions (
      id, device_id, started_at, ended_at, duration_ms, active_ms, idle_ms,
      client_id, project_id, attribution_status, app_bundle_ids_json, created_at, updated_at
    ) VALUES ('ws_1', 'device', ?, ?, ?, ?, 0, NULL, NULL, 'unattributed', '[]', ?, ?)
  `).run(block.startTime, block.endTime, block.endTime - block.startTime, block.endTime - block.startTime, now, now)

  const command: CorrectionCommand = {
    kind: 'assign-client', date: TEST_DATE, blockId: block.id, clientId: 'client_acme',
  }
  const preview = previewCorrection(db, command, null)
  assert.ok(preview.surfaces.some((note) => note.includes('Acme')))
  const unassigned = db.prepare(`SELECT client_id FROM work_sessions WHERE id = 'ws_1'`).get() as { client_id: string | null }
  assert.equal(unassigned.client_id, null, 'preview persisted nothing')

  const { correctionId } = applyCorrection(db, command, null)
  const assigned = db.prepare(`SELECT client_id, attribution_status FROM work_sessions WHERE id = 'ws_1'`).get() as { client_id: string | null; attribution_status: string }
  assert.equal(assigned.client_id, 'client_acme')
  assert.equal(assigned.attribution_status, 'attributed')

  undoCorrection(db, correctionId)
  const restored = db.prepare(`SELECT client_id, attribution_status FROM work_sessions WHERE id = 'ws_1'`).get() as { client_id: string | null; attribution_status: string }
  assert.equal(restored.client_id, null)
  assert.equal(restored.attribution_status, 'unattributed')
  db.close()
})

test('assigning a project updates work sessions and undo restores the prior owner', () => {
  const db = createProductionTestDatabase()
  seedTwoTopicDay(db)
  const block = getTimelineDayPayload(db, TEST_DATE).blocks[0]
  const now = Date.now()
  db.prepare(`
    INSERT INTO clients (id, name, created_at, updated_at) VALUES ('client_acme', 'Acme', ?, ?)
  `).run(now, now)
  db.prepare(`
    INSERT INTO projects (id, client_id, name, status, created_at, updated_at)
    VALUES ('proj_launch', 'client_acme', 'Launch', 'active', ?, ?)
  `).run(now, now)
  db.prepare(`
    INSERT INTO work_sessions (
      id, device_id, started_at, ended_at, duration_ms, active_ms, idle_ms,
      client_id, project_id, attribution_status, app_bundle_ids_json, created_at, updated_at
    ) VALUES ('ws_1', 'device', ?, ?, ?, ?, 0, NULL, NULL, 'unattributed', '[]', ?, ?)
  `).run(block.startTime, block.endTime, block.endTime - block.startTime, block.endTime - block.startTime, now, now)

  const command: CorrectionCommand = {
    kind: 'assign-client',
    date: TEST_DATE,
    blockId: block.id,
    clientId: 'client_acme',
    projectId: 'proj_launch',
  }
  const preview = previewCorrection(db, command, null)
  assert.match(preview.description, /Acme · Launch/)
  assert.ok(preview.surfaces.some((note) => note.includes('Launch')))

  const { correctionId, description } = applyCorrection(db, command, null)
  assert.match(description, /Acme · Launch/)
  const assigned = db.prepare(`
    SELECT client_id, project_id, attribution_status FROM work_sessions WHERE id = 'ws_1'
  `).get() as { client_id: string | null; project_id: string | null; attribution_status: string }
  assert.equal(assigned.client_id, 'client_acme')
  assert.equal(assigned.project_id, 'proj_launch')
  assert.equal(assigned.attribution_status, 'attributed')

  undoCorrection(db, correctionId)
  const restored = db.prepare(`
    SELECT client_id, project_id, attribution_status FROM work_sessions WHERE id = 'ws_1'
  `).get() as { client_id: string | null; project_id: string | null; attribution_status: string }
  assert.equal(restored.client_id, null)
  assert.equal(restored.project_id, null)
  assert.equal(restored.attribution_status, 'unattributed')
  db.close()
})

test('assigning a client with no overlapping work sessions throws and leaves the undo ledger untouched', () => {
  const db = createProductionTestDatabase()
  seedTwoTopicDay(db)
  const block = getTimelineDayPayload(db, TEST_DATE).blocks[0]
  const now = Date.now()
  db.prepare(`
    INSERT INTO clients (id, name, created_at, updated_at) VALUES ('client_acme', 'Acme', ?, ?)
  `).run(now, now)
  const before = correctionLedgerCounts(db)

  const command: CorrectionCommand = {
    kind: 'assign-client', date: TEST_DATE, blockId: block.id, clientId: 'client_acme',
  }
  assert.throws(
    () => previewCorrection(db, command, null),
    /Nothing to attribute in this block yet/,
  )
  assert.throws(
    () => applyCorrection(db, command, null),
    /Nothing to attribute in this block yet/,
  )
  assert.deepEqual(correctionLedgerCounts(db), before, 'undo ledger untouched')
  db.close()
})

test('a user merge across a real absence applies, names the gap in its preview, and undoes cleanly', () => {
  const db = createProductionTestDatabase()
  // 25 minutes of real absence between the blocks. DEV-233 (decided): the
  // merge the person asks for succeeds anyway — the preview names the gap so
  // they fuse knowingly, and undo restores the split.
  insertSession(db, { title: 'Camera comparison research - DPReview - Google Chrome', startMinute: 0, durationMinutes: 20 })
  insertSession(db, { title: 'City council election results - Local News - Google Chrome', startMinute: 45, durationMinutes: 20 })
  const blocks = getTimelineDayPayload(db, TEST_DATE).blocks
  assert.equal(blocks.length, 2)

  const preview = previewCorrection(db, {
    kind: 'merge', date: TEST_DATE, blockIds: [blocks[0].id, blocks[1].id],
  }, null)
  assert.match(preview.description, /time away/i, 'the preview must name the gap being bridged')

  const applied = applyCorrection(db, {
    kind: 'merge', date: TEST_DATE, blockIds: [blocks[0].id, blocks[1].id],
  }, null)
  assert.equal(getTimelineDayPayload(db, TEST_DATE).blocks.length, 1, 'the merge fuses across the gap')

  undoCorrection(db, applied.correctionId)
  assert.equal(getTimelineDayPayload(db, TEST_DATE).blocks.length, 2, 'undo restores the split day')
  db.close()
})

test('only the newest correction of a day can be undone', () => {
  const db = createProductionTestDatabase()
  seedTwoTopicDay(db)
  const blocks = getTimelineDayPayload(db, TEST_DATE).blocks
  const first = applyCorrection(db, {
    kind: 'edit', date: TEST_DATE, blockId: blocks[0].id, label: 'First rename',
  }, null)
  applyCorrection(db, {
    kind: 'edit', date: TEST_DATE, blockId: blocks[1].id, label: 'Second rename',
  }, null)

  assert.throws(() => undoCorrection(db, first.correctionId), /newer correction/i)
  db.close()
})

test('corrections survive restart and reprojection', () => {
  const db = createProductionTestDatabase()
  seedTwoTopicDay(db)
  const target = getTimelineDayPayload(db, TEST_DATE).blocks[0]
  // A rename is anchored to the block's evidence set: with unchanged facts,
  // reprojection re-forms the same block and the rename must hold.
  applyCorrection(db, {
    kind: 'edit', date: TEST_DATE, blockId: target.id, label: 'Durable rename',
  }, null)
  db.prepare(`UPDATE timeline_blocks SET invalidated_at = ?`).run(Date.now())
  const rebuilt = getTimelineDayPayload(db, TEST_DATE)
  const renamed = rebuilt.blocks.find((candidate) => candidate.label.current === 'Durable rename')
  assert.ok(renamed, 'the rename survives reprojection')

  // A category correction is anchored to the block's wall-clock span, so it
  // survives even when the corrected facts re-segment the day.
  applyCorrection(db, {
    kind: 'edit', date: TEST_DATE, blockId: renamed!.id, category: 'research',
  }, null)
  db.prepare(`UPDATE timeline_blocks SET invalidated_at = ?`).run(Date.now())
  const sessionsInSpan = getCorrectedSessionsForRange(db, renamed!.startTime, renamed!.endTime)
  assert.ok(sessionsInSpan.length > 0)
  assert.ok(
    sessionsInSpan.every((session) => session.category === 'research'),
    'the category correction survives reprojection in the corrected session facts',
  )
  db.close()
})
