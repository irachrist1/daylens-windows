import test from 'node:test'
import assert from 'node:assert/strict'
import type { AppSession } from '../src/shared/types.ts'
import { analyzeSessions } from '../src/main/services/workBlocks.ts'

// Each standalone meeting is peeled off and the remainder is analyzed again.
// On a high-volume day that is O(n) call-stack depth, which is the DEV-487
// overflow: RangeError: Maximum call stack size exceeded, with thousands of
// identical `analyzeSessions` frames. The morning/evening notifier hits this
// path through getTimelineDayPayload → buildBlocksForSessions.
const HIGH_VOLUME_MEETINGS = 8_000

function meetingSession(index: number): AppSession {
  const startTime = Date.UTC(2026, 3, 12, 8, 0, 0) + index * 21 * 60_000
  return {
    id: index + 1,
    bundleId: 'us.zoom.xos',
    appName: 'zoom.us',
    startTime,
    endTime: startTime + 21 * 60_000,
    durationSeconds: 21 * 60,
    category: 'meetings',
    isFocused: true,
    windowTitle: `Weekly sync ${index + 1}`,
    rawAppName: 'zoom.us',
    canonicalAppId: 'us.zoom.xos',
    captureSource: 'foreground_poll',
    endedReason: null,
    captureVersion: 2,
  }
}

test('analyzeSessions peels consecutive standalone meetings without changing order', () => {
  const sessions = [0, 1, 2].map(meetingSession)
  const blocks = analyzeSessions(sessions, true, true)
  assert.equal(blocks.length, 3)
  assert.deepEqual(
    blocks.map((block) => ({
      formation: block.formation,
      ids: block.sessions.map((session) => session.id),
      forcedLabel: block.forcedLabel,
      boundedBeforeGap: block.boundedBeforeGap,
      boundedAfterGap: block.boundedAfterGap,
    })),
    [
      { formation: 'meeting', ids: [1], forcedLabel: 'Zoom Call', boundedBeforeGap: true, boundedAfterGap: false },
      { formation: 'meeting', ids: [2], forcedLabel: 'Zoom Call', boundedBeforeGap: false, boundedAfterGap: false },
      { formation: 'meeting', ids: [3], forcedLabel: 'Zoom Call', boundedBeforeGap: false, boundedAfterGap: true },
    ],
  )
})

test('analyzeSessions finishes a high-volume meeting chain without overflowing the stack', () => {
  const sessions = Array.from({ length: HIGH_VOLUME_MEETINGS }, (_, index) => meetingSession(index))
  const blocks = analyzeSessions(sessions, false, false)
  assert.equal(blocks.length, HIGH_VOLUME_MEETINGS)
  assert.equal(blocks[0]?.sessions[0]?.id, 1)
  assert.equal(blocks[HIGH_VOLUME_MEETINGS - 1]?.sessions[0]?.id, HIGH_VOLUME_MEETINGS)
  assert.ok(blocks.every((block) => block.formation === 'meeting'))
})
