import {
  isEvidenceSensitivity,
  type CaptureStateEvidenceKind,
  type EvidenceSensitivity,
  type MachineStateEvidenceKind,
} from './envelope'

// Version 2 is the canonical stored contract: stable evidence identity,
// sensitivity, and provenance on every row. Version 1 is the original helper
// wire shape; adapters still accept it and the repository lifts it to the
// canonical shape on insert. Anything else is rejected and counted as a
// capture-health failure.
export const FOCUS_EVENT_SCHEMA_VERSION = 2 as const
export const SUPPORTED_FOCUS_EVENT_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([1, 2])

// The version of the capture policy (exclusions, pause, private-window rules)
// that events are admitted under today. Recorded as provenance on every new
// row; rows that predate provenance carry policy_version 0. Defined next to
// the consent state it gates — consent is given per policy version.
export { CAPTURE_POLICY_VERSION } from '@shared/captureConsent'

export const FOCUS_EVENT_TYPES = [
  'app_activated',
  'app_deactivated',
  'window_changed',
  'space_changed',
  'sleep',
  'wake',
  'lock',
  'unlock',
  'idle_started',
  'idle_ended',
  'capture_started',
  'capture_stopped',
  'capture_paused',
  'capture_resumed',
  'capture_failed',
  'capture_recovered',
  'tab_changed',
  'tab_sampled',
] as const

export const FOCUS_EVENT_CONFIDENCES = ['observed', 'unknown'] as const
export const MAC_FOCUS_EVENT_SOURCES = ['nsworkspace_event', 'apple_events_tab'] as const
export const WINDOWS_FOCUS_EVENT_SOURCES = ['uia_foreground', 'uia_tab'] as const
// Machine-derived idle and capture-health transitions come from Daylens
// itself, not a platform helper.
export const SUPERVISOR_FOCUS_EVENT_SOURCE = 'capture_supervisor' as const
// The interval-based active-window sampler in tracking.ts. It observes the
// same foreground/window/machine facts as the native helpers, on both macOS
// and Windows, so its canonical rows carry their own source identity and the
// projection can weigh the two adapters against each other.
export const POLL_FOCUS_EVENT_SOURCE = 'foreground_poll' as const

export type FocusEventType = typeof FOCUS_EVENT_TYPES[number]
export type FocusEventConfidence = typeof FOCUS_EVENT_CONFIDENCES[number]
export type MacFocusEventSource = typeof MAC_FOCUS_EVENT_SOURCES[number]
export type WindowsFocusEventSource = typeof WINDOWS_FOCUS_EVENT_SOURCES[number]
export type SupervisorFocusEventSource = typeof SUPERVISOR_FOCUS_EVENT_SOURCE
export type PollFocusEventSource = typeof POLL_FOCUS_EVENT_SOURCE
export type FocusEventSource =
  | MacFocusEventSource
  | WindowsFocusEventSource
  | SupervisorFocusEventSource
  | PollFocusEventSource

const FOCUS_EVENT_TYPE_SET = new Set<string>(FOCUS_EVENT_TYPES)
const FOCUS_EVENT_CONFIDENCE_SET = new Set<string>(FOCUS_EVENT_CONFIDENCES)
const MAC_FOCUS_EVENT_SOURCE_SET = new Set<string>(MAC_FOCUS_EVENT_SOURCES)
const WINDOWS_FOCUS_EVENT_SOURCE_SET = new Set<string>(WINDOWS_FOCUS_EVENT_SOURCES)
const TAB_EVENT_TYPES = new Set<FocusEventType>(['tab_changed', 'tab_sampled'])
const SUPERVISOR_EVENT_TYPES = new Set<FocusEventType>([
  'idle_started',
  'idle_ended',
  'capture_started',
  'capture_stopped',
  'capture_paused',
  'capture_resumed',
  'capture_failed',
  'capture_recovered',
])
const CAPTURE_STATE_EVENT_TYPES = new Set<FocusEventType>([
  'capture_started',
  'capture_stopped',
  'capture_paused',
  'capture_resumed',
  'capture_failed',
  'capture_recovered',
])

export interface FocusEvent<TSource extends FocusEventSource = FocusEventSource> {
  ts_ms: number
  mono_ns: number
  event_type: FocusEventType
  app_bundle_id: string | null
  app_name: string | null
  pid: number | null
  window_title: string | null
  url: string | null
  page_title: string | null
  source: TSource
  confidence: FocusEventConfidence
  platform: string
  schema_ver: number
}

export function isFocusEventType(value: unknown): value is FocusEventType {
  return typeof value === 'string' && FOCUS_EVENT_TYPE_SET.has(value)
}

export function isFocusEventConfidence(value: unknown): value is FocusEventConfidence {
  return typeof value === 'string' && FOCUS_EVENT_CONFIDENCE_SET.has(value)
}

export function isMacFocusEventSource(value: unknown): value is MacFocusEventSource {
  return typeof value === 'string' && MAC_FOCUS_EVENT_SOURCE_SET.has(value)
}

export function isWindowsFocusEventSource(value: unknown): value is WindowsFocusEventSource {
  return typeof value === 'string' && WINDOWS_FOCUS_EVENT_SOURCE_SET.has(value)
}

export function isFocusEventSource(value: unknown): value is FocusEventSource {
  return (
    isMacFocusEventSource(value) ||
    isWindowsFocusEventSource(value) ||
    value === SUPERVISOR_FOCUS_EVENT_SOURCE ||
    value === POLL_FOCUS_EVENT_SOURCE
  )
}

export function isSupportedFocusEventSchemaVersion(value: unknown): value is number {
  return typeof value === 'number' && SUPPORTED_FOCUS_EVENT_SCHEMA_VERSIONS.has(value)
}

export function isCaptureStateFocusEventType(value: FocusEventType): boolean {
  return CAPTURE_STATE_EVENT_TYPES.has(value)
}

export function sourceAcceptsFocusEventType(source: FocusEventSource, eventType: FocusEventType): boolean {
  if (source === 'apple_events_tab' || source === 'uia_tab') return TAB_EVENT_TYPES.has(eventType)
  if (source === SUPERVISOR_FOCUS_EVENT_SOURCE) return SUPERVISOR_EVENT_TYPES.has(eventType)
  // Foreground observers — native helpers and the poll sampler alike — own the
  // application/window/machine-state family only.
  return !TAB_EVENT_TYPES.has(eventType) && !SUPERVISOR_EVENT_TYPES.has(eventType)
}

// Supervisor events — idle transitions and capture health — explain missing
// data. The capture_supervisor source is content-free: none of its events may
// carry application names, titles, URLs, or any personal content, even when
// one is derived from a foreground event.
export function supervisorEventCarriesContent(event: Pick<
  FocusEvent,
  'event_type' | 'app_bundle_id' | 'app_name' | 'window_title' | 'url' | 'page_title'
>): boolean {
  if (!SUPERVISOR_EVENT_TYPES.has(event.event_type)) return false
  return (
    event.app_bundle_id !== null ||
    event.app_name !== null ||
    event.window_title !== null ||
    event.url !== null ||
    event.page_title !== null
  )
}

export interface FocusEventProvenance {
  method: string
  permissionScope: string
}

const SOURCE_PROVENANCE: Record<FocusEventSource, FocusEventProvenance> = {
  nsworkspace_event: { method: 'nsworkspace_event', permissionScope: 'macos_foreground_observation' },
  apple_events_tab: { method: 'apple_events_tab', permissionScope: 'macos_apple_events_automation' },
  uia_foreground: { method: 'uia_foreground', permissionScope: 'windows_uia_foreground' },
  uia_tab: { method: 'uia_tab', permissionScope: 'windows_uia_foreground' },
  capture_supervisor: { method: 'capture_supervisor', permissionScope: 'application_internal' },
  foreground_poll: { method: 'foreground_poll', permissionScope: 'active_window_poll' },
}

export function provenanceForFocusEventSource(source: FocusEventSource): FocusEventProvenance {
  return SOURCE_PROVENANCE[source]
}

// Fields the repository stamps onto every canonical row. Adapters may supply
// them explicitly; anything omitted gets the source-derived default.
export interface FocusEventEvidenceFields {
  evidence_id: string
  sensitivity: EvidenceSensitivity
  provenance_method: string
  permission_scope: string
  policy_version: number
}

export type FocusEventInsert = FocusEvent & Partial<FocusEventEvidenceFields>

export type FocusEventRejectionReason =
  | 'unsupported_schema_version'
  | 'unknown_source'
  | 'unknown_event_type'
  | 'unknown_confidence'
  | 'source_kind_mismatch'
  | 'supervisor_content'
  | 'invalid_sensitivity'
  | 'page_content_violation'

// Mirrors the storage CHECK constraints so an invalid event is rejected and
// counted here instead of being silently skipped by the idempotent insert:
// foreground sources never carry page content, unknown confidence never
// carries page content, and an observed tab event must name its URL.
function violatesPageContentRules(event: FocusEventInsert): boolean {
  const hasPageContent = event.url !== null || event.page_title !== null
  if (event.confidence === 'unknown' && hasPageContent) return true
  if (
    (event.source === 'nsworkspace_event' || event.source === 'uia_foreground' || event.source === POLL_FOCUS_EVENT_SOURCE)
    && hasPageContent
  ) return true
  if (
    (event.source === 'apple_events_tab' || event.source === 'uia_tab') &&
    event.confidence === 'observed' && !event.url
  ) return true
  return false
}

// Values outside the storage allowlists are rejected here as well: the
// idempotent INSERT OR IGNORE would otherwise swallow their CHECK violations
// and miscount the lost rows as duplicates.
export function validateFocusEventForInsert(event: FocusEventInsert): FocusEventRejectionReason | null {
  if (!isSupportedFocusEventSchemaVersion(event.schema_ver)) return 'unsupported_schema_version'
  if (!isFocusEventSource(event.source)) return 'unknown_source'
  if (!isFocusEventType(event.event_type)) return 'unknown_event_type'
  if (!isFocusEventConfidence(event.confidence)) return 'unknown_confidence'
  if (!sourceAcceptsFocusEventType(event.source, event.event_type)) return 'source_kind_mismatch'
  if (supervisorEventCarriesContent(event)) return 'supervisor_content'
  if (violatesPageContentRules(event)) return 'page_content_violation'
  if (event.sensitivity !== undefined && !isEvidenceSensitivity(event.sensitivity)) return 'invalid_sensitivity'
  return null
}

// Storage keeps the raw helper vocabulary ('lock', 'space_changed', …); the
// envelope boundary speaks the canonical kind names from the specification.
const FOCUS_EVENT_TYPE_TO_EVIDENCE_KIND: Partial<Record<
  FocusEventType,
  | 'app_activated'
  | 'app_deactivated'
  | 'window_changed'
  | MachineStateEvidenceKind
  | CaptureStateEvidenceKind
>> = {
  app_activated: 'app_activated',
  app_deactivated: 'app_deactivated',
  window_changed: 'window_changed',
  space_changed: 'window_changed',
  sleep: 'sleep',
  wake: 'wake',
  lock: 'locked',
  unlock: 'unlocked',
  idle_started: 'idle_started',
  idle_ended: 'idle_ended',
  capture_started: 'capture_started',
  capture_stopped: 'capture_stopped',
  capture_paused: 'capture_paused',
  capture_resumed: 'capture_resumed',
  capture_failed: 'capture_failed',
  capture_recovered: 'capture_recovered',
}

export type FocusEvidenceKind = NonNullable<
  typeof FOCUS_EVENT_TYPE_TO_EVIDENCE_KIND[FocusEventType]
>

// Tab events return null: browser page evidence has its own identity and
// privacy verification and is exposed through the browser-evidence path, not
// this envelope.
export function evidenceKindForFocusEventType(eventType: FocusEventType): FocusEvidenceKind | null {
  return FOCUS_EVENT_TYPE_TO_EVIDENCE_KIND[eventType] ?? null
}
