// A scheduled meeting is supported by the meeting-app time actually captured
// during it — not by whether that time happened to dominate a whole block.
//
// The shape that used to fail: you join the call, keep the browser in front,
// and Zoom only reaches the foreground in bursts. No single Zoom run is long
// enough to split a block of its own, so the hour is one browsing block, the
// day found no meeting evidence at all, and it went on to ask whether you had
// been in a call it plainly recorded.
import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { putExternalSignal } from '../src/main/services/externalSignals.ts'
import { getTimelineDayPayload } from '../src/main/services/workBlocks.ts'
import { detectDayClarifications } from '../src/main/services/dayClarifications.ts'
import type { CalendarSignal } from '../src/shared/types.ts'

const DAY = '2026-04-22'
const dayStart = new Date(`${DAY}T00:00:00`).getTime()
const at = (hour: number, minute: number) => dayStart + (hour * 60 + minute) * 60_000
// Well past the day, so the "has it ended yet?" gate is never what suppresses
// a question here.
const NEXT_MORNING = at(30, 0)

function session(
  db: Database.Database,
  opts: { app: string; bundle: string; category: string; from: number; to: number },
): void {
  db.prepare(`
    INSERT INTO app_sessions
      (bundle_id, app_name, start_time, end_time, duration_sec, category, is_focused,
       window_title, raw_app_name, capture_source, capture_version)
    VALUES (?, ?, ?, ?, ?, ?, 1, 'work', ?, 'test', 1)
  `).run(opts.bundle, opts.app, opts.from, opts.to, Math.round((opts.to - opts.from) / 1000), opts.category, opts.app)
}

// 9:00–12:00 at the desk. A "Roadmap review" is on the calendar 10:00–11:00,
// and Zoom holds the foreground for four short bursts inside it while Chrome
// carries the rest of the morning.
function seedMorningWithBurstyCall(db: Database.Database): void {
  putExternalSignal(db, DAY, 'calendar', {
    events: [{ title: 'Roadmap review', startClock: '10:00', durationMinutes: 60, attendeeCount: 4 }],
  } satisfies CalendarSignal)

  session(db, { app: 'Google Chrome', bundle: 'com.google.Chrome', category: 'browsing', from: at(9, 0), to: at(10, 4) })
  for (const [startMin, endMin] of [[4, 12], [20, 27], [35, 41], [50, 58]]) {
    session(db, { app: 'zoom.us', bundle: 'us.zoom.xos', category: 'meetings', from: at(10, startMin), to: at(10, endMin) })
    session(db, { app: 'Google Chrome', bundle: 'com.google.Chrome', category: 'browsing', from: at(10, endMin), to: at(10, endMin + 8) })
  }
  session(db, { app: 'Google Chrome', bundle: 'com.google.Chrome', category: 'browsing', from: at(11, 6), to: at(12, 0) })
}

test('meeting-app time inside a block dominated by other work still supports the meeting', () => {
  const db = createProductionTestDatabase()
  seedMorningWithBurstyCall(db)

  const payload = getTimelineDayPayload(db, DAY, null, { materialize: false })
  const scheduled = payload.scheduledMeetings ?? []
  const roadmap = scheduled.find((meeting) => meeting.title === 'Roadmap review')
  assert.ok(roadmap, 'the scheduled event rides the day payload')

  // The precondition that made this fail: no block of the morning is a meeting
  // block. If segmentation ever splits the Zoom bursts out, this test stops
  // testing what it claims to.
  const overlapping = payload.blocks.filter((block) =>
    Math.min(block.endTime, roadmap!.endMs) - Math.max(block.startTime, roadmap!.startMs) > 0)
  assert.ok(overlapping.length > 0, 'the scheduled hour is tracked')
  assert.ok(
    overlapping.every((block) => block.dominantCategory !== 'meetings'),
    'precondition: the bursts never form a meeting-dominant block',
  )

  assert.equal(roadmap!.attendance, 'matched', 'the captured Zoom time supports that the meeting happened')
  db.close()
})

test('a call the day recorded is never a question, however it landed in the blocks', () => {
  const db = createProductionTestDatabase()
  seedMorningWithBurstyCall(db)

  const payload = getTimelineDayPayload(db, DAY, null, { materialize: false })
  const questions = detectDayClarifications(db, payload, NEXT_MORNING).map((c) => c.question)
  assert.ok(
    !questions.some((q) => /Roadmap review/.test(q)),
    `must not ask about a call it captured: ${questions.join(' | ') || '(none)'}`,
  )
  db.close()
})

test('a scheduled meeting with no captured meeting time at all is still a question', () => {
  const db = createProductionTestDatabase()
  putExternalSignal(db, DAY, 'calendar', {
    events: [{ title: 'Partner call', startClock: '15:00', durationMinutes: 60, attendeeCount: 2 }],
  } satisfies CalendarSignal)
  // The morning is tracked; the 3pm hour is a hole — laptop shut, meeting taken
  // in a room or on a phone. Nothing here can settle it, so ask.
  session(db, { app: 'Google Chrome', bundle: 'com.google.Chrome', category: 'browsing', from: at(9, 0), to: at(11, 0) })

  const payload = getTimelineDayPayload(db, DAY, null, { materialize: false })
  const roadmap = (payload.scheduledMeetings ?? []).find((meeting) => meeting.title === 'Partner call')
  assert.equal(roadmap?.attendance, 'calendar_only', 'nothing supports attendance')

  const questions = detectDayClarifications(db, payload, NEXT_MORNING).map((c) => c.question)
  assert.ok(questions.some((q) => /Partner call/.test(q)), `the genuine blind spot is asked about: ${questions.join(' | ') || '(none)'}`)
  db.close()
})

test('a meeting documented by notes is not asked about, even with nothing captured', () => {
  const db = createProductionTestDatabase()
  putExternalSignal(db, DAY, 'calendar', {
    events: [{ title: 'Partner call', startClock: '15:00', durationMinutes: 60, attendeeCount: 2 }],
  } satisfies CalendarSignal)
  session(db, { app: 'Google Chrome', bundle: 'com.google.Chrome', category: 'browsing', from: at(9, 0), to: at(11, 0) })

  // Notes taken on a phone call: one of the spec's occurrence supports
  // (timeline.md §Meetings), and until now this path ignored them.
  const now = Date.now()
  db.prepare(`
    INSERT INTO connector_records
      (id, connector_id, source_record_id, kind, date, retrieved_at, permission_scope, envelope_json, created_at, updated_at)
    VALUES (?, 'granola', 'note:partner', 'meeting_record', ?, ?, 'local_file', ?, ?, ?)
  `).run(
    'rec-granola-partner', DAY, now,
    JSON.stringify({ notesSignal: { title: 'Partner call', scheduledClock: '15:00' } }),
    now, now,
  )

  const payload = getTimelineDayPayload(db, DAY, null, { materialize: false })
  const partner = (payload.scheduledMeetings ?? []).find((meeting) => meeting.title === 'Partner call')
  assert.equal(partner?.attendance, 'matched', 'the note documents that the meeting happened')
  assert.equal(partner?.matchedBlockId, null, 'note support claims no block and no observed time')

  const questions = detectDayClarifications(db, payload, NEXT_MORNING).map((c) => c.question)
  assert.ok(!questions.some((q) => /Partner call/.test(q)), `a documented meeting is not a question: ${questions.join(' | ')}`)
  db.close()
})
