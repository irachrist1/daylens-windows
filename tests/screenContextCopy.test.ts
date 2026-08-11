// DEV-251: the screen-context page may only claim to be sampling while the
// sampler itself is active, must show capture evidence rather than a cached
// setting, and every diagnostic outcome must read as plain words.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  captureEvidenceLine,
  describeCaptureBlockReason,
  screenContextHeadline,
} from '../src/renderer/views/settings/screenContextCopy.ts'

test('headline claims sampling only while the sampler is active', () => {
  assert.equal(screenContextHeadline({ paused: false, samplerActive: true }), 'Joined, sampling on')
  assert.equal(screenContextHeadline({ paused: false, samplerActive: false }), 'Joined, not capturing')
  // Paused wins over any sampler claim.
  assert.equal(screenContextHeadline({ paused: true, samplerActive: true }), 'Joined, paused')
})

test('evidence line says plainly when nothing has been captured', () => {
  assert.equal(
    captureEvidenceLine({ backlog: { frames: 0, bytes: 0 }, evidenceCount: 0, lastCapturedAt: null }),
    'No samples captured yet.',
  )
})

test('evidence line reports last capture time and stored counts', () => {
  const line = captureEvidenceLine(
    { backlog: { frames: 3, bytes: 9000 }, evidenceCount: 2, lastCapturedAt: 1_753_500_000_000 },
    () => '2:00 PM',
  )
  assert.equal(line, 'Last capture 2:00 PM · 3 frames stored · 2 extracted records.')
})

test('every known block reason maps to plain words', () => {
  const reasons = [
    'no_foreground', 'source_unavailable', 'consent_missing', 'screen_context_paused',
    'tracking_paused', 'excluded_app', 'excluded_site', 'private_browser',
    'protected_surface', 'screen_share', 'protected_media', 'backlog_cap',
    'rate_min_interval', 'rate_hourly_cap', 'context_not_stable', 'bounded_interval',
    'power_backoff',
  ]
  for (const reason of reasons) {
    const text = describeCaptureBlockReason(reason)
    assert.ok(text.length > 0)
    assert.ok(!text.includes('_'), `machine token leaked for ${reason}: ${text}`)
    assert.ok(!text.includes('—'), `em dash in shipped copy for ${reason}`)
  }
})

test('unknown or missing reasons still yield a visible sentence', () => {
  assert.equal(
    describeCaptureBlockReason(null),
    'No frame was captured, and no reason was reported.',
  )
  assert.equal(
    describeCaptureBlockReason('some_future_reason'),
    'No frame was captured (some future reason).',
  )
})
