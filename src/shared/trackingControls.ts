// Tracking Controls: user-controlled capture exclusions.
//
// Design invariant: the feature is OPT-IN and OFF by default. When disabled
// and not paused, every gate here is a strict passthrough,
// so capture stays byte-for-byte identical to today. Only an explicit master
// opt-in (plus an ad-hoc pause that works regardless of the switch) changes
// behavior. This is the hermetic core — no DB, no settings store — so it can be
// exhaustively unit-tested and reused by the foreground-app and website paths.
//
// One rule sits above the opt-in design: explicit capture consent
// (src/shared/captureConsent.ts). Without current consent, every decision here
// is a refusal — capture observes nothing until the person has agreed.

import { isCaptureConsentCurrent, normalizeCaptureConsent } from './captureConsent'

export interface TrackingControlsState {
  /** Explicit capture consent for the current policy version. Unlike the
   *  opt-in controls below, this gate is ALWAYS in force: without consent no
   *  capture decision passes, regardless of every other setting. */
  consented: boolean
  enabled: boolean
  paused: boolean
  excludedApps: string[] // bundle ids and/or app names (free-form, case-insensitive)
  excludedSites: string[] // hosts/domains (free-form, case-insensitive)
  skipIncognito: boolean
}

export interface AppCaptureCandidate {
  bundleId?: string | null
  canonicalAppId?: string | null
  appName?: string | null
  windowTitle?: string | null
  /** Structured private-window signal from the browser reader, when available. */
  isPrivate?: boolean | null
}

export interface SiteCaptureCandidate {
  domain?: string | null
  windowTitle?: string | null
  isPrivate?: boolean | null
}

export type CaptureBlockReason = 'no_consent' | 'paused' | 'excluded_app' | 'excluded_site' | 'incognito'

export interface CaptureDecision {
  capture: boolean
  reason: CaptureBlockReason | null
}

const ALLOW: CaptureDecision = { capture: true, reason: null }

// Window-title markers browsers append to private/incognito windows. Daylens has
// no structured incognito signal from the OS, so this title heuristic is the
// honest best-effort — it catches the common cross-browser cases (Chrome/Brave
// "Incognito", Edge "InPrivate", Firefox/Safari "Private Browsing").
const INCOGNITO_TITLE_RE = /\b(incognito|inprivate|private browsing|private window|private mode)\b/i

export function detectIncognitoFromTitle(windowTitle: string | null | undefined): boolean {
  return !!windowTitle && INCOGNITO_TITLE_RE.test(windowTitle)
}

// A window is private when the browser reader said so (structured signal,
// e.g. Chromium's window mode — titles alone are not enough: Chrome on macOS
// puts no marker in the window title) or the title carries a private marker.
function isPrivateWindow(candidate: { windowTitle?: string | null; isPrivate?: boolean | null }): boolean {
  return candidate.isPrivate === true || detectIncognitoFromTitle(candidate.windowTitle)
}

function normalizeToken(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

function normalizeHost(value: string | null | undefined): string {
  return normalizeToken(value).replace(/^www\./, '')
}

// An app matches an exclusion entry when the entry equals (case-insensitively)
// its bundle id, its bundle id without a browser-profile suffix
// (`com.google.Chrome:Profile 1` → `com.google.chrome`), its canonical app id,
// or its display name. Profile-aware matching means excluding "chrome" or the
// base bundle drops every profile variant, not just the one currently open.
export function isAppExcluded(state: TrackingControlsState, candidate: AppCaptureCandidate): boolean {
  if (!state.enabled || state.excludedApps.length === 0) return false
  const bundle = normalizeToken(candidate.bundleId)
  const baseBundle = bundle.split(':', 1)[0]
  const canonical = normalizeToken(candidate.canonicalAppId)
  const name = normalizeToken(candidate.appName)
  return state.excludedApps.some((entry) => {
    const e = normalizeToken(entry)
    return e !== '' && (e === bundle || e === baseBundle || e === canonical || e === name)
  })
}

// A site matches when the candidate host equals, or is a subdomain of, an
// excluded host — so excluding "youtube.com" also covers "m.youtube.com".
export function isSiteExcluded(state: TrackingControlsState, candidate: SiteCaptureCandidate): boolean {
  if (!state.enabled || state.excludedSites.length === 0) return false
  const host = normalizeHost(candidate.domain)
  if (!host) return false
  return state.excludedSites.some((entry) => {
    const e = normalizeHost(entry)
    return e !== '' && (host === e || host.endsWith(`.${e}`))
  })
}

// Private/incognito windows are never captured — this check runs before
// paused/enabled, independent of every setting.

// Foreground app-session gate. Consent is checked before everything else:
// pre-consent there is no capture at all, so no other rule can matter.
export function decideAppCapture(state: TrackingControlsState, candidate: AppCaptureCandidate): CaptureDecision {
  if (!state.consented) return { capture: false, reason: 'no_consent' }
  if (isPrivateWindow(candidate)) return { capture: false, reason: 'incognito' }
  if (state.paused) return { capture: false, reason: 'paused' }
  if (!state.enabled) return ALLOW
  if (isAppExcluded(state, candidate)) return { capture: false, reason: 'excluded_app' }
  return ALLOW
}

// Browser website-visit gate. The browser app itself is gated upstream by
// decideAppCapture; this drops a specific excluded domain (or private-window
// visit) while a non-excluded browser app keeps being tracked.
export function decideSiteCapture(state: TrackingControlsState, candidate: SiteCaptureCandidate): CaptureDecision {
  if (!state.consented) return { capture: false, reason: 'no_consent' }
  if (isPrivateWindow(candidate)) return { capture: false, reason: 'incognito' }
  if (state.paused) return { capture: false, reason: 'paused' }
  if (!state.enabled) return ALLOW
  if (isSiteExcluded(state, candidate)) return { capture: false, reason: 'excluded_site' }
  return ALLOW
}

// Adapt AppSettings into the gate state (keeps this module free of the wider
// settings shape). Defaults match the opt-in contract: disabled, unpaused,
// empty lists, incognito-skip on (effective only once enabled). Consent has
// the opposite default — absent or malformed consent means NOT consented.
export function trackingControlsStateFromSettings(s: {
  captureConsent?: unknown
  trackingControlsEnabled?: boolean
  trackingPaused?: boolean
  trackingExcludedApps?: string[]
  trackingExcludedSites?: string[]
  trackingSkipIncognito?: boolean
}): TrackingControlsState {
  return {
    consented: isCaptureConsentCurrent(normalizeCaptureConsent(s.captureConsent)),
    enabled: Boolean(s.trackingControlsEnabled),
    paused: Boolean(s.trackingPaused),
    excludedApps: s.trackingExcludedApps ?? [],
    excludedSites: s.trackingExcludedSites ?? [],
    skipIncognito: s.trackingSkipIncognito ?? true,
  }
}
