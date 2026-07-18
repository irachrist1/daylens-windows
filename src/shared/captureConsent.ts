// Capture consent: the explicit recorded state that gates every capture
// adapter. Capture observes nothing until consent is granted for the CURRENT
// capture policy version — a material policy change bumps the version, which
// closes the gate again until consent is re-presented and re-recorded.

// The version of the capture policy (what is captured, exclusions, pause,
// private-window rules) that consent is given for and that events are admitted
// under. Also recorded as provenance on every evidence row (see
// src/main/core/evidence/focusEvent.ts); rows that predate provenance carry
// policy_version 0.
export const CAPTURE_POLICY_VERSION = 1

export type CaptureConsentStatus = 'unset' | 'granted' | 'declined'

export interface CaptureConsentState {
  status: CaptureConsentStatus
  /** The policy version the decision was made for; null while unset. */
  policyVersion: number | null
  /** Unix ms of the explicit decision; null while unset. */
  decidedAt: number | null
}

export const DEFAULT_CAPTURE_CONSENT: CaptureConsentState = Object.freeze({
  status: 'unset',
  policyVersion: null,
  decidedAt: null,
})

export function grantedCaptureConsent(decidedAt: number): CaptureConsentState {
  return { status: 'granted', policyVersion: CAPTURE_POLICY_VERSION, decidedAt }
}

export function declinedCaptureConsent(decidedAt: number): CaptureConsentState {
  return { status: 'declined', policyVersion: CAPTURE_POLICY_VERSION, decidedAt }
}

// Consent is current only when it was explicitly granted for the policy
// version in force today. Granted-for-an-older-policy means the policy changed
// materially since the person agreed — the gate closes until they re-consent.
export function isCaptureConsentCurrent(
  consent: CaptureConsentState,
  currentPolicyVersion: number = CAPTURE_POLICY_VERSION,
): boolean {
  return consent.status === 'granted' && consent.policyVersion === currentPolicyVersion
}

// Settings cross the electron-store / IPC boundary, so treat the stored shape
// as untrusted: anything malformed collapses to unset (capture off).
export function normalizeCaptureConsent(raw: unknown): CaptureConsentState {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_CAPTURE_CONSENT }
  const candidate = raw as Record<string, unknown>
  const status = candidate.status
  if (status !== 'granted' && status !== 'declined') return { ...DEFAULT_CAPTURE_CONSENT }
  return {
    status,
    policyVersion: typeof candidate.policyVersion === 'number' ? candidate.policyVersion : null,
    decidedAt: typeof candidate.decidedAt === 'number' ? candidate.decidedAt : null,
  }
}
