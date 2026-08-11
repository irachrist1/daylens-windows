import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import type { AppCategory, DayTimelinePayload, WorkContextBlock } from '../src/shared/types.ts'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { DEFAULT_TIMELINE_BLOCK_REVIEW } from '../src/shared/timelineReview.ts'
import {
  detectDayClarifications,
  applyClarificationAnswer,
  getSkippedClarificationIds,
} from '../src/main/services/dayClarifications.ts'
import { getMeetingAttendanceMarks } from '../src/main/services/meetingResolution.ts'
import { materializeTimelineDayProjection } from '../src/main/core/query/projections.ts'
import { getBlockLabelOverride } from '../src/main/db/queries.ts'

// The day-analysis agent asks a material question only when evidence leaves it
// open, the person can answer or skip, an answer is a durable correction, and a
// skip is never re-asked.

const DAY = '2026-04-22'
const base = new Date('2026-04-22T09:00:00').getTime()

function block(opts: { id: string; label: string; startMin: number; durationMin: number; category?: AppCategory }): WorkContextBlock {
  const start = base + opts.startMin * 60_000
  const durationSeconds = opts.durationMin * 60
  return {
    id: opts.id,
    startTime: start,
    endTime: start + durationSeconds * 1000,
    kind: 'work',
    dominantCategory: opts.category ?? 'development',
    categoryDistribution: {},
    ruleBasedLabel: opts.label,
    aiLabel: null,
    sessions: [{ id: 1, startTime: start, endTime: start + durationSeconds * 1000, durationSeconds } as WorkContextBlock['sessions'][number]],
    topApps: [],
    websites: [],
    keyPages: [],
    pageRefs: [],
    documentRefs: [],
    topArtifacts: [],
    workflowRefs: [],
    label: { current: opts.label, source: 'rule', confidence: 0.5, narrative: null, ruleBased: opts.label, aiSuggested: null, override: null },
    focusOverlap: { totalSeconds: durationSeconds, pct: 100, sessionIds: [] },
    evidenceSummary: { apps: [], pages: [], documents: [], domains: [] },
    heuristicVersion: 'test',
    computedAt: start,
    switchCount: 0,
    confidence: 'high',
    review: { ...DEFAULT_TIMELINE_BLOCK_REVIEW, state: 'auto-approved' },
    isLive: false,
    provisional: false,
  }
}

function payloadWith(blocks: WorkContextBlock[], scheduledMeetings: DayTimelinePayload['scheduledMeetings'] = undefined): DayTimelinePayload {
  return {
    date: DAY, sessions: [], websites: [], blocks, segments: [], focusSessions: [],
    computedAt: Date.now(), version: 'test',
    totalSeconds: blocks.reduce((s, b) => s + Math.round((b.endTime - b.startTime) / 1000), 0),
    focusSeconds: 0, focusPct: 0, appCount: 0, siteCount: 0,
    scheduledMeetings,
  }
}

test('asks about a substantial unnamed block and an unconfirmed meeting, most-material first', () => {
  const db = createProductionTestDatabase()
  const payload = payloadWith(
    [
      block({ id: 'blk_named', label: 'Shipping the recap agent', startMin: 0, durationMin: 90 }),
      block({ id: 'blk_unnamed', label: 'Development', startMin: 120, durationMin: 60 }),
      block({ id: 'blk_short', label: 'Development', startMin: 200, durationMin: 10 }),
    ],
    [
      // Over empty time — nothing tracked proves or disproves it, so it is a
      // real question. A meeting inside tracked hours is gated (DEV-284).
      { title: 'Standup', startMs: base + 7 * 3_600_000, endMs: base + 7.5 * 3_600_000, attendeeCount: 3, participants: [], attendance: 'calendar_only', marked: null, matchedBlockId: null },
      { title: 'Already tracked', startMs: base + 3 * 3_600_000, endMs: base + 3.5 * 3_600_000, attendeeCount: 2, participants: [], attendance: 'matched', marked: null, matchedBlockId: 'x' },
    ],
  )

  const clarifications = detectDayClarifications(db, payload)
  const kinds = clarifications.map((c) => c.kind)
  // The named block, the 10-minute block, and the already-tracked meeting are not asked about.
  assert.equal(clarifications.length, 2, `capped at 2 material questions, got ${clarifications.length}`)
  assert.ok(kinds.includes('unnamed-block'), 'asks about the 60m unnamed block')
  assert.ok(kinds.includes('unconfirmed-meeting'), 'asks about the unconfirmed meeting')
  // Most material first: the 60m block outweighs the 30m meeting.
  assert.equal(clarifications[0].kind, 'unnamed-block')
  const meeting = clarifications.find((c) => c.kind === 'unconfirmed-meeting')!
  assert.match(meeting.question, /Standup/)
  assert.ok(meeting.eventKey, 'meeting clarification carries the attendance event key')
  db.close()
})

test('DEV-284: a meeting during hours the person clearly worked through is never asked about', () => {
  const db = createProductionTestDatabase()
  // The July 22 shape: "Deep work (1:00–2:30)" scheduled inside a tracked
  // block running 12:34–2:42. The activity already tells the story.
  const payload = payloadWith(
    [block({ id: 'blk_work', label: 'Shipping the recap agent', startMin: 0, durationMin: 240 })],
    [
      { title: 'Deep work', startMs: base + 30 * 60_000, endMs: base + 120 * 60_000, attendeeCount: null, participants: [], attendance: 'calendar_only', marked: null, matchedBlockId: null },
      // Only a sliver overlaps tracked time — still a genuine open question.
      { title: 'Evening sync', startMs: base + 230 * 60_000, endMs: base + 290 * 60_000, attendeeCount: 2, participants: [], attendance: 'calendar_only', marked: null, matchedBlockId: null },
    ],
  )
  const clarifications = detectDayClarifications(db, payload)
  const questions = clarifications.map((c) => c.question)
  assert.ok(!questions.some((q) => /Deep work/.test(q)), `must not ask about a worked-through window: ${questions.join(' | ')}`)
  assert.ok(questions.some((q) => /Evening sync/.test(q)), 'a mostly-uncovered meeting still gets its question')
  db.close()
})

test('a meeting that has not happened yet is never asked about', () => {
  const db = createProductionTestDatabase()
  // 10am, looking at a day whose calendar runs to the evening. The 3pm is
  // hours away: there is trivially no evidence for it, and "were you in it?"
  // has no honest answer yet.
  const tenAm = base + 60 * 60_000
  const payload = payloadWith([], [
    { title: 'Build at the Table', startMs: base + 6 * 3_600_000, endMs: base + 9.5 * 3_600_000, attendeeCount: 4, participants: [], attendance: 'calendar_only', marked: null, matchedBlockId: null },
    { title: 'Morning sync', startMs: base - 2 * 3_600_000, endMs: base - 1.5 * 3_600_000, attendeeCount: 3, participants: [], attendance: 'calendar_only', marked: null, matchedBlockId: null },
  ])

  const questions = detectDayClarifications(db, payload, tenAm).map((c) => c.question)
  assert.ok(!questions.some((q) => /Build at the Table/.test(q)), `must not ask about a meeting still ahead: ${questions.join(' | ')}`)
  assert.ok(questions.some((q) => /Morning sync/.test(q)), 'a meeting that already ended is still asked about')

  // Same payload, same person, after the meeting is over: now it is a fair question.
  const afterwards = detectDayClarifications(db, payload, base + 10 * 3_600_000).map((c) => c.question)
  assert.ok(afterwards.some((q) => /Build at the Table/.test(q)), 'once it has ended the question appears')
  db.close()
})

test('a meeting in progress, and one that just ended, are not asked about yet', () => {
  const db = createProductionTestDatabase()
  const meetingEnd = base + 60 * 60_000
  const payload = payloadWith([], [
    { title: 'Standup', startMs: base, endMs: meetingEnd, attendeeCount: 3, participants: [], attendance: 'calendar_only', marked: null, matchedBlockId: null },
  ])
  const asked = (nowMs: number) => detectDayClarifications(db, payload, nowMs).length

  assert.equal(asked(base + 30 * 60_000), 0, 'never asks about a meeting the person is sitting in')
  assert.equal(asked(meetingEnd), 0, 'the tail of the call has not been flushed into the facts yet')
  assert.equal(asked(meetingEnd + 5 * 60_000), 0, 'still inside the grace window')
  assert.equal(asked(meetingEnd + 11 * 60_000), 1, 'past the grace window the question is fair')
  db.close()
})

test('a skipped question is remembered and never re-asked', () => {
  const db = createProductionTestDatabase()
  const payload = payloadWith([block({ id: 'blk_unnamed', label: 'Development', startMin: 0, durationMin: 60 })])
  const [first] = detectDayClarifications(db, payload)
  assert.ok(first)

  applyClarificationAnswer(db, DAY, { id: first.id, kind: first.kind, action: 'skip' })
  assert.ok(getSkippedClarificationIds(db, DAY).has(first.id))
  assert.equal(detectDayClarifications(db, payload).length, 0, 'the skipped question does not come back')
  db.close()
})

test('answering an unconfirmed meeting writes a durable attendance mark', () => {
  const db = createProductionTestDatabase()
  const payload = payloadWith([], [
    { title: 'Deep work', startMs: base, endMs: base + 60 * 60_000, attendeeCount: null, participants: [], attendance: 'calendar_only', marked: null, matchedBlockId: null },
  ])
  const [clarification] = detectDayClarifications(db, payload)
  assert.equal(clarification.kind, 'unconfirmed-meeting')

  applyClarificationAnswer(db, DAY, {
    id: clarification.id, kind: 'unconfirmed-meeting', action: 'answer',
    eventKey: clarification.eventKey, attendance: 'attended',
  })
  assert.equal(getMeetingAttendanceMarks(db, DAY).get(clarification.eventKey!), 'attended')
  db.close()
})

test('answering an unnamed block writes a durable label correction', () => {
  const db = createProductionTestDatabase()
  // Seed a real day so the answer can anchor its review on a real block.
  const start = base
  db.prepare(`
    INSERT INTO app_sessions (bundle_id, app_name, start_time, end_time, duration_sec, category, is_focused, window_title, raw_app_name, capture_source, capture_version)
    VALUES ('com.mitchellh.ghostty', 'Ghostty', ?, ?, 3300, 'development', 1, 'work', 'Ghostty', 'test', 1)
  `).run(start, start + 3_300_000)
  const analyzed = materializeTimelineDayProjection(db, DAY, null).blocks.filter((b) => !b.isLive)
  assert.ok(analyzed.length >= 1)
  const target = analyzed[0]

  applyClarificationAnswer(db, DAY, {
    id: `${DAY}:block:${target.id}`, kind: 'unnamed-block', action: 'answer',
    blockId: target.id, label: 'Rewrote the capture relay',
  })
  assert.equal(getBlockLabelOverride(db, target.id)?.label, 'Rewrote the capture relay')
  db.close()
})
