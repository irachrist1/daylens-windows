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
      { startTime: '03:30', endTime: '04:00', durationMinutes: 30, activity: [], pages: [], gap: { label: 'machine asleep/locked', kind: 'asleep' } },
      { startTime: '04:00', endTime: '04:30', durationMinutes: 30, activity: [], pages: [], gap: { label: 'machine asleep/locked', kind: 'asleep' } },
      { startTime: '04:30', endTime: '05:00', durationMinutes: 30, activity: [{ appName: 'Editor', windowTitle: 'Project review', seconds: 1800 }], pages: [], gap: null },
    ],
  })
  assert.ok(answer)
  assert.match(answer!, /Monday, July 6/)
  assert.match(answer!, /03:30–04:00/)
  assert.match(answer!, /04:00–04:30/)
  assert.match(answer!, /04:30–05:00/)
  assert.doesNotMatch(answer!, /03:30–04:30/)
  // Gaps describe the machine, never the person's attention.
  assert.match(answer!, /the machine was asleep or locked/)
  assert.doesNotMatch(answer!, /likely away|idle|distracted|productive/i)
})

test('time chunk answers hide internal action syntax and describe activity before the app', () => {
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
  // Activity first, apps as attribution. Terminal's internal title was
  // filtered, but Terminal was still open, so it trails with Editor.
  assert.match(answer!, /Project review \(Terminal and Editor\)/)
  assert.doesNotMatch(answer!, /Editor: Project review/)
  assert.equal(answer!.match(/Project review/g)?.length, 1)
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
  assert.match(answer!, /Digital File Organization Strategy/)
  assert.match(answer!, /\(Gemini\)/)
})

test('AC-VIC-001.4: a raw URL or tab-soup title is not the row description', () => {
  const answer = renderTimeChunkAnswer({
    found: true,
    date: '2026-08-01',
    incrementMinutes: 15,
    chunks: [{
      startTime: '10:00',
      endTime: '10:15',
      durationMinutes: 15,
      activity: [{ appName: 'Chrome', windowTitle: 'https://docs.example.dev/spec', seconds: 900 }],
      pages: [{ pageTitle: 'Inbox | Gmail | Unread (12) | Chrome' }],
      gap: null,
    }],
  })
  assert.ok(answer)
  assert.doesNotMatch(answer!, /https:\/\/docs\.example\.dev/)
  assert.doesNotMatch(answer!, /Inbox \| Gmail/)
  // App-only evidence: say what is known and the limit, once, without guessing.
  assert.match(answer!, /Chrome was open, and what they were used for was not captured/)
})

test('AC-VIC-001.3: a covering block label leads, apps trail as attribution', () => {
  const answer = renderTimeChunkAnswer({
    found: true,
    date: '2026-08-01',
    incrementMinutes: 30,
    chunks: [{
      startTime: '11:00',
      endTime: '11:30',
      durationMinutes: 30,
      blockLabel: 'Reworking the sync engine',
      activity: [
        { appName: 'Cursor', windowTitle: 'daylens — src/main/agent/timeChunkAnswer.ts', seconds: 1200 },
        { appName: 'Terminal', windowTitle: 'zsh', seconds: 300 },
      ],
      pages: [],
      gap: null,
    }],
  })
  assert.ok(answer)
  assert.match(answer!, /Reworking the sync engine \(/)
  assert.match(answer!, /Cursor/)
  // A filename-shaped window title and a bare shell name are not descriptions.
  assert.doesNotMatch(answer!, /timeChunkAnswer\.ts|\bzsh\b/)
  // Activity leads the cell; the app is not the subject.
  assert.doesNotMatch(answer!, /^\| 11:00–11:30 \| Cursor/m)
})

test('AC-VIC-004: a user-authored block label is kept even when it looks like raw telemetry', () => {
  const answer = renderTimeChunkAnswer({
    found: true,
    date: '2026-08-01',
    incrementMinutes: 30,
    chunks: [{
      startTime: '14:00',
      endTime: '14:30',
      durationMinutes: 30,
      // Person named the stretch themselves; the Timeline shows this verbatim.
      blockLabel: 'https://ridgeline.example/renewal',
      activity: [{ appName: 'Chrome', windowTitle: 'Dashboard', seconds: 1800 }],
      pages: [],
      gap: null,
    }],
  })
  assert.ok(answer)
  assert.match(answer!, /https:\/\/ridgeline\.example\/renewal/)
})

test('a generic floor label does not bury a captured window title', () => {
  const answer = renderTimeChunkAnswer({
    found: true,
    date: '2026-08-01',
    incrementMinutes: 30,
    chunks: [{
      startTime: '09:00',
      endTime: '09:30',
      durationMinutes: 30,
      blockLabel: 'Development',
      activity: [{ appName: 'Chrome', windowTitle: 'Implement OAuth callback validation', seconds: 1800 }],
      pages: [],
      gap: null,
    }],
  })
  assert.ok(answer)
  assert.doesNotMatch(answer!, /\bDevelopment\b/)
  assert.match(answer!, /Implement OAuth callback validation \(Chrome\)/)
})

test('an app-list floor label does not bury a captured window title', () => {
  const answer = renderTimeChunkAnswer({
    found: true,
    date: '2026-08-01',
    incrementMinutes: 30,
    chunks: [{
      startTime: '13:00',
      endTime: '13:30',
      durationMinutes: 30,
      blockLabel: 'Cursor and Chrome — activity',
      activity: [{ appName: 'Cursor', windowTitle: 'Rewrite the export queue retry', seconds: 1800 }],
      pages: [],
      gap: null,
    }],
  })
  assert.ok(answer)
  assert.doesNotMatch(answer!, /— activity/)
  assert.match(answer!, /Rewrite the export queue retry \(Cursor\)/)
})

test('a category floor outside the generic list still yields to the title', () => {
  const answer = renderTimeChunkAnswer({
    found: true,
    date: '2026-08-01',
    incrementMinutes: 30,
    chunks: [{
      startTime: '20:00',
      endTime: '20:30',
      durationMinutes: 30,
      blockLabel: 'Entertainment',
      activity: [{ appName: 'Chrome', windowTitle: 'Chelsea vs Arsenal highlights', seconds: 1800 }],
      pages: [],
      gap: null,
    }],
  })
  assert.ok(answer)
  assert.doesNotMatch(answer!, /\bEntertainment\b/)
  assert.match(answer!, /Chelsea vs Arsenal highlights \(Chrome\)/)
})

test('AC-VIC-003.1 / AC-VIC-003.2: idle gaps never judge the person', () => {
  const answer = renderTimeChunkAnswer({
    found: true,
    date: '2026-08-01',
    incrementMinutes: 30,
    chunks: [
      { startTime: '12:00', endTime: '12:30', durationMinutes: 30, activity: [], pages: [], gap: { kind: 'idle', label: 'no activity captured, likely away or idle' } },
      { startTime: '12:30', endTime: '13:00', durationMinutes: 30, activity: [], pages: [], gap: { kind: 'untracked', label: 'no data captured, possibly a tracking failure' } },
      { startTime: '13:00', endTime: '13:30', durationMinutes: 30, activity: [], pages: [], gap: { kind: 'locked', label: 'machine locked' } },
    ],
  })
  assert.ok(answer)
  assert.match(answer!, /nothing was captured here/)
  assert.match(answer!, /tracking stopped/)
  assert.match(answer!, /the machine was locked/)
  assert.doesNotMatch(answer!, /likely away|idle|distracted|productive|wasted|slacking/i)
})
