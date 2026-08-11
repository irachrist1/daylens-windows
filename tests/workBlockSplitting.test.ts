import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import type { AppCategory, AppSession } from '../src/shared/types.ts'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { upsertWorkContextInsight } from '../src/main/db/queries.ts'
import { buildTimelineBlocksFromSessions, getBlockDetailPayload, getTimelineDayPayload, mergeTimelineEpisodes, trimTimelineBlockSpan, writeTimelineBlockReview } from '../src/main/services/workBlocks.ts'
import { getTimelineDayProjection, materializeTimelineDayProjection } from '../src/main/core/query/projections.ts'


const TEST_DATE = '2026-04-22'

function localMs(hour: number, minute = 0): number {
  return new Date(2026, 3, 22, hour, minute, 0, 0).getTime()
}

function localMsForDate(dateStr: string, hour: number, minute = 0): number {
  const [year, month, day] = dateStr.split('-').map(Number)
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

function dateStringForOffset(offsetDays: number): string {
  const target = new Date()
  target.setDate(target.getDate() + offsetDays)
  const year = target.getFullYear()
  const month = String(target.getMonth() + 1).padStart(2, '0')
  const day = String(target.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function createDb(): Database.Database {
  return createProductionTestDatabase()
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
    dateStr?: string
  },
): void {
  const startTime = payload.dateStr
    ? localMsForDate(payload.dateStr, 9, payload.startMinute)
    : localMs(9, payload.startMinute)
  const endTime = startTime + payload.durationMinutes * 60_000
  const bundleId = payload.bundleId ?? 'com.google.Chrome'
  const appName = payload.appName ?? 'Google Chrome'
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id,
      app_name,
      start_time,
      end_time,
      duration_sec,
      category,
      is_focused,
      window_title,
      raw_app_name,
      capture_source,
      capture_version
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'test', 1)
  `).run(
    bundleId,
    appName,
    startTime,
    endTime,
    payload.durationMinutes * 60,
    payload.category ?? 'browsing',
    payload.title,
    appName,
  )
}

function insertWebsiteVisit(
  db: Database.Database,
  payload: {
    domain: string
    pageTitle: string
    url: string
    startMinute: number
    durationSeconds: number
    browserBundleId?: string
  },
): void {
  const startTime = localMs(9, payload.startMinute)
  db.prepare(`
    INSERT INTO website_visits (
      browser_bundle_id,
      canonical_browser_id,
      visit_time,
      visit_time_us,
      duration_sec,
      url,
      normalized_url,
      domain,
      page_title
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    payload.browserBundleId ?? 'com.google.Chrome',
    payload.browserBundleId ?? 'com.google.Chrome',
    startTime,
    startTime * 1000,
    payload.durationSeconds,
    payload.url,
    payload.url,
    payload.domain,
    payload.pageTitle,
  )
}

function insertActivityEvent(db: Database.Database, eventType: string, ts: number, metadata: Record<string, unknown> = {}): void {
  db.prepare(`
    INSERT INTO activity_state_events (event_ts, event_type, source, metadata_json)
    VALUES (?, ?, 'test', ?)
  `).run(ts, eventType, JSON.stringify(metadata))
}

function insertCanonicalFocusDay(db: Database.Database): void {
  const startTime = localMs(9, 0)
  const endTime = startTime + 40 * 60_000
  const insert = db.prepare(`
    INSERT INTO focus_events (
      ts_ms, mono_ns, event_type, app_bundle_id, app_name, pid,
      window_title, url, page_title, source, confidence, platform, schema_ver
    ) VALUES (?, ?, ?, ?, ?, 4242, ?, NULL, NULL, 'foreground_poll', 'observed', 'darwin', 2)
  `)
  insert.run(startTime, startTime * 1_000_000, 'app_activated', 'com.todesktop.cursor', 'Cursor', 'router.ts - daylens - Cursor')
  insert.run(endTime, endTime * 1_000_000, 'app_deactivated', 'com.todesktop.cursor', 'Cursor', 'router.ts - daylens - Cursor')
}

function insertFocusEvent(
  db: Database.Database,
  tsMs: number,
  eventType: string,
  app: { bundleId: string | null; appName: string | null; title?: string | null },
): void {
  db.prepare(`
    INSERT INTO focus_events (
      ts_ms, mono_ns, event_type, app_bundle_id, app_name, pid,
      window_title, url, page_title, source, confidence, platform, schema_ver
    ) VALUES (?, ?, ?, ?, ?, 4242, ?, NULL, NULL, 'nsworkspace_event', 'observed', 'darwin', 2)
  `).run(tsMs, tsMs * 1_000_000, eventType, app.bundleId, app.appName, app.title ?? null)
}

function labelsFor(db: Database.Database): string[] {
  return getTimelineDayPayload(db, TEST_DATE).blocks.map((block) => block.label.current)
}

test('sustained browser topic changes split into separately named blocks', () => {
  const db = createDb()
  insertSession(db, { title: 'Camera comparison research - Google Search - Google Chrome', startMinute: 0, durationMinutes: 12 })
  insertSession(db, { title: 'Camera comparison research - DPReview - Google Chrome', startMinute: 12, durationMinutes: 10 })
  insertSession(db, { title: 'City council election results - Local News - Google Chrome', startMinute: 22, durationMinutes: 12 })
  insertSession(db, { title: 'City council election results - Analysis - Google Chrome', startMinute: 34, durationMinutes: 10 })

  const labels = labelsFor(db)

  assert.ok(labels.length >= 2, `expected sustained topic shift to split; got ${JSON.stringify(labels)}`)
  assert.notEqual(labels[0], labels[1])
  assert.ok(labels.every((label) => label !== 'Google Chrome'), `labels should not fall back to browser name: ${JSON.stringify(labels)}`)
  db.close()
})

test('brief context changes under two minutes stay inside the surrounding block', () => {
  const db = createDb()
  insertSession(db, { title: 'insightsQueryRouter.ts - daylens - Cursor', bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startMinute: 0, durationMinutes: 12 })
  insertSession(db, { title: 'Inbox - Gmail - Google Chrome', startMinute: 12, durationMinutes: 1, category: 'email' })
  insertSession(db, { title: 'insightsQueryRouter.ts - daylens - Cursor', bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startMinute: 13, durationMinutes: 12 })

  const payload = getTimelineDayPayload(db, TEST_DATE)

  assert.equal(payload.blocks.length, 1)
  assert.match(payload.blocks[0].label.current, /insightsQueryRouter\.ts|daylens/i)
  db.close()
})

test('a sub-five-minute terminal sliver is absorbed into the adjacent coding block', () => {
  const db = createDb()
  insertSession(db, { title: 'aiService.ts - daylens - Cursor', bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startMinute: 0, durationMinutes: 30 })
  insertSession(db, { title: 'npm run typecheck - daylens - zsh', bundleId: 'com.warp.dev', appName: 'Warp', category: 'development', startMinute: 30, durationMinutes: 1 })
  insertSession(db, { title: 'aiService.ts - daylens - Cursor', bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startMinute: 31, durationMinutes: 30 })

  const blocks = getTimelineDayPayload(db, TEST_DATE).blocks

  assert.equal(blocks.length, 1, `the 1-minute terminal sliver should fold in; got ${blocks.length} blocks`)
  assert.ok(blocks[0].endTime - blocks[0].startTime >= 60 * 60_000, 'merged block should span the full hour')
  db.close()
})

test('adjacent same-category development fragments coalesce into one block', () => {
  const db = createDb()
  // Two contiguous coding stretches on the same project, interleaving Cursor
  // and the terminal — one continuous work session, not two blocks.
  insertSession(db, { title: 'router.ts - daylens - Cursor', bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startMinute: 0, durationMinutes: 25 })
  insertSession(db, { title: 'npm test - daylens - zsh', bundleId: 'com.warp.dev', appName: 'Warp', category: 'development', startMinute: 25, durationMinutes: 20 })
  insertSession(db, { title: 'router.ts - daylens - Cursor', bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startMinute: 45, durationMinutes: 25 })
  insertSession(db, { title: 'npm test - daylens - zsh', bundleId: 'com.warp.dev', appName: 'Warp', category: 'development', startMinute: 70, durationMinutes: 20 })

  const blocks = getTimelineDayPayload(db, TEST_DATE).blocks

  assert.equal(blocks.length, 1, `same-work dev fragments should merge; got ${blocks.map((b) => b.label.current).join(' | ')}`)
  db.close()
})

test('a sub-30-minute fragment folds into the related neighbour it continues', () => {
  const db = createDb()
  // Excel, a short detour, back to the same Excel workbook. The short middle
  // run is the same spreadsheet work continued; it should not stand alone.
  insertSession(db, { title: 'Q2 forecast.xlsx - Excel', bundleId: 'com.microsoft.Excel', appName: 'Microsoft Excel', category: 'productivity', startMinute: 0, durationMinutes: 35 })
  insertSession(db, { title: 'Q2 forecast.xlsx - Excel', bundleId: 'com.microsoft.Excel', appName: 'Microsoft Excel', category: 'productivity', startMinute: 35, durationMinutes: 20 })

  const blocks = getTimelineDayPayload(db, TEST_DATE).blocks

  assert.equal(blocks.length, 1, `same-app spreadsheet work should read as one block; got ${blocks.map((b) => b.label.current).join(' | ')}`)
  db.close()
})

test('a 15+ minute untracked gap is a hard boundary even for the same app', () => {
  const db = createDb()
  // The 15-minute session break: a real activity gap of 15+ minutes ends the
  // block, even when the same app resumes afterward — the gap is blank space,
  // never absorbed. Both stretches sit above the 15-min calendar floor, so
  // this isolates the gap boundary from the floor.
  insertSession(db, { title: 'npm run dev - daylens - Ghostty', bundleId: 'com.mitchellh.ghostty', appName: 'Ghostty', category: 'development', startMinute: 0, durationMinutes: 16 })
  insertSession(db, { title: 'widgets.tsx - daylens - Ghostty', bundleId: 'com.mitchellh.ghostty', appName: 'Ghostty', category: 'development', startMinute: 36, durationMinutes: 63 })

  const blocks = getTimelineDayPayload(db, TEST_DATE).blocks

  assert.equal(blocks.length, 2, `same-app work across a 20m gap must split; got ${blocks.map((b) => b.label.current).join(' | ')}`)
  db.close()
})

test('same-app work bridges a brief lull below the 15-minute session break', () => {
  const db = createDb()
  // A brief lull inside a working session stays INSIDE one continuous block —
  // the active time stays honest. A real 15+ minute absence ends the block.
  insertSession(db, { title: 'npm run dev - daylens - Ghostty', bundleId: 'com.mitchellh.ghostty', appName: 'Ghostty', category: 'development', startMinute: 0, durationMinutes: 20 })
  insertSession(db, { title: 'widgets.tsx - daylens - Ghostty', bundleId: 'com.mitchellh.ghostty', appName: 'Ghostty', category: 'development', startMinute: 30, durationMinutes: 40 })

  const blocks = getTimelineDayPayload(db, TEST_DATE).blocks

  assert.equal(blocks.length, 1, `same-app work across a 10m lull stays one block; got ${blocks.map((b) => b.label.current).join(' | ')}`)
  db.close()
})

test('sparse AI/dev tool spans do not cross a 15+ minute idle boundary', () => {
  const db = createDb()
  const sessions: AppSession[] = [
    {
      id: 1,
      bundleId: 'com.todesktop.cursor',
      appName: 'Cursor',
      startTime: localMs(9, 0),
      endTime: localMs(9, 40),
      durationSeconds: 40 * 60,
      category: 'development',
      isFocused: true,
      windowTitle: 'workBlocks.ts - daylens - Cursor',
      rawAppName: 'Cursor',
    },
    {
      id: 2,
      bundleId: 'com.google.antigravity',
      appName: 'Antigravity',
      startTime: localMs(10, 30),
      endTime: localMs(11, 11),
      durationSeconds: 27,
      category: 'uncategorized',
      isFocused: false,
      windowTitle: 'Daylens agent run - Antigravity',
      rawAppName: 'Antigravity',
    },
  ]

  const blocks = buildTimelineBlocksFromSessions(db, sessions)

  assert.equal(blocks.length, 2, `a 50m untracked gap must split even sparse AI/dev evidence; got ${blocks.map((b) => b.label.current).join(' | ')}`)
  assert.equal(blocks[0].dominantCategory, 'development')
  db.close()
})

test('same-app work does not bridge across a 45+ minute locked break', () => {
  const db = createDb()
  insertSession(db, { title: 'npm run dev - daylens - Ghostty', bundleId: 'com.mitchellh.ghostty', appName: 'Ghostty', category: 'development', startMinute: 0, durationMinutes: 20 })
  insertActivityEvent(db, 'lock', localMs(9, 25))
  insertActivityEvent(db, 'unlock', localMs(10, 15))
  insertSession(db, { title: 'widgets.tsx - daylens - Ghostty', bundleId: 'com.mitchellh.ghostty', appName: 'Ghostty', category: 'development', startMinute: 80, durationMinutes: 40 })

  const blocks = getTimelineDayPayload(db, TEST_DATE).blocks

  assert.equal(blocks.length, 2, `a 60m locked break should split resumed work; got ${blocks.map((b) => b.label.current).join(' | ')}`)
  db.close()
})

test('entertainment does not bridge a gap into one runaway "watching" block', () => {
  const db = createDb()
  // Two video stretches in the same browser separated by a 17-minute untracked
  // lull. These are two separate detours, not "the same work resuming" — drift
  // categories must never bridge, or one block's span (and old duration) would
  // swallow the whole evening (R4).
  insertSession(db, { title: 'Video A - YouTube', bundleId: 'com.google.Chrome', appName: 'Google Chrome', category: 'entertainment', startMinute: 0, durationMinutes: 25 })
  insertSession(db, { title: 'Video B - YouTube', bundleId: 'com.google.Chrome', appName: 'Google Chrome', category: 'entertainment', startMinute: 42, durationMinutes: 25 })

  const blocks = getTimelineDayPayload(db, TEST_DATE).blocks

  assert.equal(blocks.length, 2, `entertainment across a 17m gap must not bridge; got ${blocks.length} block(s)`)
  db.close()
})

test('a sub-30-minute block with no related neighbour keeps its own block', () => {
  const db = createDb()
  // A 20-minute email block wedged between two coding stretches. Email is
  // unrelated to the development work on either side, so it stays standalone
  // rather than being forced into something it is not.
  insertSession(db, { title: 'router.ts - daylens - Cursor', bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startMinute: 0, durationMinutes: 40 })
  insertSession(db, { title: 'Inbox - Gmail - Google Chrome', bundleId: 'com.google.Chrome', appName: 'Google Chrome', category: 'email', startMinute: 40, durationMinutes: 20 })
  // A browser session's category comes from the sites reconciled inside it
  // (site-weighted distribution) — the Gmail visit is what makes this
  // stretch email.
  insertWebsiteVisit(db, {
    domain: 'mail.google.com',
    pageTitle: 'Inbox - Gmail',
    url: 'https://mail.google.com/mail/u/0/#inbox',
    startMinute: 40,
    durationSeconds: 20 * 60,
  })
  insertSession(db, { title: 'router.ts - daylens - Cursor', bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startMinute: 60, durationMinutes: 40 })

  const categories = getTimelineDayPayload(db, TEST_DATE).blocks.map((b) => b.dominantCategory)

  assert.ok(categories.includes('email'), `the unrelated email block should survive: ${JSON.stringify(categories)}`)
  db.close()
})

test('a long continuous stretch is one block — no duration ceiling', () => {
  const db = createDb()
  // A 4-hour single-title stretch is one calendar block. Decided behavior
  // (DEV-232): a block ends only on a real absence, sleep, idle, a meeting, or a
  // kind change — never because it grew "too long".
  insertSession(db, { title: 'Deep work planning - Notion', bundleId: 'notion.id', appName: 'Notion', category: 'writing', startMinute: 0, durationMinutes: 240 })

  const blocks = getTimelineDayPayload(db, TEST_DATE).blocks
  assert.equal(blocks.length, 1, `a 4h continuous stretch stays one block; got ${blocks.length}`)
  db.close()
})

test('a stretch past the old 5-hour ceiling still stays one block', () => {
  const db = createDb()
  // Two contiguous 170-minute halves of the same work — 5h40m with no real gap.
  // Under the old ceiling this split; with no ceiling it is one continuous block.
  insertSession(db, { title: 'Deep work planning - Notion', bundleId: 'notion.id', appName: 'Notion', category: 'writing', startMinute: 0, durationMinutes: 170 })
  insertSession(db, { title: 'Deep work planning - Notion', bundleId: 'notion.id', appName: 'Notion', category: 'writing', startMinute: 170, durationMinutes: 170 })

  const blocks = getTimelineDayPayload(db, TEST_DATE).blocks

  assert.equal(blocks.length, 1, `a continuous 5h40m stretch is one block; got ${blocks.length}: ${blocks.map((b) => Math.round((b.endTime - b.startTime) / 60_000) + 'm').join(', ')}`)
  db.close()
})

test('a continuous varied dev morning past 3h is one block (DEV-232)', () => {
  const db = createDb()
  // The reported bug: a real morning of building — same coding session, varied
  // window titles across the same editor, no real gap — was chopped at the old
  // 3-hour base ceiling into fragments named after whichever slice dominated.
  // Varied titles mean it never qualified for the "highly coherent" 5h lift, so
  // the base ceiling always won. With no ceiling it stays one block.
  const files = ['workBlocks.ts', 'analyzeDay.ts', 'Timeline.tsx', 'projections.ts', 'migrations.ts', 'queries.ts', 'ipc.ts', 'types.ts']
  files.forEach((file, index) => {
    insertSession(db, { title: `${file} - daylens - Cursor`, bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startMinute: index * 30, durationMinutes: 30 })
  })

  const blocks = getTimelineDayPayload(db, TEST_DATE).blocks
  assert.equal(blocks.length, 1, `a continuous 4h coding morning is one block; got ${blocks.length}: ${blocks.map((b) => `${b.label.current} ${Math.round((b.endTime - b.startTime) / 60_000)}m`).join(' | ')}`)
  db.close()
})

test('timeline hides short gap events while preserving meaningful untracked spans', () => {
  const db = createDb()
  insertSession(db, {
    title: 'Morning implementation - Cursor',
    bundleId: 'com.todesktop.cursor',
    appName: 'Cursor',
    category: 'development',
    startMinute: 0,
    durationMinutes: 30,
  })
  insertSession(db, {
    title: 'Follow-up implementation - Cursor',
    bundleId: 'com.todesktop.cursor',
    appName: 'Cursor',
    category: 'development',
    startMinute: 90,
    durationMinutes: 30,
  })
  insertActivityEvent(db, 'idle_start', localMs(9, 40))
  insertActivityEvent(db, 'idle_end', localMs(9, 40) + 10_000)

  const payload = getTimelineDayPayload(db, TEST_DATE)
  const gaps = payload.segments.filter((segment) => segment.kind !== 'work_block')
  const shortGaps = gaps.filter((segment) => segment.endTime - segment.startTime < 30 * 60_000)

  assert.equal(shortGaps.length, 0, `short gaps should be hidden: ${JSON.stringify(shortGaps)}`)
  // Typed gaps: a 10-second idle blip cannot explain an hour — the gap
  // classifies honestly as "untracked" rather than pretending to know.
  assert.ok(
    gaps.some((segment) => segment.kind === 'untracked' && segment.startTime === localMs(9, 30) && segment.endTime === localMs(10, 30)),
    `expected the full 60-minute untracked span to remain: ${JSON.stringify(gaps)}`,
  )
  db.close()
})

// Typed gaps: a visible gap carries the reason derived from the activity
// events that covered it — Asleep for a suspend, Locked for a lock, Passive
// when media held the session open.
test('gaps classify by their activity-event cause', () => {
  const db = createDb()
  insertSession(db, { title: 'a.ts - Cursor', bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startMinute: 0, durationMinutes: 30 })
  insertSession(db, { title: 'b.ts - Cursor', bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startMinute: 90, durationMinutes: 30 })
  insertSession(db, { title: 'c.ts - Cursor', bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startMinute: 180, durationMinutes: 30 })
  // First gap (9:30–10:30): machine suspended for nearly the whole stretch.
  insertActivityEvent(db, 'suspend', localMs(9, 31))
  insertActivityEvent(db, 'resume', localMs(10, 29))
  // Second gap (11:00–12:00): screen locked.
  insertActivityEvent(db, 'lock_screen', localMs(11, 2))
  insertActivityEvent(db, 'unlock_screen', localMs(11, 58))

  const gaps = getTimelineDayPayload(db, TEST_DATE).segments.filter((segment) => segment.kind !== 'work_block')
  assert.ok(
    gaps.some((gap) => gap.kind === 'asleep' && gap.startTime === localMs(9, 30)),
    `suspend-covered gap should read Asleep: ${JSON.stringify(gaps)}`,
  )
  assert.ok(
    gaps.some((gap) => gap.kind === 'locked' && gap.startTime === localMs(11, 0)),
    `lock-covered gap should read Locked: ${JSON.stringify(gaps)}`,
  )
  // Names the machine's state, never the user's whereabouts (see GAP_KIND_LABELS).
  assert.equal(gaps.find((gap) => gap.kind === 'asleep')?.label, 'Computer asleep')
  assert.equal(gaps.find((gap) => gap.kind === 'locked')?.label, 'Screen locked')
  db.close()
})

// A time-range trim (block editor) is a user "cut here": enforced after every
// merge/fold pass and persisted by wall-clock timestamp, so the separated
// pieces can never re-fuse — even on a full rebuild.
test('a time-range trim cuts the block and survives a rebuild', () => {
  const db = createDb()
  insertSession(db, { title: 'work.ts - daylens - Cursor', bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startMinute: 0, durationMinutes: 100 })

  const block = getTimelineDayPayload(db, TEST_DATE).blocks[0]
  assert.ok(block)
  assert.equal(getTimelineDayPayload(db, TEST_DATE).blocks.length, 1)

  // Trim the end back to 10:00 — the 10:00–10:40 tail re-forms on its own.
  const result = trimTimelineBlockSpan(db, TEST_DATE, block, block.startTime, localMs(10, 0))
  assert.equal(result.changed, true)

  const trimmed = getTimelineDayPayload(db, TEST_DATE).blocks
  assert.equal(trimmed.length, 2, `the cut should split the block: ${trimmed.map((b) => `${new Date(b.startTime).toLocaleTimeString()}–${new Date(b.endTime).toLocaleTimeString()}`).join(', ')}`)
  const sorted = [...trimmed].sort((a, b) => a.startTime - b.startTime)
  assert.equal(sorted[0].endTime, localMs(10, 0), 'the first piece ends exactly at the cut')
  assert.equal(sorted[1].startTime, localMs(10, 0), 'the second piece starts exactly at the cut')

  // A rebuild (stale heuristic, retired ids) must not re-fuse the pieces.
  db.prepare(`UPDATE timeline_blocks SET heuristic_version = 'timeline-v3'`).run()
  const rebuilt = getTimelineDayPayload(db, TEST_DATE).blocks
  assert.equal(rebuilt.length, 2, 'the user cut survives the rebuild')
  db.close()
})

test('file and project window titles drive labels instead of app names', () => {
  const db = createDb()
  insertSession(db, { title: 'insightsQueryRouter.ts - daylens - Cursor', bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startMinute: 0, durationMinutes: 25 })

  const [label] = labelsFor(db)

  assert.match(label, /insightsQueryRouter\.ts|daylens/i)
  assert.notEqual(label, 'Cursor')
  db.close()
})

test('a long single-app stretch is named by its evidence, not by the app', () => {
  const db = createDb()
  insertSession(db, { title: 'Competitor pricing pages', category: 'research', startMinute: 0, durationMinutes: 90 })

  const [label] = labelsFor(db)

  assert.notEqual(label, 'Google Chrome')
  db.close()
})

test('deterministic title labels outrank stale AI app-name labels', () => {
  const db = createDb()
  const startTime = localMs(9, 0)
  const endTime = startTime + 25 * 60_000
  insertSession(db, { title: 'insightsQueryRouter.ts - daylens - Cursor', bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startMinute: 0, durationMinutes: 25 })
  upsertWorkContextInsight(db, {
    startMs: startTime,
    endMs: endTime,
    insight: {
      label: 'Cursor',
      narrative: null,
    },
  })

  const [label] = labelsFor(db)

  assert.match(label, /insightsQueryRouter\.ts|daylens/i)
  assert.notEqual(label, 'Cursor')
  db.close()
})

test('terminal-dominant blocks use terminal window titles before browser page titles', () => {
  const db = createDb()
  insertSession(db, { title: 'npm run typecheck - daylens - zsh', bundleId: 'com.warp.dev', appName: 'Warp', category: 'development', startMinute: 0, durationMinutes: 20 })
  insertSession(db, { title: 'React docs - Google Chrome', startMinute: 20, durationMinutes: 6, category: 'browsing' })

  const [label] = labelsFor(db)

  assert.match(label, /npm run typecheck|daylens/i)
  assert.doesNotMatch(label, /React docs|Google Chrome/i)
  db.close()
})

test('mixed Daylens development and research does not keep a browsing badge when focused work is substantial', () => {
  const db = createDb()
  insertSession(db, { title: 'workBlocks.ts - daylens - Cursor', bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startMinute: 0, durationMinutes: 16 })
  insertSession(db, { title: 'irachrist1/daylens-v1: Daylens - GitHub - Google Chrome', startMinute: 16, durationMinutes: 24, category: 'browsing' })

  const [block] = getTimelineDayPayload(db, TEST_DATE).blocks

  assert.equal(block.dominantCategory, 'development')
  assert.notEqual(block.dominantCategory, 'browsing')
  db.close()
})

test('GitHub repo review pages badge as focused research rather than browsing', () => {
  const db = createDb()
  insertSession(db, { title: 'irachrist1/daylens-v1: Daylens - GitHub - Google Chrome', startMinute: 0, durationMinutes: 35, category: 'browsing' })
  insertWebsiteVisit(db, {
    domain: 'github.com',
    pageTitle: 'irachrist1/daylens-v1: Daylens',
    url: 'https://github.com/irachrist1/daylens-v1',
    startMinute: 0,
    durationSeconds: 35 * 60,
  })

  const [block] = getTimelineDayPayload(db, TEST_DATE).blocks

  assert.equal(block.dominantCategory, 'research')
  db.close()
})

test('contiguous AI assistant and GitHub repo review collapse into one assisted work block', () => {
  const db = createDb()
  insertSession(db, { title: 'Claude Code - Dia', bundleId: 'company.thebrowser.dia', appName: 'Dia', category: 'aiTools', startMinute: 0, durationMinutes: 120 })
  // Dia is a browser: the claude.ai visit is what makes its stretch aiTools
  // under the site-weighted distribution.
  insertWebsiteVisit(db, {
    domain: 'claude.ai',
    pageTitle: 'Claude Code',
    url: 'https://claude.ai/code',
    startMinute: 0,
    durationSeconds: 120 * 60,
    browserBundleId: 'company.thebrowser.dia',
  })
  insertSession(db, { title: 'irachrist1/daylens-v1: Daylens - GitHub - Google Chrome', startMinute: 120, durationMinutes: 115, category: 'browsing' })
  insertWebsiteVisit(db, {
    domain: 'github.com',
    pageTitle: 'irachrist1/daylens-v1: Daylens',
    url: 'https://github.com/irachrist1/daylens-v1',
    startMinute: 120,
    durationSeconds: 115 * 60,
  })

  const blocks = getTimelineDayPayload(db, TEST_DATE).blocks

  assert.equal(blocks.length, 1, `AI assistant plus repo review should merge; got ${blocks.map((b) => b.label.current).join(' | ')}`)
  assert.equal(blocks[0].dominantCategory, 'aiTools')
  db.close()
})

function heuristicVersions(db: Database.Database): string[] {
  return (db.prepare(
    `SELECT heuristic_version FROM timeline_blocks WHERE invalidated_at IS NULL AND is_live = 0 ORDER BY start_time`,
  ).all() as Array<{ heuristic_version: string }>).map((r) => r.heuristic_version)
}

test('a stale, never-processed past day is reconstructed on revisit', () => {
  const db = createDb()
  insertSession(db, { title: 'router.ts - daylens - Cursor', bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startMinute: 0, durationMinutes: 40 })

  // First visit persists under the current heuristic version.
  getTimelineDayPayload(db, TEST_DATE)
  // Simulate the day having been persisted by a superseded heuristic.
  db.prepare(`UPDATE timeline_blocks SET heuristic_version = 'timeline-v3'`).run()
  assert.deepEqual(heuristicVersions(db), ['timeline-v3'])

  // Revisiting an older, unprocessed day rebuilds it more accurately.
  getTimelineDayPayload(db, TEST_DATE)
  assert.ok(heuristicVersions(db).every((v) => v === 'timeline-v13'), 'stale unprocessed day should be rebuilt')
  db.close()
})

test('a nightly-processed past day is kept even when its heuristic is stale', () => {
  const db = createDb()
  insertSession(db, { title: 'router.ts - daylens - Cursor', bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startMinute: 0, durationMinutes: 40 })

  const before = getTimelineDayPayload(db, TEST_DATE)
  const blockId = (db.prepare(`SELECT id FROM timeline_blocks LIMIT 1`).get() as { id: string }).id
  // Mark the day as nightly-processed (an AI label) under a superseded heuristic.
  db.prepare(`UPDATE timeline_blocks SET heuristic_version = 'timeline-v3'`).run()
  db.prepare(`
    INSERT INTO timeline_block_labels (id, block_id, label, narrative, source, confidence, created_at, model_info_json)
    VALUES (?, ?, 'Refactoring the router', NULL, 'ai', 0.9, ?, NULL)
  `).run(`${blockId}:ai:test`, blockId, Date.now())

  // "Kept as summarized" means the summary is frozen: same blocks, same
  // boundaries, same labels — never a rebuild. (The block's deterministic
  // category facts MAY be refreshed in place; that is the category-refresh
  // test below, and it must not change identity or labels.)
  const after = getTimelineDayPayload(db, TEST_DATE)
  assert.deepEqual(
    after.blocks.map((b) => [b.id, b.startTime, b.endTime]),
    before.blocks.map((b) => [b.id, b.startTime, b.endTime]),
    'processed day must keep its block identity and boundaries',
  )
  assert.equal(after.blocks[0]?.label.current, 'Refactoring the router', 'the AI label must survive')
  db.close()
})

test('a processed stale day refreshes its category facts in place, without touching labels', () => {
  const db = createDb()
  insertSession(db, { title: 'router.ts - daylens - Cursor', bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startMinute: 0, durationMinutes: 40 })

  getTimelineDayPayload(db, TEST_DATE)
  const blockId = (db.prepare(`SELECT id FROM timeline_blocks LIMIT 1`).get() as { id: string }).id
  // Simulate a day summarized by an old heuristic that miscategorized the
  // whole block as entertainment (the "no color until Analyze" bug).
  db.prepare(`
    UPDATE timeline_blocks
    SET heuristic_version = 'timeline-v3',
        dominant_category = 'entertainment',
        category_distribution_json = '{"entertainment": 2400}'
  `).run()
  db.prepare(`
    INSERT INTO timeline_block_labels (id, block_id, label, narrative, source, confidence, created_at, model_info_json)
    VALUES (?, ?, 'Refactoring the router', NULL, 'ai', 0.9, ?, NULL)
  `).run(`${blockId}:ai:test`, blockId, Date.now())

  const payload = getTimelineDayPayload(db, TEST_DATE)
  assert.equal(payload.blocks[0]?.dominantCategory, 'development', 'category facts converge on current rules')
  assert.equal(payload.blocks[0]?.label.current, 'Refactoring the router', 'labels are never touched by the refresh')

  // The refresh is written back so row-level readers (month grid) converge
  // too, and stamped so it runs once per heuristic bump.
  const row = db.prepare(`SELECT dominant_category, heuristic_version FROM timeline_blocks WHERE id = ?`).get(blockId) as { dominant_category: string; heuristic_version: string }
  assert.equal(row.dominant_category, 'development')
  assert.equal(row.heuristic_version, 'timeline-v13')
  db.close()
})

test('a deleted block disappears from the day payload', () => {
  const db = createDb()
  insertSession(db, { title: 'router.ts - daylens - Cursor', bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startMinute: 0, durationMinutes: 40 })

  const block = getTimelineDayPayload(db, TEST_DATE).blocks[0]
  assert.ok(block)

  // Delete = review state 'ignored'. The block vanishes from the payload (and
  // with it every surface that reads it), and its time leaves the totals.
  writeTimelineBlockReview(db, TEST_DATE, block, { state: 'ignored' })

  const reloaded = getTimelineDayPayload(db, TEST_DATE)
  assert.equal(reloaded.blocks.length, 0, 'a deleted block must not appear in the payload')
  const reviewRows = db.prepare(`SELECT COUNT(*) AS count FROM timeline_block_reviews WHERE review_state = 'ignored'`).get() as { count: number }
  assert.equal(reviewRows.count, 1)
  db.close()
})

test('a deleted block stays deleted through a rebuild and is not absorbed by a neighbour', () => {
  const db = createDb()
  // Two separate stretches: real work, then a video block the user deletes.
  insertSession(db, { title: 'router.ts - daylens - Cursor', bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startMinute: 0, durationMinutes: 40 })
  insertSession(db, { title: 'Video A - YouTube', bundleId: 'com.google.Chrome', appName: 'Google Chrome', category: 'entertainment', startMinute: 40, durationMinutes: 25 })
  // The YouTube visit is what makes the browser stretch entertainment under
  // the site-weighted distribution.
  insertWebsiteVisit(db, {
    domain: 'youtube.com',
    pageTitle: 'Video A - YouTube',
    url: 'https://www.youtube.com/watch?v=videoA',
    startMinute: 40,
    durationSeconds: 25 * 60,
  })

  const before = getTimelineDayPayload(db, TEST_DATE).blocks
  assert.equal(before.length, 2)
  const video = before.find((b) => b.dominantCategory === 'entertainment')
  assert.ok(video, 'the video block should exist before deletion')

  writeTimelineBlockReview(db, TEST_DATE, video!, { state: 'ignored' })

  const afterDelete = getTimelineDayPayload(db, TEST_DATE).blocks
  assert.equal(afterDelete.length, 1, 'only the work block remains')
  assert.equal(afterDelete[0].dominantCategory, 'development')

  // Force a full rebuild: the deleted span's sessions are excluded, so the
  // block neither re-forms nor folds into the work block.
  db.prepare(`UPDATE timeline_blocks SET heuristic_version = 'timeline-v3'`).run()
  const afterRebuild = getTimelineDayPayload(db, TEST_DATE).blocks
  assert.equal(afterRebuild.length, 1, 'the deletion must survive the rebuild')
  assert.equal(afterRebuild[0].dominantCategory, 'development')
  assert.ok(
    afterRebuild[0].endTime <= video!.startTime,
    'the deleted span must not be absorbed into the surviving block',
  )
  db.close()
})

test('timeline block correction survives rebuild through evidence lineage', () => {
  const db = createDb()
  insertSession(db, { title: 'router.ts - daylens - Cursor', bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startMinute: 0, durationMinutes: 40 })

  const block = getTimelineDayPayload(db, TEST_DATE).blocks[0]
  assert.ok(block)
  writeTimelineBlockReview(db, TEST_DATE, block, {
    state: 'corrected',
    correctedLabel: 'Router refactor',
  })

  db.prepare(`UPDATE timeline_block_reviews SET block_id = 'retired-block-id' WHERE block_id = ?`).run(block.id)
  db.prepare(`UPDATE timeline_blocks SET heuristic_version = 'timeline-v3'`).run()

  const rebuilt = getTimelineDayPayload(db, TEST_DATE).blocks[0]
  assert.equal(rebuilt.label.current, 'Router refactor')
  assert.equal(rebuilt.label.source, 'user')
  assert.equal(rebuilt.review.state, 'corrected')
  assert.equal(rebuilt.review.source, 'stored_evidence')
  assert.equal(rebuilt.review.correctedLabel, 'Router refactor')
  assert.ok(heuristicVersions(db).every((v) => v === 'timeline-v13'), 'stale day should rebuild while preserving correction')
  db.close()
})

// Edit → Type: a user recategorization is a correction like a rename — it wins
// over the computed dominant category on every read, flips the work/leisure
// kind to match, and survives a rebuild through evidence lineage. Category
// drives block color everywhere, so this is what makes a recolor stick.
test('a category correction wins, recolors the kind, and survives rebuild', () => {
  const db = createDb()
  insertSession(db, { title: 'Stranger Things - Netflix', bundleId: 'com.google.Chrome', appName: 'Google Chrome', category: 'entertainment', startMinute: 0, durationMinutes: 40 })
  // The Netflix visit is what makes the browser stretch entertainment under
  // the site-weighted distribution.
  insertWebsiteVisit(db, {
    domain: 'netflix.com',
    pageTitle: 'Stranger Things - Netflix',
    url: 'https://www.netflix.com/watch/1',
    startMinute: 0,
    durationSeconds: 40 * 60,
  })

  const block = getTimelineDayPayload(db, TEST_DATE).blocks[0]
  assert.ok(block)
  assert.equal(block.dominantCategory, 'entertainment')

  writeTimelineBlockReview(db, TEST_DATE, block, {
    state: 'corrected',
    correctedCategory: 'research',
  })

  const corrected = getTimelineDayPayload(db, TEST_DATE).blocks[0]
  assert.equal(corrected.dominantCategory, 'research', 'the corrected category wins on read')
  assert.equal(corrected.kind, 'work', 'the kind follows the corrected category')
  assert.equal(corrected.review.correctedCategory, 'research')

  // Simulate a rebuild: retire the block id and stale the heuristic. The
  // correction re-applies through the evidence key, not the block id.
  db.prepare(`UPDATE timeline_block_reviews SET block_id = 'retired-block-id' WHERE block_id = ?`).run(block.id)
  db.prepare(`UPDATE timeline_blocks SET heuristic_version = 'timeline-v3'`).run()

  const rebuilt = getTimelineDayPayload(db, TEST_DATE).blocks[0]
  assert.equal(rebuilt.dominantCategory, 'research', 'the category correction survives the rebuild')
  assert.equal(rebuilt.kind, 'work')
  db.close()
})

// Undo a rename: a rename is stored as both an override and an evidence-keyed
// review correction, so clearing it must reset the review too — otherwise the
// corrected label keeps winning and the rename never goes away.
test('clearing a corrected review reverts the block to its computed label', () => {
  const db = createDb()
  insertSession(db, { title: 'router.ts - daylens - Cursor', bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startMinute: 0, durationMinutes: 40 })

  const block = getTimelineDayPayload(db, TEST_DATE).blocks[0]
  const computedLabel = block.label.current
  writeTimelineBlockReview(db, TEST_DATE, block, { state: 'corrected', correctedLabel: 'Renamed thing' })
  assert.equal(getTimelineDayPayload(db, TEST_DATE).blocks[0].label.current, 'Renamed thing')

  // Undo: reset the review and drop the corrected label.
  const corrected = getTimelineDayPayload(db, TEST_DATE).blocks[0]
  writeTimelineBlockReview(db, TEST_DATE, corrected, { state: 'auto-approved', correctedLabel: null })

  const reverted = getTimelineDayPayload(db, TEST_DATE).blocks[0]
  assert.notEqual(reverted.label.current, 'Renamed thing', 'undo should drop the corrected label')
  assert.equal(reverted.label.current, computedLabel, 'undo restores the computed label')
  db.close()
})

// Today, before it has been analyzed, is one provisional block PER CONTINUOUS
// SITTING — neutral labels, never per-activity named. A real 15+ minute
// activity gap ends the sitting; the gap is blank space, never absorbed into
// a whole-day card. Daylens makes no claim about the day's shape until the
// user analyzes it.
test('the live day is one provisional block per sitting until it is analyzed', () => {
  const db = createDb()
  const today = dateStringForOffset(0)
  // Two stretches separated by a long idle gap — two sittings, two provisional
  // blocks, and the gap between them is not inside either block's span.
  insertSession(db, { title: 'workBlocks.ts - daylens - Cursor', bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startMinute: 0, durationMinutes: 40, dateStr: today })
  insertSession(db, { title: 'Inbox - Gmail - Google Chrome', bundleId: 'com.google.Chrome', appName: 'Google Chrome', category: 'communication', startMinute: 180, durationMinutes: 30, dateStr: today })

  const blocks = getTimelineDayProjection(db, today, null, { materialize: false }).blocks
  assert.equal(blocks.length, 2, `two sittings should be two provisional blocks, got ${blocks.length}`)
  assert.ok(blocks.every((block) => block.provisional === true), 'today blocks are provisional before analysis')
  assert.ok(blocks.every((block) => block.label.current === 'Earlier today'), `provisional blocks are neutral, got ${blocks.map((b) => b.label.current).join(', ')}`)
  // The 2h20m idle gap is never absorbed: neither block spans across it.
  const sorted = [...blocks].sort((a, b) => a.startTime - b.startTime)
  assert.ok(sorted[0].endTime <= sorted[1].startTime - 60 * 60_000, 'the idle gap stays blank space between the sittings')
  db.close()
})

// Analyze Day finalizes the live day: materializing it persists named blocks,
// and subsequent passive reads show those — never the provisional placeholder.
test('analyzing the live day replaces the provisional block with named blocks', () => {
  const db = createDb()
  const today = dateStringForOffset(0)
  insertSession(db, { title: 'workBlocks.ts - daylens - Cursor', bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startMinute: 0, durationMinutes: 40, dateStr: today })

  const provisional = getTimelineDayProjection(db, today, null, { materialize: false }).blocks
  assert.ok(provisional.every((block) => block.provisional), 'starts provisional')

  // Analyze Day = a materialize request: persists the real segmentation.
  materializeTimelineDayProjection(db, today, null)

  const named = getTimelineDayProjection(db, today, null, { materialize: false }).blocks
  assert.ok(named.every((block) => !block.provisional), 'an analyzed day is no longer provisional')
  assert.ok(named.every((block) => block.label.current !== 'Active now'), 'analyzed blocks are named, not "Active now"')
  db.close()
})

test('timeline projection reads canonical focus-event days without materializing timeline blocks', () => {
  const db = createDb()
  insertCanonicalFocusDay(db)

  const payload = getTimelineDayProjection(db, TEST_DATE, null, { materialize: false })

  assert.equal(payload.blocks.length, 1)
  const count = db.prepare(`
    SELECT COUNT(*) AS count
    FROM timeline_blocks
    WHERE date = ? AND invalidated_at IS NULL
  `).get(TEST_DATE) as { count: number }
  assert.equal(count.count, 0, 'read-only projection should not persist timeline blocks')
  db.close()
})

test('explicit timeline materialization persists canonical-day blocks for block writes', () => {
  const db = createDb()
  insertCanonicalFocusDay(db)

  const payload = materializeTimelineDayProjection(db, TEST_DATE, null)

  assert.equal(payload.blocks.length, 1)
  const count = db.prepare(`
    SELECT COUNT(*) AS count
    FROM timeline_blocks
    WHERE date = ? AND invalidated_at IS NULL
  `).get(TEST_DATE) as { count: number }
  assert.equal(count.count, 1)
  db.close()
})

test('block detail lookup uses persisted block date before falling back to recent-day scans', () => {
  const db = createDb()
  const olderDate = dateStringForOffset(-45)
  insertSession(db, {
    dateStr: olderDate,
    title: 'lookup.ts - daylens - Cursor',
    bundleId: 'com.todesktop.cursor',
    appName: 'Cursor',
    category: 'development',
    startMinute: 0,
    durationMinutes: 35,
  })

  const [block] = getTimelineDayPayload(db, olderDate).blocks

  const detail = getBlockDetailPayload(db, block.id)

  assert.equal(detail?.id, block.id)
  assert.equal(detail?.label.current, block.label.current)
  db.close()
})

test('every block carries a non-empty boundary reason on both edges', () => {
  const db = createDb()
  insertSession(db, { title: 'router.ts - daylens - Cursor', bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startMinute: 0, durationMinutes: 40 })

  const [block] = getTimelineDayPayload(db, TEST_DATE).blocks
  assert.ok(block.boundary, 'block must expose a boundary')
  assert.ok((block.boundary?.startReasons.length ?? 0) > 0, 'start reason must be non-empty')
  assert.ok((block.boundary?.endReasons.length ?? 0) > 0, 'end reason must be non-empty')
  db.close()
})

test('a user merge erases a boundary that survives a rebuild', () => {
  const db = createDb()
  // Two distinct browsing topics split into two blocks by default.
  insertSession(db, { title: 'Camera comparison research - DPReview - Google Chrome', startMinute: 0, durationMinutes: 25 })
  insertSession(db, { title: 'City council election results - Local News - Google Chrome', startMinute: 25, durationMinutes: 25 })

  const before = getTimelineDayPayload(db, TEST_DATE).blocks
  assert.equal(before.length, 2, 'distinct browsing topics should be two blocks before the merge')

  mergeTimelineEpisodes(db, TEST_DATE, [before[0], before[1]])

  const afterMerge = getTimelineDayPayload(db, TEST_DATE).blocks
  assert.equal(afterMerge.length, 1, 'the user merge should collapse the two episodes into one')

  db.prepare(`UPDATE timeline_blocks SET heuristic_version = 'timeline-v3'`).run()
  const afterRebuild = getTimelineDayPayload(db, TEST_DATE).blocks
  assert.equal(afterRebuild.length, 1, 'the merge must survive a rebuild')
  db.close()
})

test('a settled day whose sessions carry synthetic ids still merges (DEV-233)', () => {
  const db = createDb()
  // A past day is served from the derived-session namespace, whose ids are
  // synthetic negatives. There is no persisted session pair to key a boundary
  // correction on — which used to fail every merge on a settled day with a false
  // "This episode is still live" message. The merge must anchor on its span.
  insertSession(db, { title: 'Camera comparison research - DPReview - Google Chrome', startMinute: 0, durationMinutes: 25 })
  insertSession(db, { title: 'City council election results - Local News - Google Chrome', startMinute: 25, durationMinutes: 25 })

  const before = getTimelineDayPayload(db, TEST_DATE).blocks
  assert.equal(before.length, 2)

  // Re-key every session into the synthetic (negative) namespace, exactly as a
  // settled day's projection hands them to the merge.
  const synthetic = before.map((block) => ({
    ...block,
    sessions: block.sessions.map((session, index) => ({ ...session, id: -(index + 1) })),
  }))
  assert.ok(synthetic.every((b) => b.sessions.every((s) => s.id < 0)), 'fixture must have no positive session ids')

  mergeTimelineEpisodes(db, TEST_DATE, synthetic)

  assert.equal(getTimelineDayPayload(db, TEST_DATE).blocks.length, 1, 'the merge must apply on a settled day')

  db.prepare(`UPDATE timeline_blocks SET heuristic_version = 'timeline-v3'`).run()
  assert.equal(getTimelineDayPayload(db, TEST_DATE).blocks.length, 1, 'the span-anchored merge must survive a rebuild')
  db.close()
})

test('a merge still refuses a block with no evidence at all (live episode)', () => {
  const db = createDb()
  insertSession(db, { title: 'Camera comparison research - DPReview - Google Chrome', startMinute: 0, durationMinutes: 25 })
  insertSession(db, { title: 'City council election results - Local News - Google Chrome', startMinute: 25, durationMinutes: 25 })
  const before = getTimelineDayPayload(db, TEST_DATE).blocks
  const emptied = [{ ...before[0], sessions: [] }, before[1]]
  assert.throws(
    () => mergeTimelineEpisodes(db, TEST_DATE, emptied),
    /still live/,
    'a block with no sessions has nothing to anchor and must say so',
  )
  db.close()
})

test('merging a non-adjacent span absorbs the blocks in between and survives a rebuild', () => {
  const db = createDb()
  // Three distinct browsing topics → three blocks by default. Selecting the
  // first and the last and merging must fuse the whole A→B→C span, not skip B.
  insertSession(db, { title: 'Camera comparison research - DPReview - Google Chrome', startMinute: 0, durationMinutes: 20 })
  insertSession(db, { title: 'City council election results - Local News - Google Chrome', startMinute: 20, durationMinutes: 20 })
  insertSession(db, { title: 'Best hiking trails near Boulder - AllTrails - Google Chrome', startMinute: 40, durationMinutes: 20 })

  const before = getTimelineDayPayload(db, TEST_DATE).blocks
  assert.equal(before.length, 3, 'three distinct browsing topics should be three blocks before the merge')

  // Pass only the two endpoints, as the handler does after expanding the span.
  mergeTimelineEpisodes(db, TEST_DATE, [before[0], before[1], before[2]])

  const afterMerge = getTimelineDayPayload(db, TEST_DATE).blocks
  assert.equal(afterMerge.length, 1, 'merging the span should collapse all three episodes into one')

  db.prepare(`UPDATE timeline_blocks SET heuristic_version = 'timeline-v3'`).run()
  const afterRebuild = getTimelineDayPayload(db, TEST_DATE).blocks
  assert.equal(afterRebuild.length, 1, 'the span merge must survive a rebuild')
  db.close()
})

test('a user merge overrides a kind-shift hard cut (work absorbs leisure)', () => {
  const db = createDb()
  // Coding then YouTube, back to back. A kind change is normally the hardest
  // boundary of all, so these are two blocks by default. A manual merge is the
  // strongest signal there is and must win even over kind-shift.
  insertSession(db, { title: 'router.ts - daylens - Cursor', bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startMinute: 0, durationMinutes: 40 })
  insertSession(db, { title: 'How Israel Won the War - YouTube', bundleId: 'com.google.Chrome', appName: 'Google Chrome', category: 'entertainment', startMinute: 40, durationMinutes: 15 })

  const before = getTimelineDayPayload(db, TEST_DATE).blocks
  assert.equal(before.length, 2, 'a kind change should hard-cut work from leisure by default')

  mergeTimelineEpisodes(db, TEST_DATE, [before[0], before[1]])

  const afterMerge = getTimelineDayPayload(db, TEST_DATE).blocks
  assert.equal(afterMerge.length, 1, 'a user merge must override the kind-shift cut')

  db.prepare(`UPDATE timeline_blocks SET heuristic_version = 'timeline-v3'`).run()
  const afterRebuild = getTimelineDayPayload(db, TEST_DATE).blocks
  assert.equal(afterRebuild.length, 1, 'the cross-kind merge must survive a rebuild')
  db.close()
})

test('a user merge survives even when session ids change namespace', () => {
  const db = createDb()
  // The real-world failure behind "merge works half the time": a merge recorded
  // against app_sessions ids stops matching once the day is rebuilt from
  // derived_sessions (a different id namespace, and derived ids churn on every
  // reprojection). The span anchor must carry the merge on its own.
  insertSession(db, { title: 'Camera comparison research - DPReview - Google Chrome', startMinute: 0, durationMinutes: 25 })
  insertSession(db, { title: 'City council election results - Local News - Google Chrome', startMinute: 25, durationMinutes: 25 })

  const before = getTimelineDayPayload(db, TEST_DATE).blocks
  assert.equal(before.length, 2)
  mergeTimelineEpisodes(db, TEST_DATE, [before[0], before[1]])

  // Simulate the namespace flip: the recorded session-id pair no longer exists.
  db.prepare(`
    UPDATE timeline_boundary_corrections
    SET left_session_id = left_session_id + 400000,
        right_session_id = right_session_id + 400000
  `).run()

  db.prepare(`UPDATE timeline_blocks SET heuristic_version = 'timeline-v3'`).run()
  const afterRebuild = getTimelineDayPayload(db, TEST_DATE).blocks
  assert.equal(afterRebuild.length, 1, 'the merge must survive on its span anchor alone')
  db.close()
})

test('chat blocks with only app-name evidence read as the category, never the app name', () => {
  const db = createDb()
  insertSession(db, {
    title: 'WhatsApp',
    bundleId: 'com.whatsapp.WhatsApp',
    appName: 'whatsApp',
    category: 'communication',
    startMinute: 0,
    durationMinutes: 20,
  })

  const [label] = labelsFor(db)

  // The app name ("WhatsApp") must never become the label, but the category
  // floor "Communication" is a better, badge-consistent answer than a blank.
  assert.equal(label, 'Communication')
  assert.notEqual(label?.toLowerCase(), 'whatsapp')
  db.close()
})

// ─── Whole-day coverage (the cutover-day collapse) ───────────────────────────
// The canonical capture era began mid-evening on a real day: legacy
// app_sessions held 08:42–21:16 and focus_events held 21:16–00:00, and the
// mixed evidence read dropped every legacy session — an 11.7-hour working day
// never rendered. Invariant: a day whose sessions tile N hours must produce
// valid blocks covering that evidence, whatever mix of eras backs it.
test('a capture-cutover day keeps its whole session coverage in valid blocks', () => {
  const db = createDb()
  // Legacy-only morning and afternoon: 09:00–15:00 tiled in near-contiguous
  // hourly dev sessions (58m each; the 2m lulls stay inside one sitting).
  for (let hour = 0; hour < 6; hour += 1) {
    insertSession(db, {
      title: `work-${hour}.ts - daylens - Ghostty`,
      bundleId: 'com.mitchellh.ghostty',
      appName: 'Ghostty',
      category: 'development',
      startMinute: hour * 60,
      durationMinutes: 58,
    })
  }
  // Canonical era from 15:00: contiguous focus events until 18:00, plus a
  // dual-write legacy duplicate of the first canonical hour.
  insertFocusEvent(db, localMs(15, 0), 'app_activated', { bundleId: 'com.mitchellh.ghostty', appName: 'Ghostty', title: 'npm run dev - daylens - Ghostty' })
  insertFocusEvent(db, localMs(16, 0), 'app_activated', { bundleId: 'com.todesktop.cursor', appName: 'Cursor', title: 'workBlocks.ts - daylens - Cursor' })
  insertFocusEvent(db, localMs(16, 0), 'app_deactivated', { bundleId: 'com.mitchellh.ghostty', appName: 'Ghostty' })
  insertFocusEvent(db, localMs(18, 0), 'app_deactivated', { bundleId: 'com.todesktop.cursor', appName: 'Cursor' })
  insertSession(db, {
    title: 'npm run dev - daylens - Ghostty',
    bundleId: 'com.mitchellh.ghostty',
    appName: 'Ghostty',
    category: 'development',
    startMinute: 6 * 60,
    durationMinutes: 60,
  })

  const payload = getTimelineDayPayload(db, TEST_DATE)
  const sessionSeconds = payload.sessions.reduce((sum, session) => sum + session.durationSeconds, 0)
  assert.ok(
    Math.abs(sessionSeconds - 9 * 3600) <= 15 * 60,
    `sessions must tile ~9h without double counting the dual-write hour; got ${Math.round(sessionSeconds / 60)}m`,
  )
  const blocks = payload.blocks
  assert.ok(blocks.length > 0)
  const firstStart = Math.min(...blocks.map((block) => block.startTime))
  const lastEnd = Math.max(...blocks.map((block) => block.endTime))
  assert.ok(
    firstStart <= localMs(9, 5),
    `valid blocks must reach back to the legacy morning; first block starts at +${Math.round((firstStart - localMs(9, 0)) / 60_000)}m`,
  )
  assert.ok(
    lastEnd >= localMs(17, 55),
    `valid blocks must reach the canonical evening; last block ends ${Math.round((localMs(18, 0) - lastEnd) / 60_000)}m early`,
  )
  assert.ok(
    payload.totalSeconds >= sessionSeconds * 0.9,
    `valid blocks must track session coverage; blocks hold ${Math.round(payload.totalSeconds / 60)}m of ${Math.round(sessionSeconds / 60)}m tracked`,
  )
  db.close()
})

// ─── Titleless native sessions are first-class evidence (DEFECT: Ghostty) ────
// A terminal-heavy day whose Ghostty sessions all have empty window titles
// must still list Ghostty in block evidence with its real seconds. The
// canonical fold used to let the previous app's trailing deactivation (same
// timestamp, later id) kill the just-opened Ghostty session; browsers were
// resurrected by tab events, terminals were not.
test('a block from titleless Ghostty sessions lists Ghostty in topApps with its real seconds', () => {
  const db = createDb()
  insertFocusEvent(db, localMs(9, 0), 'app_activated', { bundleId: 'com.todesktop.cursor', appName: 'Cursor', title: 'workBlocks.ts - daylens - Cursor' })
  // Activation of titleless Ghostty precedes Cursor's trailing deactivation.
  insertFocusEvent(db, localMs(9, 5), 'app_activated', { bundleId: 'com.mitchellh.ghostty', appName: 'Ghostty', title: null })
  insertFocusEvent(db, localMs(9, 5), 'app_deactivated', { bundleId: 'com.todesktop.cursor', appName: 'Cursor' })
  insertFocusEvent(db, localMs(9, 50), 'app_activated', { bundleId: 'com.todesktop.cursor', appName: 'Cursor', title: 'workBlocks.ts - daylens - Cursor' })
  insertFocusEvent(db, localMs(9, 50), 'app_deactivated', { bundleId: 'com.mitchellh.ghostty', appName: 'Ghostty' })
  insertFocusEvent(db, localMs(10, 0), 'app_deactivated', { bundleId: 'com.todesktop.cursor', appName: 'Cursor' })

  const payload = getTimelineDayPayload(db, TEST_DATE)
  const ghosttySessionSeconds = payload.sessions
    .filter((session) => session.appName === 'Ghostty')
    .reduce((sum, session) => sum + session.durationSeconds, 0)
  assert.equal(ghosttySessionSeconds, 45 * 60, 'the titleless Ghostty stretch keeps its real duration')

  const ghosttyTop = payload.blocks
    .flatMap((block) => block.topApps)
    .find((app) => app.appName === 'Ghostty')
  assert.ok(ghosttyTop, 'Ghostty must appear in block evidence')
  assert.ok(
    ghosttyTop!.totalSeconds >= 44 * 60,
    `Ghostty evidence must carry its real seconds; got ${ghosttyTop!.totalSeconds}s`,
  )
  assert.ok(
    payload.totalSeconds >= 55 * 60,
    `day totals must include the titleless stretch; got ${Math.round(payload.totalSeconds / 60)}m`,
  )
  db.close()
})

// ─── The evidence mint floor (dead-zone phantom blocks) ──────────────────────
// A real day minted a 72-minute "Building the Daylens app" block from a single
// spurious activation inside an idle stretch that had opened before the day's
// sessions began (idle_start 00:34, block 01:47–02:59, lock at 02:59). No
// floor-sized block may be minted whose span holds under 5 minutes of observed
// evidence once such a still-open real absence is subtracted.
test('no block is minted over a dead zone the machine-state ledger marks as absence', () => {
  const db = createDb()
  // Idle opens BEFORE the first session and never ends until 11:25 — the
  // mint floor must see it through the look-back seed.
  insertActivityEvent(db, 'idle_start', localMs(8, 0))
  // The phantom: a session whose envelope equals its claimed activity, like a
  // canonical session extrapolated from one spurious activation event.
  insertSession(db, {
    title: 'Daylens',
    bundleId: 'com.github.Electron',
    appName: 'Electron',
    category: 'development',
    startMinute: 0,
    durationMinutes: 90,
  })
  insertActivityEvent(db, 'idle_end', localMs(11, 25))
  // Real work after the person came back.
  insertSession(db, {
    title: 'workBlocks.ts - daylens - Cursor',
    bundleId: 'com.todesktop.cursor',
    appName: 'Cursor',
    category: 'development',
    startMinute: 150,
    durationMinutes: 60,
  })

  const blocks = getTimelineDayPayload(db, TEST_DATE).blocks
  assert.ok(
    blocks.some((block) => block.startTime >= localMs(11, 30) - 60_000),
    'the real post-idle work block must exist',
  )
  assert.equal(
    blocks.filter((block) => block.startTime < localMs(10, 31)).length,
    0,
    `no block may be minted over the 09:00–10:30 dead zone; got ${blocks.map((b) => `${new Date(b.startTime).toTimeString().slice(0, 5)}-${new Date(b.endTime).toTimeString().slice(0, 5)}`).join(' | ')}`,
  )
  db.close()
})

test('a media-held idle stretch is presence, not a dead zone — the block stays', () => {
  const db = createDb()
  insertSession(db, {
    title: 'Deep Focus Mix - YouTube - Google Chrome',
    bundleId: 'com.google.Chrome',
    appName: 'Google Chrome',
    category: 'entertainment',
    startMinute: 0,
    durationMinutes: 90,
  })
  // Idle fired three minutes in and held until the end of the video, but
  // capture marked it held for media playback: presence without input, never
  // an absence. Were the hold treated as hard idle, observed evidence would
  // be 3 minutes — under the mint floor — and the block would wrongly drop.
  insertActivityEvent(db, 'idle_start', localMs(9, 3), { heldForMediaPlayback: true })
  insertActivityEvent(db, 'idle_end', localMs(10, 30))

  const blocks = getTimelineDayPayload(db, TEST_DATE).blocks
  assert.equal(blocks.length, 1, 'the watching block must survive the mint floor')
  assert.ok(blocks[0].endTime - blocks[0].startTime >= 85 * 60_000)
  db.close()
})
