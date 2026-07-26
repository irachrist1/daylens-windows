import test from 'node:test'
import assert from 'node:assert/strict'
import type { CalendarEventSignal } from '../src/shared/types.ts'
import {
  parseIcalBuddyLine,
  parseIcalBuddyOutput,
  parsePowerShellCalendarLine,
  parsePowerShellCalendarOutput,
  resolveIcalBuddyBinary,
} from '../src/main/services/calendarSignals.ts'

// The ASCII Unit Separator our icalBuddy invocation uses to join
// title/datetime/attendees onto one line per event (see -ps in
// calendarSignals.ts). Fixtures below mirror that exact wire format.
const SEP = '\x1f'

function icalLine(title: string, datetime: string, attendees?: string): string {
  const parts = [title, datetime]
  if (attendees !== undefined) parts.push(attendees)
  return parts.join(SEP)
}

// ─── icalBuddy line parsing ─────────────────────────────────────────────────

test('parses a simple timed event with attendees', () => {
  const line = icalLine('Standup', '09:00 - 09:15', 'Alice, Bob, Carol')
  const event = parseIcalBuddyLine(line)
  assert.ok(event)
  assert.equal(event!.title, 'Standup')
  assert.equal(event!.startClock, '9am')
  assert.equal(event!.durationMinutes, 15)
  assert.equal(event!.attendeeCount, 3)
})

test('an event with no attendees segment gets attendeeCount null', () => {
  const line = icalLine('Focus block', '13:00 - 14:30')
  const event = parseIcalBuddyLine(line)
  assert.ok(event)
  assert.equal(event!.title, 'Focus block')
  assert.equal(event!.startClock, '1pm')
  assert.equal(event!.durationMinutes, 90)
  assert.equal(event!.attendeeCount, null)
})

test('formats a non-hour start time as "11:15am" style (lowercase, no leading zero, no :00)', () => {
  const line = icalLine('Client call', '11:15 - 11:45', 'client@example.com')
  const event = parseIcalBuddyLine(line)
  assert.ok(event)
  assert.equal(event!.startClock, '11:15am')
})

test('a cross-noon event spans am to pm correctly', () => {
  const line = icalLine('Working lunch', '11:15 - 13:30', 'Dana')
  const event = parseIcalBuddyLine(line)
  assert.ok(event)
  assert.equal(event!.startClock, '11:15am')
  assert.equal(event!.durationMinutes, 135)
})

test('midnight and noon hour boundaries format as 12am/12pm', () => {
  const midnight = parseIcalBuddyLine(icalLine('Late one', '00:00 - 00:30'))
  const noon = parseIcalBuddyLine(icalLine('Lunch', '12:00 - 12:30'))
  assert.ok(midnight)
  assert.ok(noon)
  assert.equal(midnight!.startClock, '12am')
  assert.equal(noon!.startClock, '12pm')
})

test('a cross-midnight event adds 24h to the duration', () => {
  const line = icalLine('Overnight watch', '23:30 - 00:30')
  const event = parseIcalBuddyLine(line)
  assert.ok(event)
  assert.equal(event!.durationMinutes, 60)
})

test('an all-day event (no time range) is skipped', () => {
  // icalBuddy prints no usable HH:MM-HH:MM range for all-day events; we treat
  // that as "skip" rather than inventing a start time (see file header comment
  // for the documented decision).
  const line = icalLine('Company holiday', '')
  const event = parseIcalBuddyLine(line)
  assert.equal(event, null)
})

test('a junk / unparseable line returns null', () => {
  assert.equal(parseIcalBuddyLine('some random text with no structure'), null)
  assert.equal(parseIcalBuddyLine(''), null)
  assert.equal(parseIcalBuddyLine(SEP), null)
})

test('title is trimmed, whitespace-collapsed, and control characters stripped', () => {
  const line = icalLine('  Messy    Title  ', '10:00 - 10:30')
  const event = parseIcalBuddyLine(line)
  assert.ok(event)
  assert.equal(event!.title, 'Messy Title')
})

test('title longer than 120 chars is truncated with an ellipsis', () => {
  const longTitle = 'A'.repeat(200)
  const line = icalLine(longTitle, '10:00 - 10:30')
  const event = parseIcalBuddyLine(line)
  assert.ok(event)
  assert.equal(event!.title.length, 120)
  assert.ok(event!.title.endsWith('…'))
})

test('am/pm markers in the datetime segment are also handled', () => {
  const line = icalLine('Dentist', '2:00 PM - 3:00 PM')
  const event = parseIcalBuddyLine(line)
  assert.ok(event)
  assert.equal(event!.startClock, '2pm')
  assert.equal(event!.durationMinutes, 60)
})

// ─── icalBuddy full-output parsing ──────────────────────────────────────────

test('parses multiple events and drops junk/all-day lines from a full output block', () => {
  const output = [
    icalLine('Standup', '09:00 - 09:15', 'Alice, Bob'),
    '',
    'some stray warning line from a misbehaving tool',
    icalLine('Company holiday', ''), // all-day, skipped
    icalLine('1:1 with manager', '15:30 - 16:00'), // no attendees
  ].join('\n')

  // The stray warning line has no separator and no parseable time range, so
  // it is dropped along with the blank line and the all-day event.
  const events = parseIcalBuddyOutput(output)
  assert.equal(events.length, 2)
  assert.equal(events[0].title, 'Standup')
  assert.equal(events[0].attendeeCount, 2)
  assert.equal(events[1].title, '1:1 with manager')
  assert.equal(events[1].attendeeCount, null)
})

test('empty output produces an empty event list', () => {
  assert.deepEqual(parseIcalBuddyOutput(''), [])
  assert.deepEqual(parseIcalBuddyOutput('\n\n  \n'), [])
})

// ─── PowerShell (Windows/Outlook) line parsing ──────────────────────────────

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

// ─── resolveIcalBuddyBinary ──────────────────────────────────────────────────

test('resolveIcalBuddyBinary returns null when nothing on PATH or the known Homebrew locations exists', () => {
  // Hermetic: point PATH and the fallback dirs at nonexistent locations so
  // this never depends on whether the machine actually has icalBuddy.
  const binary = resolveIcalBuddyBinary({ PATH: '/nonexistent/scratch/dir' }, ['/nonexistent/homebrew'])
  assert.equal(binary, null)
})

// ─── Shape sanity ────────────────────────────────────────────────────────────

test('parsed events satisfy the CalendarEventSignal shape', () => {
  const event = parseIcalBuddyLine(icalLine('Shape check', '10:00 - 10:30', 'X, Y'))
  assert.ok(event)
  const typed: CalendarEventSignal = event!
  assert.equal(typeof typed.title, 'string')
  assert.equal(typeof typed.startClock, 'string')
  assert.equal(typeof typed.durationMinutes, 'number')
  assert.ok(typed.attendeeCount === null || typeof typed.attendeeCount === 'number')
})

// ─── Unavailable vs "ran, empty" (the scan-ledger contract) ──────────────────
// The scan ledger (externalSignals.ts) may only remember a day as "collected,
// empty" when a source actually ran. An unreachable source must THROW so a
// user who installs icalBuddy later can still enrich historical days.

import { collectCalendarEvents } from '../src/main/services/calendarSignals.ts'

const onMac = process.platform === 'darwin'

test('a missing icalBuddy binary throws — never "collected, empty"', { skip: !onMac }, async () => {
  await assert.rejects(collectCalendarEvents('2026-04-03', { resolveBinary: () => null }))
})

test('an icalBuddy subprocess failure throws — the day stays collectable', { skip: !onMac }, async () => {
  await assert.rejects(collectCalendarEvents('2026-04-03', {
    resolveBinary: () => '/fake/icalBuddy',
    run: async () => null, // execFileP resolves null on error/timeout
  }))
})

test('a successful run with zero events returns null: a real answer, safe to ledger', { skip: !onMac }, async () => {
  const result = await collectCalendarEvents('2026-04-03', {
    resolveBinary: () => '/fake/icalBuddy',
    run: async () => '',
  })
  assert.equal(result, null)
})

test('a malformed date never reaches a subprocess', async () => {
  const result = await collectCalendarEvents('not-a-date', {
    resolveBinary: () => { throw new Error('must not be called') },
  })
  assert.equal(result, null)
})
