// The evidence seam (timeline.md "Segmentation"): an unobserved gap of 30
// minutes or more ALWAYS ends a block. No block may span an untracked hole —
// bridging one (the reference bug: a 12:30–14:00 lunch inside one 11:37–14:46
// "block") propagates invented continuity into every downstream account of
// the day. The seam measures CAPTURED EVIDENCE (duration-derived session
// ends), not wall-clock envelopes, and passive presence (media playing,
// idle_start with heldForMediaPlayback) counts as coverage, never as a gap.

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import type { AppSession } from '../src/shared/types.ts'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { buildTimelineBlocksFromSessions } from '../src/main/services/workBlocks.ts'

// Local-time millis on a fixed day, so block boundaries are deterministic.
function at(hour: number, minute: number): number {
  return new Date(2026, 3, 12, hour, minute, 0, 0).getTime()
}

let nextId = 1
function session(opts: {
  bundleId: string
  appName?: string
  category: AppSession['category']
  startTime: number
  endTime: number
  /** Captured activity. Defaults to the full envelope; pass a smaller value to
   *  model an envelope-stretched row (activity stopped, envelope kept going). */
  durationSeconds?: number
  windowTitle?: string | null
}): AppSession {
  return {
    id: nextId++,
    bundleId: opts.bundleId,
    appName: opts.appName ?? opts.bundleId,
    startTime: opts.startTime,
    endTime: opts.endTime,
    durationSeconds: opts.durationSeconds ?? Math.round((opts.endTime - opts.startTime) / 1000),
    category: opts.category,
    isFocused: opts.category === 'development' || opts.category === 'aiTools',
    windowTitle: opts.windowTitle ?? null,
    rawAppName: opts.appName ?? opts.bundleId,
    canonicalAppId: opts.bundleId,
    appInstanceId: opts.bundleId,
    captureSource: 'foreground_poll',
    endedReason: null,
    captureVersion: 2,
  }
}

function seedActivityEvent(db: Database.Database, tsMs: number, type: string, metadata: Record<string, unknown> = {}): void {
  db.prepare(`INSERT INTO activity_state_events (event_ts, event_type, source, metadata_json) VALUES (?, ?, 'system', ?)`)
    .run(tsMs, type, JSON.stringify(metadata))
}

function spans(blocks: Array<{ startTime: number; endTime: number }>): string[] {
  const clock = (ms: number) => {
    const d = new Date(ms)
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return blocks.map((b) => `${clock(b.startTime)}-${clock(b.endTime)}`)
}

// A 90-minute silent hole between two working stretches is a hard boundary:
// the day comes back as two blocks and neither spans the hole.
test('a 90-minute silent hole splits the block', () => {
  const db = createProductionTestDatabase()
  const sessions = [
    session({ bundleId: 'com.microsoft.VSCode', appName: 'Code', category: 'development', startTime: at(11, 0), endTime: at(12, 30), windowTitle: 'workBlocks.ts — daylens' }),
    session({ bundleId: 'com.microsoft.VSCode', appName: 'Code', category: 'development', startTime: at(14, 0), endTime: at(14, 46), windowTitle: 'workBlocks.ts — daylens' }),
  ]
  const blocks = buildTimelineBlocksFromSessions(db, sessions)
  assert.equal(blocks.length, 2, `expected the hole to split the day into two blocks, got ${spans(blocks).join(', ')}`)
  for (const block of blocks) {
    assert.ok(
      !(block.startTime < at(12, 45) && block.endTime > at(13, 45)),
      `block ${spans([block]).join('')} spans the 12:30–14:00 silent hole`,
    )
  }
  db.close()
})

// The reference bug shape: the same lunch hole, but "covered" by one row whose
// wall-clock envelope stretches 100 minutes past its 5 minutes of captured
// activity (real row 1399 carried 236s across a 2,139s envelope). The
// envelope is not evidence; the seam still cuts, and the left block's end is
// clamped back to where activity really stopped.
test('an envelope-stretched session cannot bridge an unobserved hole', () => {
  const db = createProductionTestDatabase()
  const sessions = [
    session({ bundleId: 'com.microsoft.VSCode', appName: 'Code', category: 'development', startTime: at(11, 37), endTime: at(12, 20), windowTitle: 'workBlocks.ts — daylens' }),
    session({ bundleId: 'com.microsoft.VSCode', appName: 'Code', category: 'development', startTime: at(12, 20), endTime: at(14, 0), durationSeconds: 300, windowTitle: 'workBlocks.ts — daylens' }),
    session({ bundleId: 'com.microsoft.VSCode', appName: 'Code', category: 'development', startTime: at(14, 0), endTime: at(14, 46), windowTitle: 'workBlocks.ts — daylens' }),
  ]
  const blocks = buildTimelineBlocksFromSessions(db, sessions)
  assert.equal(blocks.length, 2, `expected the lunch hole to stay split, got one bridged block: ${spans(blocks).join(', ')}`)
  // The left block ends where captured activity ended (12:25), never at the
  // stretched envelope's 14:00 — a block's height is its real duration.
  assert.ok(blocks[0].endTime <= at(12, 26), `left block still ends inside the hole: ${spans(blocks).join(', ')}`)
  assert.equal(blocks[1].startTime, at(14, 0))
  db.close()
})

// Passive presence is NOT a gap: the same envelope shape, but activity-state
// events say the idle stretch was held for media playback (a video playing, a
// meeting on screen). Presence without input is presence; the block holds.
test('passive presence (media playback hold) is coverage, not a gap', () => {
  const db = createProductionTestDatabase()
  const sessions = [
    session({ bundleId: 'com.microsoft.VSCode', appName: 'Code', category: 'development', startTime: at(11, 37), endTime: at(12, 20), windowTitle: 'workBlocks.ts — daylens' }),
    session({ bundleId: 'com.microsoft.VSCode', appName: 'Code', category: 'development', startTime: at(12, 20), endTime: at(14, 0), durationSeconds: 300, windowTitle: 'workBlocks.ts — daylens' }),
    session({ bundleId: 'com.microsoft.VSCode', appName: 'Code', category: 'development', startTime: at(14, 0), endTime: at(14, 46), windowTitle: 'workBlocks.ts — daylens' }),
  ]
  seedActivityEvent(db, at(12, 25), 'idle_start', { idleSeconds: 300, heldForMediaPlayback: true })
  seedActivityEvent(db, at(14, 0), 'idle_end')
  const blocks = buildTimelineBlocksFromSessions(db, sessions)
  assert.equal(blocks.length, 1, `passive presence must not split the block, got ${spans(blocks).join(', ')}`)
  db.close()
})

// The seam runs after the block floor, so a split must not ship a sub-floor
// sliver: an envelope-stretched candidate cut back at the hole leaves a
// 3-minute sitting stranded on the far side, and the floor re-runs to fold or
// drop it. The probe shape: real 11:00–11:30 evidence, an envelope stretched
// across the hole with 3 minutes of captured activity, and a 3-minute sitting
// at 12:58.
test('a seam split never ships a sub-floor sliver', () => {
  const db = createProductionTestDatabase()
  const sessions = [
    session({ bundleId: 'com.microsoft.VSCode', appName: 'Code', category: 'development', startTime: at(11, 0), endTime: at(11, 30), windowTitle: 'workBlocks.ts — daylens' }),
    // Envelope stretched to 13:01, activity stopped at 11:33.
    session({ bundleId: 'com.microsoft.VSCode', appName: 'Code', category: 'development', startTime: at(11, 30), endTime: at(13, 1), durationSeconds: 180, windowTitle: 'workBlocks.ts — daylens' }),
    // The 3-minute sitting after the hole.
    session({ bundleId: 'com.microsoft.VSCode', appName: 'Code', category: 'development', startTime: at(12, 58), endTime: at(13, 1), windowTitle: 'workBlocks.ts — daylens' }),
  ]
  const blocks = buildTimelineBlocksFromSessions(db, sessions)
  for (const block of blocks) {
    const spanMinutes = (block.endTime - block.startTime) / 60_000
    assert.ok(spanMinutes >= 15,
      `a sub-floor sliver shipped: ${spans([block]).join('')} (${spanMinutes.toFixed(1)}m)`)
    assert.ok(
      !(block.startTime < at(12, 0) && block.endTime > at(12, 30)),
      `block ${spans([block]).join('')} spans the unobserved hole`,
    )
  }
  db.close()
})

// A plain (un-held) idle stretch is exactly what the seam exists to cut: the
// same events WITHOUT the media hold change nothing about the split.
test('a plain idle stretch does not rescue the bridge', () => {
  const db = createProductionTestDatabase()
  const sessions = [
    session({ bundleId: 'com.microsoft.VSCode', appName: 'Code', category: 'development', startTime: at(11, 37), endTime: at(12, 20), windowTitle: 'workBlocks.ts — daylens' }),
    session({ bundleId: 'com.microsoft.VSCode', appName: 'Code', category: 'development', startTime: at(12, 20), endTime: at(14, 0), durationSeconds: 300, windowTitle: 'workBlocks.ts — daylens' }),
    session({ bundleId: 'com.microsoft.VSCode', appName: 'Code', category: 'development', startTime: at(14, 0), endTime: at(14, 46), windowTitle: 'workBlocks.ts — daylens' }),
  ]
  seedActivityEvent(db, at(12, 25), 'idle_start', { idleSeconds: 300 })
  seedActivityEvent(db, at(14, 0), 'idle_end')
  const blocks = buildTimelineBlocksFromSessions(db, sessions)
  assert.equal(blocks.length, 2, `expected the un-held idle hole to split, got ${spans(blocks).join(', ')}`)
  db.close()
})
