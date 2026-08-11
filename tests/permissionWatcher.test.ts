// DEV-229 part 2: the capture verification verdict. The old check trusted
// the OS grant flag alone, so a dead grant (rebuild, update, revocation)
// reported "granted" while every sample came back untitled. These pin the
// two-signal verdict: the flag AND whether real reads actually work.
import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveCaptureVerificationStatus } from '../src/main/services/permissionWatcher.ts'

test('a revoked flag is blind immediately, regardless of samples', () => {
  assert.equal(
    deriveCaptureVerificationStatus({ axTrusted: false, recentSamples: 0, recentSamplesWithTitle: 0 }),
    'blind',
  )
  assert.equal(
    deriveCaptureVerificationStatus({ axTrusted: false, recentSamples: 100, recentSamplesWithTitle: 90 }),
    'blind',
  )
})

test('a granted flag with zero titled samples is blind — the T9 dead-grant case', () => {
  assert.equal(
    deriveCaptureVerificationStatus({ axTrusted: true, recentSamples: 83, recentSamplesWithTitle: 0 }),
    'blind',
  )
})

test('too few samples is waiting, not an alarm', () => {
  assert.equal(
    deriveCaptureVerificationStatus({ axTrusted: true, recentSamples: 0, recentSamplesWithTitle: 0 }),
    'waiting',
  )
  assert.equal(
    deriveCaptureVerificationStatus({ axTrusted: true, recentSamples: 4, recentSamplesWithTitle: 0 }),
    'waiting',
  )
})

test('a short all-untitled stretch is waiting, not a blind alarm', () => {
  // 7 samples, all untitled, flag granted: could be a game or a titleless
  // utility — not enough evidence to notify "your grant died".
  assert.equal(
    deriveCaptureVerificationStatus({ axTrusted: true, recentSamples: 7, recentSamplesWithTitle: 0 }),
    'waiting',
  )
})

test('under half titled is degraded — the "healthy at 17 of 102" screenshot case', () => {
  assert.equal(
    deriveCaptureVerificationStatus({ axTrusted: true, recentSamples: 102, recentSamplesWithTitle: 17 }),
    'degraded',
  )
})

test('most samples titled is healthy', () => {
  assert.equal(
    deriveCaptureVerificationStatus({ axTrusted: true, recentSamples: 100, recentSamplesWithTitle: 51 }),
    'healthy',
  )
  assert.equal(
    deriveCaptureVerificationStatus({ axTrusted: true, recentSamples: 10, recentSamplesWithTitle: 10 }),
    'healthy',
  )
})
