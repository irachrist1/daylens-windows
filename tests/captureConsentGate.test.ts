// Capture consent gate: capture observes nothing until consent is explicitly
// granted for the current policy version. Proves at the pure-gate layer AND
// through the real tracking FSM's persistence path that no capture path
// persists evidence before consent.

import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { clearTestDb, setTestDb } from './support/database-stub.mjs'
import { __resetSettings, __setSettings } from './support/settings-stub.mjs'
import {
  CAPTURE_POLICY_VERSION,
  DEFAULT_CAPTURE_CONSENT,
  grantedCaptureConsent,
  isCaptureConsentCurrent,
  normalizeCaptureConsent,
} from '../src/shared/captureConsent.ts'
import {
  decideAppCapture,
  decideSiteCapture,
  trackingControlsStateFromSettings,
} from '../src/shared/trackingControls.ts'
import { shouldCaptureFocusEvent } from '../src/main/services/focusCapture.ts'
import { shouldStartTrackingForSettings } from '../src/main/lib/onboardingState.ts'
import { reconcileOnboardingState } from '../src/main/services/onboarding.ts'
import {
  __setTrackingFsmTestHarness,
  __pollForTest,
} from '../src/main/services/tracking.ts'
import type { AppSettings } from '../src/shared/types.ts'

const UNSET = { ...DEFAULT_CAPTURE_CONSENT }
const DECLINED = { status: 'declined' as const, policyVersion: CAPTURE_POLICY_VERSION, decidedAt: 1 }
const GRANTED = grantedCaptureConsent(1)
const STALE_GRANT = { status: 'granted' as const, policyVersion: CAPTURE_POLICY_VERSION - 1, decidedAt: 1 }

function settingsWith(captureConsent: unknown): Parameters<typeof trackingControlsStateFromSettings>[0] {
  return { captureConsent }
}

test('consent state normalization collapses anything malformed to unset', () => {
  for (const raw of [null, undefined, 'granted', 42, [], {}, { status: 'maybe' }]) {
    assert.deepEqual(normalizeCaptureConsent(raw), UNSET)
  }
  assert.deepEqual(normalizeCaptureConsent(GRANTED), GRANTED)
})

test('consent is current only when granted for the policy version in force', () => {
  assert.equal(isCaptureConsentCurrent(GRANTED), true)
  assert.equal(isCaptureConsentCurrent(UNSET), false)
  assert.equal(isCaptureConsentCurrent(DECLINED), false)
  // A material policy change (version bump) closes the gate until re-consent.
  assert.equal(isCaptureConsentCurrent(STALE_GRANT), false)
})

test('every capture decision refuses without consent, before any other rule', () => {
  for (const consent of [UNSET, DECLINED, STALE_GRANT]) {
    const state = trackingControlsStateFromSettings(settingsWith(consent))
    assert.equal(state.consented, false)
    assert.deepEqual(
      decideAppCapture(state, { bundleId: 'com.apple.TextEdit', appName: 'TextEdit', windowTitle: 'Draft' }),
      { capture: false, reason: 'no_consent' },
    )
    assert.deepEqual(
      decideSiteCapture(state, { domain: 'example.com', windowTitle: 'Example' }),
      { capture: false, reason: 'no_consent' },
    )
    // Machine-state focus events carry no app or url, so the per-candidate
    // gates never see them — consent must refuse them unconditionally.
    assert.equal(
      shouldCaptureFocusEvent({ app_bundle_id: null, app_name: null, window_title: null, url: null }, state),
      false,
    )
  }

  const consented = trackingControlsStateFromSettings(settingsWith(GRANTED))
  assert.equal(consented.consented, true)
  assert.equal(
    decideAppCapture(consented, { bundleId: 'com.apple.TextEdit', appName: 'TextEdit', windowTitle: 'Draft' }).capture,
    true,
  )
  assert.equal(
    decideSiteCapture(consented, { domain: 'example.com', windowTitle: 'Example' }).capture,
    true,
  )
})

test('no capture adapter starts without consent, on any platform', () => {
  const base = {
    captureConsent: UNSET,
    onboardingState: { trackingPermissionState: 'granted' },
  } as unknown as AppSettings

  for (const platform of ['macos', 'windows', 'linux'] as const) {
    assert.equal(shouldStartTrackingForSettings(base, platform), false)
  }

  const consented = { ...base, captureConsent: GRANTED } as AppSettings
  assert.equal(shouldStartTrackingForSettings(consented, 'windows'), true)
  assert.equal(shouldStartTrackingForSettings(consented, 'linux'), true)
  assert.equal(shouldStartTrackingForSettings(consented, 'macos'), true)

  // Consent does not shortcut the macOS permission requirement.
  const noPermission = {
    ...consented,
    onboardingState: { trackingPermissionState: 'missing' },
  } as unknown as AppSettings
  assert.equal(shouldStartTrackingForSettings(noPermission, 'macos'), false)
})

// ── End to end: the real tracking FSM persists nothing before consent ────────

const WIN = {
  title: 'Draft notes',
  application: 'TextEdit',
  path: '/Applications/TextEdit.app',
  pid: 4321,
  icon: '',
}

const BASE = new Date(2026, 6, 3, 10, 0, 0, 0).getTime()

const EVIDENCE_TABLES = ['app_sessions', 'focus_events', 'website_visits', 'activity_state_events']

function evidenceRowCounts(db: Database.Database): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const table of EVIDENCE_TABLES) {
    counts[table] = (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
  }
  return counts
}

async function driveForegroundMinute(clock: { now: number; lastInput: number }): Promise<void> {
  // One minute of ordinary foreground use: initial poll with input, a poll a
  // minute later, then an app switch would flush — force it via another poll
  // after the FSM sees fresh input.
  clock.now = BASE
  clock.lastInput = BASE
  await __pollForTest()
  clock.now = BASE + 60_000
  clock.lastInput = BASE + 60_000
  await __pollForTest()
}

test('the tracking FSM persists no evidence rows before consent, and persists after it', async () => {
  const db = createProductionTestDatabase()
  setTestDb(db)
  const clock = { now: BASE, lastInput: BASE }
  __setTrackingFsmTestHarness({
    now: () => clock.now,
    idleSeconds: () => Math.max(0, (clock.now - clock.lastInput) / 1_000),
    activeWindow: () => WIN,
  })

  try {
    // Before consent: the same polls that normally build a session are refused
    // at the per-sample consent gate — nothing reaches any evidence table.
    __resetSettings()
    __setSettings({ captureConsent: UNSET })
    await driveForegroundMinute(clock)
    assert.deepEqual(
      evidenceRowCounts(db),
      Object.fromEntries(EVIDENCE_TABLES.map((table) => [table, 0])),
      'no evidence row may exist before consent',
    )

    // After consent: the identical drive persists the session.
    __setSettings({ captureConsent: grantedCaptureConsent(BASE) })
    // Reset FSM state so the scenario replays from a clean slate.
    __setTrackingFsmTestHarness({
      now: () => clock.now,
      idleSeconds: () => Math.max(0, (clock.now - clock.lastInput) / 1_000),
      activeWindow: () => WIN,
    })
    await driveForegroundMinute(clock)
    // Switch away so the open session flushes to app_sessions.
    clock.now = BASE + 120_000
    clock.lastInput = BASE + 120_000
    const flushedWin = { ...WIN, title: 'Other window', application: 'Notes', path: '/Applications/Notes.app', pid: 999 }
    __setTrackingFsmTestHarness({
      now: () => clock.now,
      idleSeconds: () => 0,
      activeWindow: () => flushedWin,
    })
    // A fresh harness resets the FSM, so re-drive the original minute and then
    // let the flush happen through an explicit session end below.
    await driveForegroundMinute(clock)

    const { flushCurrentSession } = await import('../src/main/services/tracking.ts')
    flushCurrentSession()
    const appSessions = (db.prepare('SELECT COUNT(*) AS count FROM app_sessions').get() as { count: number }).count
    assert.ok(appSessions > 0, 'the identical activity persists once consent is granted')
  } finally {
    __setTrackingFsmTestHarness(null)
    clearTestDb()
    db.close()
    __resetSettings()
  }
})

// ── Reconciliation: installs that predate the recorded consent state ─────────

test('completed installs are grandfathered to granted consent on upgrade', async () => {
  __resetSettings()
  __setSettings({
    onboardingComplete: true,
    onboardingState: { stage: 'complete', trackingPermissionState: 'granted' },
    captureConsent: UNSET,
  })

  const settings = await reconcileOnboardingState()

  assert.equal(settings.captureConsent.status, 'granted')
  assert.equal(settings.captureConsent.policyVersion, CAPTURE_POLICY_VERSION)
  __resetSettings()
})

test('a fresh install at the capture explainer stays unset — capture stays off', async () => {
  __resetSettings()
  __setSettings({
    onboardingComplete: false,
    onboardingState: { stage: 'welcome', trackingPermissionState: 'granted' },
    captureConsent: UNSET,
  })

  const settings = await reconcileOnboardingState()

  assert.equal(settings.captureConsent.status, 'unset')
  __resetSettings()
})

test('an explicit decline is never overwritten by reconciliation', async () => {
  __resetSettings()
  __setSettings({
    onboardingComplete: true,
    onboardingState: { stage: 'complete', trackingPermissionState: 'granted' },
    captureConsent: DECLINED,
  })

  const settings = await reconcileOnboardingState()

  assert.equal(settings.captureConsent.status, 'declined')
  __resetSettings()
})
