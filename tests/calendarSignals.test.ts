import test from 'node:test'
import assert from 'node:assert/strict'
import type { CalendarEventSignal } from '../src/shared/types.ts'
import {
  collectCalendarEvents,
  parseEventKitHelperEvent,
  parseEventKitHelperOutput,
  parsePowerShellCalendarLine,
  parsePowerShellCalendarOutput,
  resolveCalendarHelperBinary,
} from '../src/main/services/calendarSignals.ts'

function helperOk(events: unknown[]): string {
  return JSON.stringify({ ok: true, events })
}

function helperEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Standup',
    startHour: 9,
    startMinute: 0,
    durationMinutes: 15,
    attendeeCount: 3,
    ...overrides,
  }
}

// ─── EventKit helper event parsing ──────────────────────────────────────────

test('parses a simple timed EventKit event with attendees', () => {
  const event = parseEventKitHelperEvent(helperEvent())
  assert.ok(event)
  assert.equal(event!.title, 'Standup')
  assert.equal(event!.startClock, '9am')
  assert.equal(event!.durationMinutes, 15)
  assert.equal(event!.attendeeCount, 3)
})

test('an EventKit event with null attendees gets attendeeCount null', () => {
  const event = parseEventKitHelperEvent(helperEvent({
    title: 'Focus block',
    startHour: 13,
    startMinute: 0,
    durationMinutes: 90,
    attendeeCount: null,
  }))
  assert.ok(event)
  assert.equal(event!.title, 'Focus block')
  assert.equal(event!.startClock, '1pm')
  assert.equal(event!.durationMinutes, 90)
  assert.equal(event!.attendeeCount, null)
})

test('formats a non-hour start time as "11:15am" style', () => {
  const event = parseEventKitHelperEvent(helperEvent({
    title: 'Client call',
    startHour: 11,
    startMinute: 15,
    durationMinutes: 30,
    attendeeCount: 1,
  }))
  assert.ok(event)
  assert.equal(event!.startClock, '11:15am')
})

test('midnight and noon hour boundaries format as 12am/12pm', () => {
  const midnight = parseEventKitHelperEvent(helperEvent({
    title: 'Late one',
    startHour: 0,
    startMinute: 0,
    durationMinutes: 30,
    attendeeCount: null,
  }))
  const noon = parseEventKitHelperEvent(helperEvent({
    title: 'Lunch',
    startHour: 12,
    startMinute: 0,
    durationMinutes: 30,
    attendeeCount: null,
  }))
  assert.ok(midnight)
  assert.ok(noon)
  assert.equal(midnight!.startClock, '12am')
  assert.equal(noon!.startClock, '12pm')
})

test('title is trimmed, whitespace-collapsed, and control characters stripped', () => {
  const event = parseEventKitHelperEvent(helperEvent({
    title: '  Messy    Title\u0007  ',
    startHour: 10,
    startMinute: 0,
    durationMinutes: 30,
    attendeeCount: null,
  }))
  assert.ok(event)
  assert.equal(event!.title, 'Messy Title')
})

test('title longer than 120 chars is truncated with an ellipsis', () => {
  const event = parseEventKitHelperEvent(helperEvent({
    title: 'A'.repeat(200),
    startHour: 10,
    startMinute: 0,
    durationMinutes: 30,
    attendeeCount: null,
  }))
  assert.ok(event)
  assert.equal(event!.title.length, 120)
  assert.ok(event!.title.endsWith('…'))
})

test('an EventKit event with a bad hour, minute, or duration is dropped', () => {
  assert.equal(parseEventKitHelperEvent(helperEvent({ startHour: 24 })), null)
  assert.equal(parseEventKitHelperEvent(helperEvent({ startMinute: 60 })), null)
  assert.equal(parseEventKitHelperEvent(helperEvent({ durationMinutes: -1 })), null)
  assert.equal(parseEventKitHelperEvent(helperEvent({ title: '' })), null)
  assert.equal(parseEventKitHelperEvent('not an object'), null)
})

// ─── EventKit helper output parsing ─────────────────────────────────────────

test('parses multiple EventKit events and drops junk from a successful payload', () => {
  const output = helperOk([
    helperEvent(),
    { title: 'Broken', startHour: 'nope' },
    helperEvent({
      title: '1:1 with manager',
      startHour: 15,
      startMinute: 30,
      durationMinutes: 30,
      attendeeCount: null,
    }),
  ])
  const events = parseEventKitHelperOutput(output)
  assert.equal(events.length, 2)
  assert.equal(events[0].title, 'Standup')
  assert.equal(events[0].attendeeCount, 3)
  assert.equal(events[1].title, '1:1 with manager')
  assert.equal(events[1].attendeeCount, null)
})

test('empty EventKit events produce an empty list', () => {
  assert.deepEqual(parseEventKitHelperOutput(helperOk([])), [])
})

test('a denied or failed EventKit helper payload throws', () => {
  assert.throws(
    () => parseEventKitHelperOutput(JSON.stringify({ ok: false, error: 'calendar_access_denied' })),
    /calendar_access_denied/,
  )
  assert.throws(
    () => parseEventKitHelperOutput('not-json'),
    /invalid JSON/,
  )
  assert.throws(
    () => parseEventKitHelperOutput(JSON.stringify({ ok: true })),
    /events missing/,
  )
})

// ─── PowerShell (Windows/Outlook fallback) line parsing ─────────────────────

test('parses a well-formed PowerShell line', () => {
  const line = ['Design review', '14:00', '45', '4'].join('\t')
  const event = parsePowerShellCalendarLine(line)
  assert.ok(event)
  assert.equal(event!.title, 'Design review')
  assert.equal(event!.startClock, '2pm')
  assert.equal(event!.durationMinutes, 45)
  assert.equal(event!.attendeeCount, 4)
})

test('a zero-recipient PowerShell line reports attendeeCount 0, not null', () => {
  const line = ['Solo prep time', '08:00', '30', '0'].join('\t')
  const event = parsePowerShellCalendarLine(line)
  assert.ok(event)
  assert.equal(event!.attendeeCount, 0)
})

test('a PowerShell line missing fields is dropped', () => {
  assert.equal(parsePowerShellCalendarLine('Missing fields\t14:00'), null)
  assert.equal(parsePowerShellCalendarLine(''), null)
})

test('a PowerShell line with a malformed time or duration is dropped', () => {
  assert.equal(parsePowerShellCalendarLine(['Bad time', 'not-a-time', '30', '2'].join('\t')), null)
  assert.equal(parsePowerShellCalendarLine(['Bad duration', '14:00', 'oops', '2'].join('\t')), null)
})

test('parses a full PowerShell output block, dropping malformed lines', () => {
  const output = [
    ['Standup', '09:00', '15', '5'].join('\t'),
    'not tab separated at all',
    ['1:1', '11:15', '30', '1'].join('\t'),
  ].join('\n')

  const events = parsePowerShellCalendarOutput(output)
  assert.equal(events.length, 2)
  assert.equal(events[0].title, 'Standup')
  assert.equal(events[1].startClock, '11:15am')
})

// ─── resolveCalendarHelperBinary ────────────────────────────────────────────

test('resolveCalendarHelperBinary returns null when no candidate exists', () => {
  const binary = resolveCalendarHelperBinary(['/nonexistent/calendar-helper'])
  assert.equal(binary, null)
})

// ─── Shape sanity ────────────────────────────────────────────────────────────

test('parsed EventKit events satisfy the CalendarEventSignal shape', () => {
  const event = parseEventKitHelperEvent(helperEvent({ title: 'Shape check', attendeeCount: 2 }))
  assert.ok(event)
  const typed: CalendarEventSignal = event!
  assert.equal(typeof typed.title, 'string')
  assert.equal(typeof typed.startClock, 'string')
  assert.equal(typeof typed.durationMinutes, 'number')
  assert.ok(typed.attendeeCount === null || typeof typed.attendeeCount === 'number')
})

// ─── Unavailable vs "ran, empty" (the scan-ledger contract) ──────────────────
// The scan ledger may only remember a day as "collected, empty" when a source
// actually ran. An unreachable EventKit helper or a denied Calendar grant must
// THROW so a later grant can still enrich historical days.

test('a missing EventKit helper throws — never "collected, empty"', async () => {
  await assert.rejects(collectCalendarEvents('2026-04-03', {
    platform: 'darwin',
    resolveHelper: () => null,
  }))
})

test('an EventKit helper subprocess failure throws — the day stays collectable', async () => {
  await assert.rejects(collectCalendarEvents('2026-04-03', {
    platform: 'darwin',
    resolveHelper: () => '/fake/calendar-helper',
    run: async () => null,
  }))
})

test('a denied Calendar grant throws — the day stays collectable', async () => {
  await assert.rejects(collectCalendarEvents('2026-04-03', {
    platform: 'darwin',
    resolveHelper: () => '/fake/calendar-helper',
    run: async () => JSON.stringify({ ok: false, error: 'calendar_access_denied' }),
  }))
})

test('a successful EventKit run with zero events returns null: a real answer, safe to ledger', async () => {
  const result = await collectCalendarEvents('2026-04-03', {
    platform: 'darwin',
    resolveHelper: () => '/fake/calendar-helper',
    run: async () => helperOk([]),
  })
  assert.equal(result, null)
})

test('a successful EventKit run returns the mapped signal', async () => {
  const result = await collectCalendarEvents('2026-04-03', {
    platform: 'darwin',
    resolveHelper: () => '/fake/calendar-helper',
    run: async (_cmd, args) => {
      assert.deepEqual(args, ['2026-04-03'])
      return helperOk([helperEvent()])
    },
  })
  assert.ok(result)
  assert.equal(result!.events.length, 1)
  assert.equal(result!.events[0].title, 'Standup')
  assert.equal(result!.events[0].startClock, '9am')
})

test('Linux has no calendar store and returns null without touching a helper', async () => {
  const result = await collectCalendarEvents('2026-04-03', {
    platform: 'linux',
    resolveHelper: () => { throw new Error('must not be called') },
  })
  assert.equal(result, null)
})

test('a malformed date never reaches a subprocess', async () => {
  const result = await collectCalendarEvents('not-a-date', {
    platform: 'darwin',
    resolveHelper: () => { throw new Error('must not be called') },
  })
  assert.equal(result, null)
})
