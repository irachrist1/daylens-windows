export type Platform = 'macos' | 'windows' | 'linux'

export type Category =
  | 'development'
  | 'communication'
  | 'research'
  | 'writing'
  | 'aiTools'
  | 'design'
  | 'browsing'
  | 'meetings'
  | 'entertainment'
  | 'email'
  | 'productivity'
  | 'social'
  | 'system'
  | 'uncategorized'

export type FocusSessionStatus = 'completed' | 'cancelled' | 'active'

export interface AppSummary {
  appKey: string
  bundleID?: string
  displayName: string
  category: Category
  totalSeconds: number
  sessionCount: number
  iconBase64?: string
}

export interface CategoryTotal {
  category: Category
  totalSeconds: number
}

export interface TimelineEntry {
  appKey: string
  startAt: string
  endAt: string
}

export interface TopPage {
  url: string
  title?: string | null
  seconds: number
}

export interface TopDomain {
  domain: string
  seconds: number
  category: Category
  topPages?: TopPage[]
}

export interface FocusSession {
  sourceId: string
  startAt: string
  endAt: string
  actualDurationSec: number
  targetMinutes: number
  status: FocusSessionStatus
}

export interface FocusScoreV2Snapshot {
  score: number
  coherence: number
  deepWorkDensity: number
  artifactProgress: number
  switchPenalty: number
}

export interface WorkBlockSummary {
  id: string
  startAt: string
  endAt: string
  label: string
  labelSource: 'user' | 'ai' | 'rule'
  dominantCategory: Category
  focusSeconds: number
  switchCount: number
  confidence: 'high' | 'medium' | 'low'
  topApps: Array<{
    appKey: string
    seconds: number
  }>
  topPages: Array<{
    domain: string
    title: string | null
    seconds: number
  }>
  artifactIds: string[]
}

export type RecapChapterId = 'headline' | 'focus' | 'artifacts' | 'rhythm' | 'change'

export interface RecapSummaryLite {
  headline: string
  chapters: Array<{
    id: RecapChapterId
    eyebrow: string
    title: string
    body: string
  }>
  metrics: Array<{
    label: string
    value: string
    detail: string
  }>
  changeSummary: string
  promptChips: string[]
  hasData: boolean
}

export interface RecapCoverage {
  attributedPct: number
  untitledPct: number
  activeDayCount: number
  quietDayCount: number
  hasComparison: boolean
  coverageNote: string | null
}

export interface WorkstreamRollup {
  label: string
  seconds: number
  blockCount: number
  isUntitled: boolean
}

export type ArtifactKind =
  | 'markdown'
  | 'csv'
  | 'json_table'
  | 'html_chart'
  | 'report'

export interface ArtifactRollup {
  id: string
  kind: ArtifactKind
  title: string
  byteSize: number
  generatedAt: string
  threadId: string | null
}

export interface EntityRollup {
  id: string
  label: string
  kind: 'client' | 'project' | 'repo' | 'topic'
  secondsToday: number
  blockCount: number
}

export interface DaySnapshotV1 {
  schemaVersion: 1
  deviceId: string
  platform: Platform
  date: string
  generatedAt: string
  isPartialDay: boolean
  focusScore: number
  focusSeconds: number
  appSummaries: AppSummary[]
  categoryTotals: CategoryTotal[]
  timeline: TimelineEntry[]
  topDomains: TopDomain[]
  categoryOverrides: Record<string, Category>
  aiSummary: string | null
  focusSessions: FocusSession[]
}

export interface DaySnapshotV2 extends Omit<DaySnapshotV1, 'schemaVersion'> {
  schemaVersion: 2
  focusScoreV2: FocusScoreV2Snapshot
  workBlocks: WorkBlockSummary[]
  recap: {
    day: RecapSummaryLite
    week: RecapSummaryLite | null
    month: RecapSummaryLite | null
  }
  coverage: RecapCoverage
  topWorkstreams: WorkstreamRollup[]
  standoutArtifacts: ArtifactRollup[]
  entities: EntityRollup[]
  hiddenByPreferences: boolean
}

export type DaySnapshot = DaySnapshotV1 | DaySnapshotV2

export const SNAPSHOT_SCHEMA_VERSION = 2

export function readSnapshotFocusScore(snapshot: DaySnapshot): number {
  if (snapshot.schemaVersion === 2) {
    return snapshot.focusScoreV2.score
  }
  return snapshot.focusScore
}
