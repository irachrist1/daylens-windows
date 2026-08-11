import test from 'node:test'
import assert from 'node:assert/strict'
import { blockActiveSeconds, blockDisplayedSpanSeconds } from '../src/shared/blockDuration.ts'
import type { AppSession } from '../src/shared/types.ts'

// Synthesize timestamps at known second offsets within a fixed minute.
function minuteMs(hour: number, minute: number, second = 0): number {
  // A fixed date and UTC offset so the math is deterministic.
  const base = Date.UTC(2026, 4, 13, hour, minute, second)
  return base
}

test('displayed span matches the truncated clock range — 8:55:23 → 9:09:48 reads as 14m', () => {
  const block = { startTime: minuteMs(8, 55, 23), endTime: minuteMs(9, 9, 48) }
  // Clock displays "8:55" and "9:09"; user math: 14 minutes.
  assert.equal(blockDisplayedSpanSeconds(block), 14 * 60)
})

test('displayed span on whole-minute boundaries — 9:00:00 → 9:30:00 reads as 30m', () => {
  const block = { startTime: minuteMs(9, 0, 0), endTime: minuteMs(9, 30, 0) }
  assert.equal(blockDisplayedSpanSeconds(block), 30 * 60)
})

test('displayed span ignores sub-second drift — 9:00:00.500 → 9:01:00.500 reads as 1m', () => {
  const block = {
    startTime: minuteMs(9, 0, 0) + 500,
    endTime: minuteMs(9, 1, 0) + 500,
  }
  assert.equal(blockDisplayedSpanSeconds(block), 60)
})

test('displayed span floors to 1 second when start and end share a minute', () => {
  const block = { startTime: minuteMs(9, 0, 10), endTime: minuteMs(9, 0, 50) }
  // Both round to "9:00" on the clock; avoid emitting "0m" next to the range.
  assert.equal(blockDisplayedSpanSeconds(block), 1)
})

function session(startTime: number, endTime: number, durationSeconds: number): AppSession {
  return {
    id: 1,
    bundleId: 'com.example.app',
    appName: 'Example',
    startTime,
    endTime,
    durationSeconds,
    category: 'development',
    isFocused: true,
  }
}

test('active seconds sum the sessions', () => {
  const block = {
    startTime: minuteMs(9, 0),
    endTime: minuteMs(9, 30),
    sessions: [
      session(minuteMs(9, 0), minuteMs(9, 10), 10 * 60),
      session(minuteMs(9, 12), minuteMs(9, 30), 18 * 60),
    ],
  }
  assert.equal(blockActiveSeconds(block), 28 * 60)
})

test('an inflated session duration is clamped to its own span', () => {
  const block = {
    startTime: minuteMs(9, 0),
    endTime: minuteMs(9, 20),
    sessions: [session(minuteMs(9, 0), minuteMs(9, 20), 25 * 60)],
  }
  assert.equal(blockActiveSeconds(block), 20 * 60)
})

test('a block whose sessions carry no time reads as the 1-second floor, not its span', () => {
  const block = {
    startTime: minuteMs(9, 0),
    endTime: minuteMs(11, 0),
    sessions: [session(minuteMs(9, 0), minuteMs(9, 30), 0)],
  }
  assert.equal(blockActiveSeconds(block), 1)
})

test('merging never changes the total even when one side has zero-duration sessions', () => {
  const zeroSide = [session(minuteMs(9, 0), minuteMs(9, 30), 0)]
  const realSide = [session(minuteMs(10, 0), minuteMs(10, 45), 45 * 60)]
  const separate =
    blockActiveSeconds({ startTime: minuteMs(9, 0), endTime: minuteMs(9, 30), sessions: zeroSide }) +
    blockActiveSeconds({ startTime: minuteMs(10, 0), endTime: minuteMs(10, 45), sessions: realSide })
  const merged = blockActiveSeconds({
    startTime: minuteMs(9, 0),
    endTime: minuteMs(10, 45),
    sessions: [...zeroSide, ...realSide],
  })
  // Both sides sum their sessions; the only drift allowed is the empty side's
  // 1-second display floor.
  assert.ok(Math.abs(merged - separate) <= 1, `merged ${merged} vs separate ${separate}`)
})

test('merging two blocks never changes the summed active seconds', () => {
  // Block A carries an inflated session duration; before the fix the per-block
  // span clamp hid that inflation, and the wider merged span let it back out.
  const sessionsA = [
    session(minuteMs(9, 0), minuteMs(9, 20), 25 * 60),
    session(minuteMs(9, 21), minuteMs(9, 28), 7 * 60),
  ]
  const sessionsB = [session(minuteMs(9, 45), minuteMs(10, 15), 30 * 60)]
  const separate =
    blockActiveSeconds({ startTime: minuteMs(9, 0), endTime: minuteMs(9, 28), sessions: sessionsA }) +
    blockActiveSeconds({ startTime: minuteMs(9, 45), endTime: minuteMs(10, 15), sessions: sessionsB })
  const merged = blockActiveSeconds({
    startTime: minuteMs(9, 0),
    endTime: minuteMs(10, 15),
    sessions: [...sessionsA, ...sessionsB],
  })
  assert.equal(merged, separate)
})
