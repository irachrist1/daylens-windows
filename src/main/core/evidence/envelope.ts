// The canonical evidence contract. Every adapter exposes observations through
// this envelope. It is an application boundary: source-specific tables may
// store payload fields efficiently, but repositories return this shape so
// consumers never depend on storage layout.

export const EVIDENCE_SENSITIVITIES = ['standard', 'personal', 'high'] as const
export const EVIDENCE_CONFIDENCES = ['observed', 'corroborated', 'inferred', 'unknown'] as const

export const APPLICATION_EVIDENCE_KINDS = [
  'app_activated',
  'app_deactivated',
  'window_changed',
] as const

export const BROWSER_EVIDENCE_KINDS = [
  'page_started',
  'page_ended',
  'page_visited',
] as const

export const MACHINE_STATE_EVIDENCE_KINDS = [
  'idle_started',
  'idle_ended',
  'locked',
  'unlocked',
  'sleep',
  'wake',
] as const

export const CAPTURE_STATE_EVIDENCE_KINDS = [
  'capture_started',
  'capture_stopped',
  'capture_paused',
  'capture_resumed',
  'capture_failed',
  'capture_recovered',
] as const

export const CONNECTED_SOURCE_EVIDENCE_KINDS = [
  'calendar_event',
  'meeting_record',
  'repository_activity',
  'message_reference',
  'document_reference',
] as const

export type EvidenceSensitivity = typeof EVIDENCE_SENSITIVITIES[number]
export type EvidenceConfidence = typeof EVIDENCE_CONFIDENCES[number]
export type ApplicationEvidenceKind = typeof APPLICATION_EVIDENCE_KINDS[number]
export type BrowserEvidenceKind = typeof BROWSER_EVIDENCE_KINDS[number]
export type MachineStateEvidenceKind = typeof MACHINE_STATE_EVIDENCE_KINDS[number]
export type CaptureStateEvidenceKind = typeof CAPTURE_STATE_EVIDENCE_KINDS[number]
export type ConnectedSourceEvidenceKind = typeof CONNECTED_SOURCE_EVIDENCE_KINDS[number]

export type EvidenceKind =
  | ApplicationEvidenceKind
  | BrowserEvidenceKind
  | MachineStateEvidenceKind
  | CaptureStateEvidenceKind
  | ConnectedSourceEvidenceKind

export interface EvidenceSource {
  adapter: string
  deviceId: string
  sourceRecordId: string | null
}

export interface EvidenceProvenance {
  method: string
  permissionScope: string
  policyVersion: number
}

export interface EvidenceInterval {
  startMs: number
  endMs: number | null
}

export interface EvidenceSubjects {
  applicationId?: string
  pageId?: string
  fileId?: string
  meetingId?: string
  personIds?: string[]
  projectId?: string
  clientId?: string
}

export interface EvidenceEnvelope<TKind extends EvidenceKind = EvidenceKind, TPayload = unknown> {
  evidenceId: string
  kind: TKind
  source: EvidenceSource
  observedAtMs: number
  monotonicNs: number | null
  interval: EvidenceInterval | null
  subjects: EvidenceSubjects
  sensitivity: EvidenceSensitivity
  confidence: EvidenceConfidence
  provenance: EvidenceProvenance
  schemaVersion: number
  payload: TPayload
}

const EVIDENCE_SENSITIVITY_SET = new Set<string>(EVIDENCE_SENSITIVITIES)
const EVIDENCE_CONFIDENCE_SET = new Set<string>(EVIDENCE_CONFIDENCES)
const CAPTURE_STATE_KIND_SET = new Set<string>(CAPTURE_STATE_EVIDENCE_KINDS)
const MACHINE_STATE_KIND_SET = new Set<string>(MACHINE_STATE_EVIDENCE_KINDS)

export function isEvidenceSensitivity(value: unknown): value is EvidenceSensitivity {
  return typeof value === 'string' && EVIDENCE_SENSITIVITY_SET.has(value)
}

export function isEvidenceConfidence(value: unknown): value is EvidenceConfidence {
  return typeof value === 'string' && EVIDENCE_CONFIDENCE_SET.has(value)
}

export function isCaptureStateEvidenceKind(value: unknown): value is CaptureStateEvidenceKind {
  return typeof value === 'string' && CAPTURE_STATE_KIND_SET.has(value)
}

export function isMachineStateEvidenceKind(value: unknown): value is MachineStateEvidenceKind {
  return typeof value === 'string' && MACHINE_STATE_KIND_SET.has(value)
}
