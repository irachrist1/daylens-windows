import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { putExternalSignal } from '../src/main/services/externalSignals.ts'
import { resolveDayEnrichment } from '../src/main/services/enrichmentResolve.ts'
import type { CalendarSignal, FocusAppSignal, GitActivitySignal } from '../src/shared/types.ts'

// resolveDayEnrichment: stored connector signals → the sanitized,
// humanized, pre-formatted shape the wrap WRITER sees. Never a raw path/branch,
// never a clock, null when a connector had nothing.

const DATE = '2026-07-06'

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE external_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL, source TEXT NOT NULL,
      payload_json TEXT NOT NULL, captured_at INTEGER NOT NULL,
      UNIQUE(date, source)
    );
  `)
  return db
}

test('git resolves to humanized project names, counts, and sanitized highlights', () => {
  const db = makeDb()
  const git: GitActivitySignal = {
    repos: [
      { repo: 'billing-service', commitCount: 9, messages: ['feat: add invoice export', 'fix the parser in src/main/parse.ts'], firstCommitClock: '9am', lastCommitClock: '4pm' },
      { repo: 'daylens', commitCount: 2, messages: ['chore(deps): bump on branch feature/x'], firstCommitClock: '1pm', lastCommitClock: '2pm' },
    ],
    totalCommits: 11,
    prs: [{ title: 'Add the export button', state: 'open', repo: 'billing-service' }],
  }
  putExternalSignal(db, DATE, 'git', git)

  const enrichment = resolveDayEnrichment(db, DATE)
  assert.ok(enrichment?.shipped)
  const shipped = enrichment!.shipped!
  assert.deepEqual(shipped.commitsByProject[0], { project: 'billing service', commits: 9, spread: null, viaAgents: null })
  assert.equal(shipped.pullRequests[0].project, 'billing service')
  assert.equal(shipped.pullRequests[0].state, 'open')
  // Conventional prefixes stripped, paths/branches gone from highlights.
  const joined = shipped.highlights.join(' | ')
  assert.ok(!/src\/main/.test(joined), `no path in highlights: ${joined}`)
  assert.ok(!/feature\//.test(joined), `no branch in highlights: ${joined}`)
  assert.ok(!/^feat:|^fix:|^chore/.test(joined), `conventional prefix stripped: ${joined}`)
  assert.ok(joined.toLowerCase().includes('add invoice export'))
  db.close()
})

test('calendar resolves to count + titled items with pre-formatted durations', () => {
  const db = makeDb()
  const calendar: CalendarSignal = {
    events: [
      { title: 'Standup', startClock: '9am', durationMinutes: 15, attendeeCount: 5 },
      { title: 'Design review', startClock: '2pm', durationMinutes: 75, attendeeCount: 3 },
    ],
  }
  putExternalSignal(db, DATE, 'calendar', calendar)

  const enrichment = resolveDayEnrichment(db, DATE)
  assert.ok(enrichment?.meetings)
  assert.equal(enrichment!.meetings!.count, 2)
  // Longest first, duration pre-formatted, no attendee count leaks through.
  assert.equal(enrichment!.meetings!.items[0].title, 'Design review')
  assert.equal(enrichment!.meetings!.items[0].scheduled, '1h 15m')
  assert.equal(enrichment!.meetings!.items[1].scheduled, '15m')
  assert.ok(!('attendeeCount' in enrichment!.meetings!.items[0]))
  db.close()
})

test('focus with timed sessions resolves only when the app is enabled', () => {
  const db = makeDb()
  const timed: FocusAppSignal[] = [{ app: 'Session', sessions: [{ startClock: '9am', durationMinutes: 50, label: null }, { startClock: '11am', durationMinutes: 25, label: null }] }]
  putExternalSignal(db, DATE, 'focus_app', timed)

  // Enabled: surfaces the barest block.
  const withFocus = resolveDayEnrichment(db, DATE, { focusEnabled: () => true })
  assert.deepEqual(withFocus?.focusSessions, { tool: 'Session', sessions: 2, focused: '1h 15m' })

  // A since-disabled app never surfaces, even with a stale stored row.
  const disabled = resolveDayEnrichment(db, DATE, { focusEnabled: () => false })
  assert.equal(disabled, null)

  // Presence with no readable durations (Raycast, encrypted) yields null focus.
  const presenceOnly: FocusAppSignal[] = [{ app: 'Raycast Focus', sessions: [] }]
  putExternalSignal(db, DATE, 'focus_app', presenceOnly)
  const noFocus = resolveDayEnrichment(db, DATE, { focusEnabled: () => true })
  assert.equal(noFocus, null)
  db.close()
})

test('a malformed stored row never throws — enrichment resolves to null', () => {
  const db = makeDb()
  putExternalSignal(db, DATE, 'focus_app', { not: 'an array' })
  putExternalSignal(db, DATE, 'git', { repos: 'nope', prs: null })
  assert.equal(resolveDayEnrichment(db, DATE, { focusEnabled: () => true }), null)
  db.close()
})

test('meeting titles with a path or clock time are sanitized before the prompt', () => {
  const db = makeDb()
  putExternalSignal(db, DATE, 'calendar', {
    events: [
      { title: 'Review src/main/services/gitSignals.ts at 2pm', startClock: '2pm', durationMinutes: 30, attendeeCount: 2 },
      { title: '1:1 with Sarah', startClock: '3pm', durationMinutes: 30, attendeeCount: 1 },
    ],
  })
  const enrichment = resolveDayEnrichment(db, DATE, { focusEnabled: () => false })
  const titles = enrichment!.meetings!.items.map((i) => i.title).join(' | ')
  assert.ok(!/src\/main/.test(titles), `no path leaks: ${titles}`)
  assert.ok(!/2pm/.test(titles), `no clock leaks: ${titles}`)
  // A clean personal title survives with full detail.
  assert.ok(titles.includes('1:1 with Sarah'))
  db.close()
})

test('a day with no stored signals resolves to null (never invented)', () => {
  const db = makeDb()
  assert.equal(resolveDayEnrichment(db, DATE), null)
  db.close()
})

// notes connector (bridge read-side): a stored 'notes' signal resolves into a
// sanitized meetingNotes block — first names only, no emails, action items kept.
import type { MeetingNotesSignal } from '../src/shared/types.ts'

test('notes: a stored notes signal resolves into sanitized meetingNotes', () => {
  const db = makeDb()
  const notes: MeetingNotesSignal = {
    app: 'Granola',
    notes: [
      {
        title: 'Andersen Weekly AI Training',
        participants: ['Norman', 'catherine@alueducation.com', 'Husna Doe'],
        actionItems: ['agreed to revise the onboarding timeline', 'follow up on the model comparison in src/eval/run.ts'],
      },
    ],
  }
  putExternalSignal(db, DATE, 'notes', notes)

  const enrichment = resolveDayEnrichment(db, DATE, { focusEnabled: () => false, notesEnabled: true })
  const mn = enrichment!.meetingNotes!
  assert.equal(mn.app, 'Granola')
  assert.equal(mn.items[0].title, 'Andersen Weekly AI Training')
  // First names only, email refused, surname dropped.
  assert.deepEqual(mn.items[0].participants, ['Norman', 'Husna'])
  // Action items kept, but the path stripped from the second one.
  const joined = mn.items[0].actionItems.join(' | ')
  assert.ok(joined.includes('revise the onboarding timeline'))
  assert.ok(!/src\/eval/.test(joined), `no path leaks in action items: ${joined}`)
  db.close()
})

test('notes: the off-switch suppresses a stored notes signal', () => {
  const db = makeDb()
  putExternalSignal(db, DATE, 'notes', { app: 'Granola', notes: [{ title: 'Standup', participants: [], actionItems: ['ship it'] }] } as MeetingNotesSignal)
  const off = resolveDayEnrichment(db, DATE, { focusEnabled: () => false, notesEnabled: false })
  assert.equal(off, null, 'disabled notes source never surfaces')
  db.close()
})
