// DEV-261: repeated main-thread stalls must surface as a persistent in-app
// banner, not only a one-shot notification. The banner verdict is derived
// from the watchdog's own session counters and rides the existing
// capture-verification channel: it appears once stalls cross the product
// threshold (three in a session, or one severe stall) and clears after a
// quiet stretch proves recording has resumed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { clearTestDb, setTestDb } from './support/database-stub.mjs'
import {
  deriveRecorderStallBanner,
  getRecorderStallBannerState,
  setStallObserverForTests,
  startStallWatchdog,
  stopStallWatchdog,
  REPEATED_STALL_COUNT,
  SEVERE_STALL_MS,
  STALL_BANNER_CLEAR_AFTER_QUIET_MS,
  type StallObservation,
} from '../src/main/services/stallWatchdog.ts'

const NOW = new Date(2026, 6, 22, 14, 0, 0, 0).getTime()

test('no banner below the threshold: a couple of short stalls stay quiet', () => {
  assert.equal(
    deriveRecorderStallBanner({ stallCount: 0, longestStallMs: 0, lastStallEndMs: null }, NOW),
    null,
  )
  assert.equal(
    deriveRecorderStallBanner(
      { stallCount: REPEATED_STALL_COUNT - 1, longestStallMs: SEVERE_STALL_MS - 1_000, lastStallEndMs: NOW - 1_000 },
      NOW,
    ),
    null,
  )
})

test('banner appears at three stalls, or at one severe stall', () => {
  const repeated = deriveRecorderStallBanner(
    { stallCount: REPEATED_STALL_COUNT, longestStallMs: 15_000, lastStallEndMs: NOW - 5_000 },
    NOW,
  )
  assert.ok(repeated, 'three stalls in one session must raise the banner')
  assert.equal(repeated.stallCount, REPEATED_STALL_COUNT)
  assert.equal(repeated.longestStallSeconds, 15)

  const severe = deriveRecorderStallBanner(
    { stallCount: 1, longestStallMs: SEVERE_STALL_MS, lastStallEndMs: NOW - 5_000 },
    NOW,
  )
  assert.ok(severe, 'a single severe stall must raise the banner')
  assert.equal(severe.stallCount, 1)
})

test('banner clears after the quiet window, and a later stall brings it back', () => {
  const snapshot = {
    stallCount: REPEATED_STALL_COUNT,
    longestStallMs: 20_000,
    lastStallEndMs: NOW,
  }
  assert.ok(deriveRecorderStallBanner(snapshot, NOW + STALL_BANNER_CLEAR_AFTER_QUIET_MS - 1))
  assert.equal(
    deriveRecorderStallBanner(snapshot, NOW + STALL_BANNER_CLEAR_AFTER_QUIET_MS),
    null,
    'a quiet stretch means recording resumed; the banner must clear',
  )
  // A new stall after the quiet clear re-raises immediately: the session's
  // counters never reset, so a suspect session stays on a short leash.
  const relapsed = deriveRecorderStallBanner(
    { ...snapshot, stallCount: snapshot.stallCount + 1, lastStallEndMs: NOW + 20 * 60_000 },
    NOW + 20 * 60_000 + 1_000,
  )
  assert.ok(relapsed)
  assert.equal(relapsed.stallCount, REPEATED_STALL_COUNT + 1)
})

test('the live watchdog counters feed the banner: three real stalls raise it, quiet clears it, stop resets it', async () => {
  const db = createProductionTestDatabase()
  setTestDb(db)
  const observations: StallObservation[] = []
  setStallObserverForTests((o) => observations.push(o))

  // Scripted clock: three 15-second holes, each burning enough CPU to be a
  // stall (a wedge, not machine sleep), none long enough for the severe path —
  // this exercises the repeat threshold specifically.
  const base = NOW
  let nowValue = base
  let cpuValue = 0
  startStallWatchdog({ now: () => nowValue, cpuMs: () => cpuValue })
  try {
    for (let i = 1; i <= 3; i += 1) {
      nowValue = base + i * 16_000
      cpuValue = i * 15_000
      // The watchdog's heartbeat runs on real time: give it one beat to
      // observe each scripted hole.
      await new Promise((resolve) => setTimeout(resolve, 1_100))
      if (i < REPEATED_STALL_COUNT) {
        assert.equal(getRecorderStallBannerState(nowValue), null, `stall #${i} alone must not raise the banner`)
      }
    }
    assert.equal(observations.filter((o) => o.kind === 'stall').length, 3)

    const banner = getRecorderStallBannerState(nowValue)
    assert.ok(banner, 'the third stall must raise the banner')
    assert.equal(banner.stallCount, 3)
    assert.equal(banner.longestStallSeconds, 15)

    assert.equal(
      getRecorderStallBannerState(nowValue + STALL_BANNER_CLEAR_AFTER_QUIET_MS),
      null,
      'the banner clears once stalls have stopped for the quiet window',
    )
  } finally {
    stopStallWatchdog()
    setStallObserverForTests(null)
    clearTestDb()
    db.close()
  }
  assert.equal(getRecorderStallBannerState(nowValue), null, 'stopping the watchdog resets the session counters')
})
