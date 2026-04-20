import type {
  AppCategory,
  AppDetailPayload,
  AppUsageSummary,
  DayTimelinePayload,
  FocusSession,
  WebsiteSummary,
  WorkIntentSummary,
  WorkflowPattern,
} from '@shared/types'

export type ProjectionScope = 'timeline' | 'apps' | 'insights' | 'settings' | 'all'

export interface ProjectionInvalidationEvent {
  scope: ProjectionScope
  reason: string
  at: number
  date?: string | null
  canonicalAppId?: string | null
}

export type DerivedStateComponent =
  | 'app_normalization'
  | 'inference_pipeline'
  | 'projection_contracts'
  | 'assistant_context'

export interface DerivedStateVersion {
  component: DerivedStateComponent
  version: string
  rebuildRequired: boolean
  updatedAt: number
  notes?: string | null
}

export interface AssistantEvidenceBlock {
  id: string
  label: string
  startTime: number
  endTime: number
  dominantCategory: AppCategory
  workIntent: WorkIntentSummary
  topApps: string[]
  topSites: string[]
  topArtifacts: string[]
  focusOverlapSeconds: number
}

export interface AssistantEvidencePack {
  generatedAt: number
  date: string
  totals: {
    trackedSeconds: number
    focusSeconds: number
    focusPct: number
    appCount: number
    siteCount: number
  }
  topApps: AppUsageSummary[]
  topWebsites: WebsiteSummary[]
  timeline: Pick<DayTimelinePayload, 'date' | 'computedAt' | 'version'> & {
    blocks: AssistantEvidenceBlock[]
  }
  workflows: WorkflowPattern[]
  focusSessions: FocusSession[]
  appSpotlights: AppDetailPayload[]
  caveats: string[]
}
