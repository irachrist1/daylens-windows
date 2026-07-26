import test from 'node:test'
import assert from 'node:assert/strict'
import { renderTimeChunkAnswer, wantsTimeChunkTable } from '../src/main/agent/timeChunkAnswer.ts'

test('increment-shaped questions gate the deterministic chunk table', () => {
  const wantsTable = [
    'Break that hour into 10-minute increments',
    'split my day into half-hour segments',
    'show me Monday hour by hour',
    'hourly breakdown',
    'divide my afternoon into 15-minute buckets',
    'break down Tuesday in 30 minute blocks',
    // Follow-up refinement of a previous chunk answer.
    'make it 15-minute rows instead',
  ]
  for (const question of wantsTable) {
    assert.equal(wantsTimeChunkTable(question), true, `should want table: ${question}`)
  }
  const keepsProse = [
    'What was my longest uninterrupted focus block today, and what was I working on?',
    'What did I do on July 22?',
    'How long was I in meetings this week?',
    'Which sites am I leaking time on this week?',
  ]
  for (const question of keepsProse) {
    assert.equal(wantsTimeChunkTable(question), false, `should keep prose: ${question}`)
  }
})

test('time chunk answers preserve every exact row without merging gaps', () => {
  const answer = renderTimeChunkAnswer({
    found: true,
    date: '2026-07-06',
    incrementMinutes: 30,
    chunks: [
      { startTime: '03:30', endTime: '04:00', durationMinutes: 30, activity: [], pages: [], gap: { label: 'machine asleep/locked' } },
      { startTime: '04:00', endTime: '04:30', durationMinutes: 30, activity: [], pages: [], gap: { label: 'machine asleep/locked' } },
      { startTime: '04:30', endTime: '05:00', durationMinutes: 30, activity: [{ appName: 'Editor', windowTitle: 'Project review', seconds: 1800 }], pages: [], gap: null },
    ],
  })
  assert.ok(answer)
  assert.match(answer!, /Monday, July 6/)
  assert.match(answer!, /03:30–04:00/)
  assert.match(answer!, /04:00–04:30/)
  assert.match(answer!, /04:30–05:00/)
  assert.doesNotMatch(answer!, /03:30–04:30/)
})

test('time chunk answers hide internal action syntax and deduplicate activity', () => {
  const answer = renderTimeChunkAnswer({
    found: true,
    date: '2026-07-06',
    incrementMinutes: 30,
    chunks: [{
      startTime: '09:00',
      endTime: '09:30',
      durationMinutes: 30,
      activity: [
        { appName: 'Terminal', windowTitle: 'Wants to run AskUserQuestion: {"questions":[]}', seconds: 900 },
        { appName: 'Editor', windowTitle: 'Project review', seconds: 600 },
        { appName: 'Editor', windowTitle: 'Project review', seconds: 300 },
      ],
      pages: [],
      gap: null,
    }],
  })
  assert.ok(answer)
  assert.doesNotMatch(answer!, /AskUserQuestion|Wants to run/)
  assert.equal(answer!.match(/Editor: Project review/g)?.length, 1)
  // The voice contract bans em dashes in every surface, tables included.
  assert.doesNotMatch(answer!, /—/)
})

test('an em dash inside a window title never reaches the chunk table', () => {
  const answer = renderTimeChunkAnswer({
    found: true,
    date: '2026-07-24',
    incrementMinutes: 30,
    chunks: [{
      startTime: '15:00',
      endTime: '15:30',
      durationMinutes: 30,
      activity: [{ appName: 'Gemini', windowTitle: 'Gemini — Digital File Organization Strategy', seconds: 1800 }],
      pages: [],
      gap: null,
    }],
  })
  assert.ok(answer)
  assert.doesNotMatch(answer!, /—/)
  assert.match(answer!, /Gemini: Digital File Organization Strategy/)
})
