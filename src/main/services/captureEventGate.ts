// The capture privacy gate: validation, consent/exclusion decisions, and the
// browser-content strip that every mac focus-helper event must pass BEFORE it
// is persisted anywhere — memory, spool file, or database. Extracted from
// focusCapture.ts so the capture relay subprocess (DEV-262) runs the exact
// same gate before an event ever touches disk; a gated event must never exist
// on disk at all. No electron or database imports belong here.
import { resolveCanonicalApp } from '../lib/appIdentity'
import { resolveBrowserApplication } from './browserRegistry'
import { decideAppCapture, decideSiteCapture, detectIncognitoFromTitle, type TrackingControlsState } from '@shared/trackingControls'
import { isSystemNoiseApp } from '@shared/systemNoise'
import {
  FOCUS_EVENT_SCHEMA_VERSION,
  isFocusEventConfidence,
  isFocusEventType,
  isMacFocusEventSource,
  isSupportedFocusEventSchemaVersion,
  sourceAcceptsFocusEventType,
  type FocusEvent,
  type MacFocusEventSource,
} from '../core/evidence/focusEvent'
import { recordCaptureEventRejection } from '../lib/captureRejections'

export type HelperEvent = FocusEvent<MacFocusEventSource>

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string'
}

function isNullableNumber(value: unknown): value is number | null | undefined {
  return value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value))
}

function reject(reason: 'malformed' | 'unsupported_schema_version'): null {
  recordCaptureEventRejection('mac_focus_helper', reason)
  return null
}

export function normalizeHelperEvent(raw: unknown): HelperEvent | null {
  if (!isObject(raw)) return reject('malformed')
  const eventType = raw.event_type
  const source = raw.source
  const confidence = raw.confidence
  const schemaVersion = raw.schema_ver ?? FOCUS_EVENT_SCHEMA_VERSION
  if (!isSupportedFocusEventSchemaVersion(schemaVersion)) return reject('unsupported_schema_version')
  if (typeof raw.ts_ms !== 'number' || !Number.isFinite(raw.ts_ms)) return reject('malformed')
  if (typeof raw.mono_ns !== 'number' || !Number.isFinite(raw.mono_ns)) return reject('malformed')
  if (!isFocusEventType(eventType)) return reject('malformed')
  if (!isMacFocusEventSource(source)) return reject('malformed')
  if (!isFocusEventConfidence(confidence)) return reject('malformed')
  if (!isNullableString(raw.app_bundle_id)) return reject('malformed')
  if (!isNullableString(raw.app_name)) return reject('malformed')
  if (!isNullableNumber(raw.pid)) return reject('malformed')
  if (!isNullableString(raw.window_title)) return reject('malformed')
  if (!isNullableString(raw.url)) return reject('malformed')
  if (!isNullableString(raw.page_title)) return reject('malformed')
  if (!isNullableString(raw.platform)) return reject('malformed')
  if (!isNullableNumber(raw.display_id)) return reject('malformed')

  const url = raw.url ?? null
  const pageTitle = raw.page_title ?? null
  const displayId = raw.display_id ?? null

  if (!sourceAcceptsFocusEventType(source, eventType)) return reject('malformed')
  if (confidence === 'unknown' && (url !== null || pageTitle !== null)) return reject('malformed')
  if (source === 'apple_events_tab' && confidence === 'observed' && !url) return reject('malformed')
  if (source === 'nsworkspace_event' && (url !== null || pageTitle !== null)) return reject('malformed')
  // Display-visibility observations are identity-only per-display facts: they
  // must name their display and never carry page content; no other source may
  // claim a display.
  if (source === 'cg_display_visibility' && (displayId === null || url !== null || pageTitle !== null)) return reject('malformed')
  if (source !== 'cg_display_visibility' && displayId !== null) return reject('malformed')

  return {
    ts_ms: raw.ts_ms,
    mono_ns: raw.mono_ns,
    event_type: eventType,
    app_bundle_id: raw.app_bundle_id ?? null,
    app_name: raw.app_name ?? null,
    pid: raw.pid ?? null,
    window_title: raw.window_title ?? null,
    url,
    page_title: pageTitle,
    source,
    confidence,
    platform: raw.platform ?? 'darwin',
    schema_ver: FOCUS_EVENT_SCHEMA_VERSION,
    display_id: displayId,
  }
}

// Focus events get the same system-noise and exclusion gates as foreground
// sessions, so a tab-switch or window-change for an excluded app/site (or a
// system surface like loginwindow) is never even written to the spool or
// focus_events — and so never reaches projections, Timeline, Apps, or the
// AI/MCP boundary. Pure and exported so the gate is directly testable
// without spawning the helper.
export function shouldCaptureFocusEvent(
  ev: Pick<HelperEvent, 'app_bundle_id' | 'app_name' | 'window_title' | 'url'>,
  controls: TrackingControlsState,
): boolean {
  // Consent gates every event unconditionally — including machine-state
  // events with no app or url, which the per-candidate gates below never see.
  if (!controls.consented) return false
  // Private/incognito windows are never tracked, regardless of any setting.
  // The gates below also check this, but the title check runs here first so
  // a private tab URL never even reaches the event queue.
  if (detectIncognitoFromTitle(ev.window_title)) return false
  if (ev.app_bundle_id || ev.app_name) {
    if (isSystemNoiseApp({ bundleId: ev.app_bundle_id, appName: ev.app_name })) return false
    const identity = resolveCanonicalApp(ev.app_bundle_id ?? '', ev.app_name ?? '')
    if (!decideAppCapture(controls, {
      bundleId: ev.app_bundle_id,
      canonicalAppId: identity.canonicalAppId,
      appName: ev.app_name,
      windowTitle: ev.window_title,
    }).capture) return false
  }
  if (ev.url) {
    try {
      const domain = new URL(ev.url).hostname
      if (!decideSiteCapture(controls, { domain, windowTitle: ev.window_title }).capture) return false
    } catch {
      return false
    }
  }
  return true
}

// The last privacy transform before persistence.
export function eventParams(ev: HelperEvent): FocusEvent<MacFocusEventSource> {
  // A browser's window title/url is page content, and the focus helper cannot
  // know whether the window is private. Browser page detail only enters the
  // store through the corroborated visit pipeline; focus events for browsers
  // keep app identity and timing only. This applies to display-visibility
  // events identically: a browser full-screen on a second monitor is app
  // identity and timing, never an unverified page title. The catalog check is
  // the same fallback tracking.ts uses — it covers known browsers while the
  // LaunchServices registry is still warming.
  const isBrowser = resolveBrowserApplication({ bundleId: ev.app_bundle_id ?? null, appName: ev.app_name ?? null }) != null
    || resolveCanonicalApp(ev.app_bundle_id ?? '', ev.app_name ?? '').defaultCategory === 'browsing'
  return {
    ts_ms: ev.ts_ms,
    mono_ns: ev.mono_ns,
    event_type: ev.event_type,
    app_bundle_id: ev.app_bundle_id ?? null,
    app_name: ev.app_name ?? null,
    pid: ev.pid ?? null,
    window_title: isBrowser ? null : ev.window_title ?? null,
    url: isBrowser ? null : ev.url ?? null,
    page_title: isBrowser ? null : ev.page_title ?? null,
    source: ev.source,
    confidence: ev.confidence,
    platform: ev.platform,
    schema_ver: ev.schema_ver,
    display_id: ev.display_id ?? null,
  }
}

/** One helper line → the exact record allowed to persist, or null. Shared by
 *  the relay (spool write) and any direct ingestion path. */
export function gateHelperLine(
  line: string,
  controls: TrackingControlsState,
): FocusEvent<MacFocusEventSource> | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    recordCaptureEventRejection('mac_focus_helper', 'malformed')
    return null
  }
  const ev = normalizeHelperEvent(parsed)
  if (!ev) return null
  if (!shouldCaptureFocusEvent(ev, controls)) return null
  return eventParams(ev)
}
