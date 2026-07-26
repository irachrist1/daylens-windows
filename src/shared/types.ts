// ---------------------------------------------------------------------------
// Shared types — imported by both main and renderer via path alias @shared/*
// ---------------------------------------------------------------------------

// Sentinel "days" value for the Apps view's All-time period. Large enough to
// span all captured history (~100 years) so the range reaches epoch, and shared
// so the renderer's range key and the main-process queries agree on the value.
export const ALL_TIME_DAYS = 36500

export interface AppSession {
  id: number
  bundleId: string          // exe name on Windows, bundle ID on macOS
  appName: string
  startTime: number         // Unix ms
  endTime: number | null
  durationSeconds: number
  category: AppCategory
  isFocused: boolean
  windowTitle?: string | null
  rawAppName?: string | null
  canonicalAppId?: string | null
  appInstanceId?: string | null
  captureSource?: string | null
  endedReason?: string | null
  captureVersion?: number
}

export interface AppUsageSummary {
  bundleId: string
  canonicalAppId?: string | null
  appName: string
  category: AppCategory
  totalSeconds: number
  isFocused: boolean
  sessionCount?: number   // populated from DB queries; absent for live/synthetic entries
}

// What a category relabel touched, so Settings can report its effect instead of
// changing silently (settings spec §4).
export interface CategoryOverrideEffect {
  daysAffected: number
  sessionsAffected: number
}

/** One atomic save from the Timeline block editor. All supplied changes either
 * commit together or roll back together in the main-process transaction. */
export interface TimelineBlockEditPayload {
  blockId: string
  date: string
  label?: string
  category?: AppCategory
  startMs?: number
  endMs?: number
}

export interface TimelineBlockEditResult {
  changed: boolean
  changedFields: Array<'label' | 'category' | 'time'>
}

// ─── Correction commands (timeline spec, Corrections) ────────────────────────
// One typed command per correction a person can make. Every command previews
// its effect on time, entities, Timeline, Apps, and search before applying,
// applies atomically, and can be undone. Permanent purges are NOT commands —
// they stay on their own destructive, confirmed, no-undo path.

export interface ExcludedEvidenceRef {
  kind: 'app' | 'site'
  bundleId?: string | null
  appName?: string | null
  domain?: string | null
}

export type CorrectionCommand =
  | { kind: 'edit'; date: string; blockId: string; label?: string; category?: AppCategory; startMs?: number; endMs?: number }
  | { kind: 'merge'; date: string; blockIds: string[] }
  | { kind: 'split'; date: string; blockId: string; cutMs: number }
  | { kind: 'exclude-block'; date: string; blockId: string }
  | { kind: 'exclude-evidence'; date: string; blockId: string; evidence: ExcludedEvidenceRef }
  | { kind: 'assign-client'; date: string; blockId: string; clientId: string | null; projectId?: string | null }
  // DEV-189 (timeline.md §Meetings): mark a scheduled meeting as attended,
  // skipped, moved, or unrelated. status null clears the mark. The meeting is
  // addressed by its scheduled identity, not a block id — a calendar-only
  // event has no block.
  | { kind: 'mark-meeting'; date: string; meeting: { title: string; startMs: number }; status: 'attended' | 'skipped' | 'moved' | 'unrelated' | null }

export interface CorrectionBlockDelta {
  blockId: string
  labelBefore: string
  /** null = the block is gone after the correction (merged away or excluded). */
  labelAfter: string | null
  startMsBefore: number
  endMsBefore: number
  startMsAfter: number | null
  endMsAfter: number | null
  categoryBefore: AppCategory
  categoryAfter: AppCategory | null
}

export interface CorrectionAppDelta {
  appName: string
  secondsBefore: number
  secondsAfter: number
}

export interface CorrectionPreview {
  /** One human sentence naming the correction, e.g. `Rename "A" to "B"`. */
  description: string
  totalSecondsBefore: number
  totalSecondsAfter: number
  blockCountBefore: number
  blockCountAfter: number
  /** Blocks whose label, span, or category the correction changes. */
  blocks: CorrectionBlockDelta[]
  /** Apps whose day total the correction changes (Apps view delta). */
  apps: CorrectionAppDelta[]
  /** Plain sentences on how consuming surfaces change (search, AI, client rollups). */
  surfaces: string[]
}

export interface CorrectionApplyResult {
  correctionId: string
  description: string
}

export interface CorrectionUndoResult {
  undone: boolean
  description: string
}

// Each Apps row leads with what was accomplished, not how long.
// This compact digest provides the headline activity per app over a range —
// the top work block the app participated in and the top artifact it touched.
export interface AppActivityDigest {
  canonicalAppId: string
  bundleId: string
  appName: string
  topBlockLabel: string | null
  topArtifactTitle: string | null
}

export type BlockConfidence = 'high' | 'medium' | 'low'

// The `kind` axis — orthogonal to AppCategory — answers "is this work at all?".
// Resolved from category + domain + app in src/shared/workKind.ts. This is the
// distinction that makes leisure first-class: a video is never a "work session".
export type WorkKind = 'work' | 'leisure' | 'personal' | 'idle'

export const WORK_INTENT_ROLES = [
  'execution',
  'research',
  'communication',
  'review',
  'coordination',
  'ambient',
  'ambiguous',
] as const

export type WorkIntentRole = typeof WORK_INTENT_ROLES[number]

export function isWorkIntentRole(value: unknown): value is WorkIntentRole {
  return typeof value === 'string' && (WORK_INTENT_ROLES as readonly string[]).includes(value)
}

export type WorkIntentPageKind =
  | 'feed'
  | 'thread'
  | 'search'
  | 'article'
  | 'repo'
  | 'pull_request'
  | 'issue'
  | 'doc'
  | 'sheet'
  | 'slide'
  | 'chat'
  | 'video'
  | 'mailbox'
  | 'calendar'
  | 'meeting'
  | 'design'
  | 'website'
  | 'unknown'

export interface WorkIntentSummary {
  role: WorkIntentRole
  subject: string | null
  confidence: number
  summary: string
  rationale: string[]
  pageKinds: WorkIntentPageKind[]
}

// Why an intent episode begins or ends. Segmentation scores every candidate
// boundary from these signals; the winning reason(s) are recorded on the
// episode so each block can explain why it started and stopped. `day-start` /
// `day-end` are the implicit edges of the day; `none` is the placeholder for an
// edge that was never cut (kept here only for internal completeness).
export type BoundaryReason =
  | 'day-start'
  | 'day-end'
  | 'idle-gap'
  | 'meeting-start'
  | 'meeting-end'
  | 'artifact-change'
  | 'repo-change'
  | 'category-shift'
  | 'kind-shift'
  | 'research-to-execution'
  | 'detour-start'
  | 'detour-end'
  | 'subject-change'
  | 'user-merge'
  | 'user-cut'

// The boundary reasons that opened and closed a block/episode. Always
// populated (at minimum the day edges), so every block can explain itself.
export interface BlockBoundary {
  startReasons: BoundaryReason[]
  endReasons: BoundaryReason[]
}

export type TimelineBlockReviewState =
  | 'auto-approved'
  | 'pending'
  | 'approved'
  | 'corrected'
  | 'ignored'

export interface TimelineBlockReview {
  state: TimelineBlockReviewState
  source: 'default' | 'stored_block' | 'stored_evidence'
  originalBlockId: string | null
  originalLabel: string | null
  originalIntentRole: WorkIntentRole | null
  originalIntentSubject: string | null
  correctedLabel: string | null
  correctedIntentRole: WorkIntentRole | null
  correctedIntentSubject: string | null
  // A user recategorization (Edit → Type). Wins over the computed dominant
  // category on every read and recolors the block everywhere (invariant 8).
  correctedCategory: AppCategory | null
  updatedAt: number | null
}

export interface TimelineBlockReviewUpdate {
  blockId: string
  date?: string | null
  state: TimelineBlockReviewState
  correctedLabel?: string | null
  correctedIntentRole?: WorkIntentRole | null
  correctedIntentSubject?: string | null
  correctedCategory?: AppCategory | null
}

// Permanently delete a sensitive tracked record from the app — the underlying
// rows (sessions, visits, focus events, artifacts), not a display filter. Used
// by the block editor's per-entry remove; scoped to the block's time span so
// "this visit" disappears from every surface (timeline, apps, AI, wraps).
export interface PurgeTrackedEvidencePayload {
  kind: 'app' | 'site'
  bundleId?: string
  appName?: string
  domain?: string
  fromMs: number
  toMs: number
}

export interface FocusScoreBreakdown {
  deepWorkPct: number | null
  longestStreakSeconds: number
  switchCount: number
  deepWorkSessionCount: number
}

export interface WorkContextAppSummary {
  bundleId: string
  // Canonical app identity when known — how a site/page row finds the app it
  // happened inside when bundle ids differ across capture sources.
  canonicalAppId?: string | null
  appName: string
  category: AppCategory
  totalSeconds: number
  sessionCount: number
  isBrowser: boolean
}

export interface WorkContextBlock {
  id: string
  startTime: number
  endTime: number
  dominantCategory: AppCategory
  categoryDistribution: Partial<Record<AppCategory, number>>
  ruleBasedLabel: string
  aiLabel: string | null
  sessions: AppSession[]
  topApps: WorkContextAppSummary[]
  websites: WebsiteSummary[]
  keyPages: string[]
  pageRefs: PageRef[]
  documentRefs: DocumentRef[]
  topArtifacts: ArtifactRef[]
  workflowRefs: WorkflowRef[]
  label: BlockLabel
  focusOverlap: FocusOverlapSummary
  evidenceSummary: TimelineEvidenceSummary
  heuristicVersion: string
  computedAt: number
  switchCount: number
  confidence: BlockConfidence
  review: TimelineBlockReview
  isLive: boolean
  // The work/leisure/personal/idle axis for this block, resolved from
  // category + domain + app. Additive — older persisted/derived blocks that
  // predate the field fall back to a computed default (resolveBlockKind).
  kind?: WorkKind
  // Why this block started and stopped. Projected from the IntentEpisode the
  // block was built from; always non-empty (day edges at minimum). Additive —
  // older persisted/derived blocks fall back to a computed default.
  boundary?: BlockBoundary
  // The live day before it has been analyzed: one neutral provisional block per
  // idle-bounded stretch ("Active now"), never per-activity named. Set only on
  // the today view before Analyze Day / nightly finalize. The renderer hides
  // Rename/Merge/Hide and the category badge for these.
  provisional?: boolean
}

// A gap on the timeline always carries the reason it happened — looking at a
// day retroactively you can tell what kind of absence each blank stretch was,
// derived from the activity-state events that covered it:
//   asleep    — machine suspended / lid closed
//   locked    — screen locked; user confirmed not present
//   idle      — machine open and unlocked, but no input for a sustained stretch
//   passive   — no input but something was actively playing (video, meeting):
//               present, just not typing
//   paused    — the user paused tracking (settings/tray)
//   untracked — no signal at all: Daylens wasn't running
// The legacy kinds (idle_gap / away / machine_off) remain for older producers.
export interface TimelineGapSegment {
  kind: 'idle_gap' | 'away' | 'machine_off' | 'asleep' | 'locked' | 'idle' | 'passive' | 'paused' | 'untracked'
  startTime: number
  endTime: number
  label: string
  source: 'derived_gap' | 'activity_event'
}

interface TimelineBlockSegment {
  kind: 'work_block'
  startTime: number
  endTime: number
  blockId: string
}

export type TimelineSegment = TimelineBlockSegment | TimelineGapSegment

// An app that was full-screen-visible on a display while input focus lived
// elsewhere (e.g. a course playing on monitor 2 while notes were typed on
// monitor 1). presence is the honesty label: this is visible/playing time,
// NOT input-focused foreground time — it never adds to totalSeconds, and any
// surface that reports it must say what it is. Time where the same app also
// owned focus is already subtracted, so a minute is never counted twice.
export interface SecondaryDisplayVisibleSpan {
  displayId: number
  bundleId: string | null
  appName: string | null
  windowTitle: string | null
  startTime: number
  endTime: number
  presence: 'visible'
}

/** One durable entity the day's evidence supports naming — a project, client,
 *  person, meeting, or repository from the entity ledger whose evidence spans
 *  overlap the day's surviving (trusted, undeleted) blocks. The wrap's
 *  "what the day was about" scene reads these; seconds are the overlap with
 *  the surviving blocks, so deleted evidence can never lend an entity time. */
export interface DayWrapEntity {
  id: string
  type: 'project' | 'client' | 'person' | 'meeting' | 'repository'
  name: string
  seconds: number
}

export interface DayTimelinePayload {
  date: string
  sessions: AppSession[]
  websites: WebsiteSummary[]
  blocks: WorkContextBlock[]
  segments: TimelineSegment[]
  focusSessions: FocusSession[]
  computedAt: number
  version: string
  totalSeconds: number
  focusSeconds: number
  focusPct: number
  appCount: number
  siteCount: number
  // Additive: what secondary displays showed while focus was elsewhere.
  // Absent on payloads that predate multi-display capture.
  secondaryDisplay?: SecondaryDisplayVisibleSpan[]
  // Additive (DEV-189): the day's scheduled calendar events resolved against
  // the day's own meeting blocks. Matched events annotate their block as an
  // attended meeting (with the scheduled range as context); calendar-only
  // events render as scheduled context — an outline, never a block, never
  // counted in totalSeconds. Captured-only meetings need no entry here: they
  // ARE blocks. Absent when no calendar signal is stored for the day.
  scheduledMeetings?: TimelineScheduledMeeting[]
  // Additive: the durable entities the day's evidence supports naming.
  // Absent on payloads built before the entity ledger existed.
  dayEntities?: DayWrapEntity[]
}

/** What a manual Analyze / Re-analyze run actually did, so the UI reports the
 *  real outcome instead of a fixed success message (DEV-231). */
export interface RebuildTimelineDayResult {
  payload: DayTimelinePayload
  changed: boolean
  merged: boolean
  mergedCount: number
  relabeled: number
  attempted: number
  failed: number
  /** Why the failed blocks could not be named (first distinct reason), in words
   *  the person can act on — so the UI never reports a bare count (DEV-278). */
  failureReason?: string | null
}

/** A progress tick streamed while a day is analyzed (DEV-270). `stage` names
 *  the phase the pipeline is actually in; `done`/`total` are populated during
 *  the per-block naming phase so the UI can show real progress, not a spinner. */
export interface TimelineAnalyzeProgress {
  stage: 'preparing' | 'merging' | 'naming' | 'finishing'
  done: number
  total: number
}

/** One scheduled calendar event as the Timeline day view shows it (DEV-189).
 *  `attendance` is honest: 'matched' means captured meeting-app evidence OR
 *  the person's explicit confirmation supports it (a block id is present only
 *  for the evidence case); 'calendar_only' means it is scheduled context with
 *  NO support that the meeting happened. `marked` carries the person's own
 *  attended/skipped/moved/unrelated correction when one exists. */
export interface TimelineScheduledMeeting {
  title: string
  startMs: number
  endMs: number
  attendeeCount: number | null
  /** Attendee display names when the calendar source carries them. Evidence
   *  surface only — never wrap copy. */
  participants: string[]
  attendance: 'matched' | 'calendar_only'
  marked: 'attended' | 'skipped' | 'moved' | 'unrelated' | null
  matchedBlockId: string | null
}

// One thing the day-analysis agent could not settle from evidence and that
// would materially change the account — surfaced to the person as an
// answer-or-skip question (the interpretation agent's clarification contract).
// Answering writes a durable correction (a block label, an attendance mark);
// skipping is remembered so the same question is not re-asked.
export interface TimelineClarificationOption {
  id: string
  label: string
}

export interface TimelineClarification {
  /** Stable across reads (date + kind + block/event identity) so a skip or
   *  answer de-duplicates the same question. */
  id: string
  kind: 'unnamed-block' | 'unconfirmed-meeting'
  date: string
  /** The whole span the question is about, for display. */
  timeRange: string
  question: string
  /** Candidate answers drawn from the block's own evidence; the UI always adds
   *  a free-text option and a Skip. */
  options: TimelineClarificationOption[]
  /** Present for 'unnamed-block'. */
  blockId?: string
  /** Present for 'unconfirmed-meeting' — the attendance-mark identity. */
  eventKey?: string
  meetingTitle?: string
}

export interface TimelineClarificationAnswer {
  id: string
  kind: 'unnamed-block' | 'unconfirmed-meeting'
  /** 'skip' remembers the dismissal; 'answer' applies the durable correction. */
  action: 'answer' | 'skip'
  blockId?: string
  /** For an answered 'unnamed-block': the chosen or typed activity label. */
  label?: string
  eventKey?: string
  /** For an answered 'unconfirmed-meeting'. */
  attendance?: 'attended' | 'skipped' | 'moved' | 'unrelated'
}

export type HistoryDayPayload = DayTimelinePayload

// One block as the calendar month grid reads it: the same persisted
// timeline_blocks truth the day view renders, reduced to what a day cell
// shows. Label resolution mirrors userVisibleBlockLabel — a user rename
// (block_label_overrides) always wins over label_current.
export interface CalendarRangeBlock {
  id: string
  date: string
  startTime: number
  endTime: number
  dominantCategory: AppCategory
  label: string
  kind: WorkKind
  activeSeconds: number
}

export interface CalendarRangeDay {
  date: string
  blocks: CalendarRangeBlock[]
  activeSeconds: number
}

export interface WorkContextInsight {
  label: string | null
  narrative: string | null
}

interface WorkMemoryPatternSummary {
  id: string
  label: string
  category: AppCategory | null
  confidence: number
  recallCount: number
  occurrenceCount: number
  updatedAt: number
}

export interface WorkMemorySettingsSummary {
  promotedCount: number
  totalOccurrences: number
  topPatterns: WorkMemoryPatternSummary[]
}

// Work memory as an editable, human-readable profile (ChatGPT-style) — replaces
// the opaque pattern table.
type WorkMemoryFactOrigin = 'drafted' | 'user'
// Where a fact came from, shown in the Manage-memory view. Durability is
// keyed on origin, never source.
type WorkMemoryFactSource = 'evidence' | 'chat' | 'hand'
// Which readable section a fact belongs to in the Manage-memory view.
// Derived deterministically from the fact, never persisted — grouping is
// cosmetic, never durability.
export type WorkMemoryCategory = 'work' | 'personal' | 'preferences'

export interface WorkMemoryFact {
  id: string
  text: string
  origin: WorkMemoryFactOrigin
  source: WorkMemoryFactSource
  category: WorkMemoryCategory
  /** True when the fact lives in the supplied-memory store (DEV-185). */
  supplied?: boolean
}

/** One confirmed personal fact (DEV-185): explicitly saved by the user, shown
 *  in Settings → Memory → "Things you've told me" with when/context, editable
 *  and deletable — deletion leaves retrieval and packets immediately. */
export interface SuppliedMemoryFactView {
  id: string
  statement: string
  scope: string
  source: 'chat' | 'hand' | 'migrated'
  context: string | null
  threadId: number | null
  confirmedAt: number
  updatedAt: number
}

/** A declined memory proposal (DEV-185): stored so the same fact is not
 *  proposed again; deletable like any memory. */
export interface MemoryProposalRejectionView {
  id: string
  statement: string
  rejectedAt: number
}

export interface WorkMemoryProfile {
  facts: WorkMemoryFact[]
}

// One client's scoped memory, shown under that client in the Manage-memory
// view. A client is a named memory scope.
export interface ClientMemoryGroup {
  clientId: string
  clientName: string
  color: string | null
  facts: WorkMemoryFact[]
}

// The whole memory picture for the Manage-memory view: general memory plus each
// client's scoped memory.
export interface ScopedMemoryProfile {
  general: WorkMemoryFact[]
  clients: ClientMemoryGroup[]
}

// One plain-language entry in the memory audit.
export interface MemoryAuditEntry {
  id: string
  action: 'remembered' | 'updated' | 'forgot'
  text: string
  source: 'chat' | 'hand'
  createdAt: number
}

// Rebuild / forget each report what changed in one plain-language line.
export interface WorkMemoryMutationResult {
  facts: WorkMemoryFact[]
  changeSummary: string
}

// Result of the one-shot work-memory backfill across the user's full history
// (R4). Returned to the renderer so the Settings panel can report what ran.
export interface MemoryBackfillResult {
  ran: boolean
  reason?: 'disabled' | 'no-tables' | 'no-history'
  fromDate: string | null
  throughDate: string | null
  daysProcessed: number
  daysArchived: number
  daysSkipped: number
  newCandidates: number
  promoted: number
  decayed: number
  backfilled: number
}

export interface AppCategorySuggestion {
  suggestedCategory: AppCategory | null
  reason: string | null
}

export interface FocusSession {
  id: number
  startTime: number
  endTime: number | null
  durationSeconds: number
  label: string | null
  targetMinutes: number | null
  plannedApps: string[]
  reflectionNote?: string | null
}

export interface FocusStartPayload {
  label?: string | null
  targetMinutes?: number | null
  plannedApps?: string[]
}

export interface FocusReflectionSavePayload {
  sessionId: number
  note: string
}

export interface AIDaySummaryResult {
  summary: string
  questionSuggestions: string[]
  /** True when this is the deterministic factual fallback shown because the AI
   *  recap could not be generated (unavailable / timed out / unparseable) — so
   *  the UI can say so plainly instead of passing a template off as the recap
   *  (DEV-270/275: nothing fails silently). Absent on a real AI recap and on the
   *  empty-day line. */
  degraded?: boolean
  /** Why the AI recap could not be generated, in words the person can act on
   *  (provider error, timeout, unreadable reply). Only set when degraded. */
  degradedReason?: string
}

export type AIAnswerKind =
  | 'weekly_brief'
  | 'weekly_literal_list'
  | 'deterministic_stats'
  | 'day_summary_style'
  | 'generated_report'
  | 'freeform_chat'
  | 'error'

export type AIConversationSourceKind = 'weekly_brief' | 'deterministic' | 'freeform'

export type FollowUpAffordance =
  | 'deepen'
  | 'literalize'
  | 'narrow'
  | 'expand'
  | 'compare'
  | 'switch_topic'
  | 'switch_timeframe'
  | 'repair'

type FollowUpResolutionKind =
  | 'fresh_query'
  | 'followup_reuse_context'
  | 'followup_with_override'
  | 'followup_repair'

export type FollowUpClass =
  | 'deepen'
  | 'literalize'
  | 'narrow'
  | 'expand'
  | 'compare'
  | 'topic_pivot'
  | 'time_override'
  | 'repair'

export interface AIConversationDateRange {
  fromMs: number
  toMs: number
  label: string
}

export interface AIWeeklyBriefStateSnapshot {
  intent: string
  responseMode: string
  topic: string | null
  dateRange: AIConversationDateRange
  evidenceKey: string | null
}

export interface AIEntityStateSnapshot {
  entityId: string
  entityName: string
  entityType: 'client' | 'project' | 'evidence'
  rangeStartMs: number
  rangeEndMs: number
  rangeLabel: string
  intent: string
}

export interface AIRoutingContextSnapshot {
  dateMs: number
  timeWindowStartMs: number | null
  timeWindowEndMs: number | null
  weeklyBrief: AIWeeklyBriefStateSnapshot | null
  entity: AIEntityStateSnapshot | null
}

export interface AIConversationState {
  dateRange: AIConversationDateRange | null
  topic: string | null
  responseMode: string | null
  lastIntent: string | null
  evidenceKey: string | null
  answerKind: AIAnswerKind | null
  sourceKind: AIConversationSourceKind | null
  followUpAffordances: FollowUpAffordance[]
  routingContext: AIRoutingContextSnapshot | null
}

export interface FollowUpSuggestion {
  text: string
  source: 'model' | 'deterministic'
  affordance?: FollowUpAffordance | null
}

export interface FollowUpResolution {
  kind: FollowUpResolutionKind
  followUpClass: FollowUpClass | null
  effectivePrompt: string
  shouldReuseContext: boolean
  shouldResetContext: boolean
}

export type AIMessageRating = 'up' | 'down'

interface AIStartFocusAction {
  kind: 'start_focus_session'
  label: string
  payload: FocusStartPayload
}

interface AIStopFocusAction {
  kind: 'stop_focus_session'
  label: string
  sessionId: number
}

interface AIReviewFocusAction {
  kind: 'review_focus_session'
  label: string
  sessionId: number
  placeholder?: string | null
  suggestedNote?: string | null
}

export type AIMessageAction = AIStartFocusAction | AIStopFocusAction | AIReviewFocusAction

// ── AI action widgets ───────────────────────────────────────────────────────
// The AI chat can ACT, not just answer. When you tell it to change something —
// rename a block, remember a fact, attribute an afternoon to a client — the main
// process resolves the instruction into one of these *proposals* and the chat
// renders a preview widget. Nothing is written until you confirm; the commit
// then runs through the SAME manual-edit pipeline. This is separate from the
// read-only resolvers — acting is explicit.

// The model picks the surface per action: a small inline card for a one-line
// change, the side canvas for a richer multi-item edit.
export type AIActionSurface = 'card' | 'canvas'

interface AIActionProposalBase {
  /** Stable id within the message — keys confirm/cancel/committed state. */
  proposalId: string
  surface: AIActionSurface
  /** Confirm-button label, e.g. "Rename block" / "Save to memory". */
  confirmLabel: string
  /** Merge / forget / archive need the stronger confirm (invariant 6). */
  destructive?: boolean
}

// One memory change inside a memory proposal, shown as a readable preview line.
export interface AIMemoryOpPreview {
  op: 'add' | 'update' | 'delete'
  /** New text for add/update; the affected fact's text for delete. */
  text: string
  /** Current text being replaced/removed (update/delete). */
  previousText?: string | null
  /** Existing fact id for update/delete. */
  targetId?: string | null
  /** Scope label, e.g. "Work" (general memory for now). */
  scope?: string | null
}

export interface AIMemoryProposal extends AIActionProposalBase {
  kind: 'memory_write'
  ops: AIMemoryOpPreview[]
  /** The scope new facts commit to: a `client:<id>` string for a client-scoped
   *  write (memory.md §2.2), or null/absent for general memory. */
  scopeId?: string | null
}

export interface AIRenameBlockProposal extends AIActionProposalBase {
  kind: 'rename_block'
  blockId: string
  date: string
  previousLabel: string
  nextLabel: string
  /** Human time range for the card header, e.g. "2:00–5:30pm". */
  timeRange: string
}

export interface AIMergeBlocksProposal extends AIActionProposalBase {
  kind: 'merge_blocks'
  date: string
  /** Earlier block first, later block second. */
  blockIds: [string, string]
  firstLabel: string
  secondLabel: string
  firstRange: string
  secondRange: string
  /** The combined span the merged block will cover. */
  mergedRange: string
}

export type AIActionWidget = AIMemoryProposal | AIRenameBlockProposal | AIMergeBlocksProposal

// The result of committing a proposal — drives the card's committed state and
// the one-line confirmation / undo affordance.
export interface AIActionCommitResult {
  ok: boolean
  /** Plain-language confirmation, e.g. "Renamed to \"Networking\"." */
  summary: string
  /** Present when the change is reversible from the card. */
  undo?: AIActionUndo | null
  error?: string | null
}

export type AIActionUndo =
  | { kind: 'restore_block_label'; blockId: string; date: string; previousLabel: string; hadOverride: boolean }
  | { kind: 'forget_memory_fact'; factId: string }

type AIMessageArtifactKind = 'report' | 'table' | 'chart' | 'export'
type AIMessageArtifactFormat = 'markdown' | 'csv' | 'html' | 'json' | 'pdf' | 'docx' | 'xlsx'

export interface AIMessageArtifact {
  id: string
  kind: AIMessageArtifactKind
  title: string
  subtitle?: string | null
  format: AIMessageArtifactFormat
  path: string
  openTarget: OpenTarget
  createdAt: number
}

type AISurfaceSummaryScope = 'timeline_week' | 'app_detail'

export interface AISurfaceSummary {
  scope: AISurfaceSummaryScope
  scopeKey: string
  jobType: Extract<AIJobType, 'week_review' | 'app_narrative'>
  title?: string | null
  summary: string
  updatedAt: number
  stale?: boolean
}

/** One step of the live activity trail while an agent turn runs. `id` is
 *  stable per tool call, so the renderer settles an active row in place when
 *  its result (or failure) arrives. `label` is always a short human one-liner
 *  — never raw tool arguments, payloads, or file paths. */
export type AIAgentStepState = 'active' | 'done' | 'failed'

export interface AIAgentStep {
  id: string
  label: string
  state: AIAgentStepState
  startedAt: number
}

export interface AIChatStreamEvent {
  requestId: string
  delta: string
  snapshot: string
  /** Short human status line while the agent works ("Searching for…"). */
  status?: string
  /** Structured step for the live activity trail. Rides alongside `status`,
   *  which stays populated for consumers of the plain status line. */
  step?: AIAgentStep
}

/** The agent's one clarifying question, pushed to the renderer. */
export interface AIAgentQuestionEvent {
  questionId: string
  requestId: string | null
  question: string
  options: string[]
  allowFreeText: boolean
}

// ─── Agent turn pause/resume (DEV-200) ───────────────────────────────────────
// ONE visible state machine for a long-running agent turn. Agent-initiated
// waits (the permission / confirmation / clarification cards, which all ride
// the askUser channel) and the user-initiated pause are phases of the same
// machine, not separate mechanisms. A paused turn persists as a checkpoint row
// so it survives an app restart; resume re-runs the question against a FRESH
// context packet (the day may have moved), which is exactly the degradation
// the runtime spec prescribes — provider session state is an execution detail
// rebuilt from the Daylens thread plus a fresh packet.

/** Lifecycle phase of one agent turn. Terminal phases (`completed`,
 *  `cancelled`, `failed`) delete the checkpoint — the durable transcript owns
 *  finished turns; the checkpoint ledger only ever holds outstanding work. */
export type AgentTurnPhase =
  | 'running'
  | 'awaiting_user'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed'

/** Why an agent-initiated wait is holding the turn — which card is up. */
export type AgentTurnWaitKind =
  | 'clarification'
  | 'file_permission'
  | 'memory_confirmation'
  | 'correction_confirmation'

/** Why a paused turn is paused: the user paused it, or a restart interrupted
 *  it mid-flight and recovery degraded it to a clean resumable checkpoint. */
export type AgentTurnPauseKind = 'user' | 'restart'

/** Phase-transition event for the in-flight turn, pushed to the renderer so
 *  the chat shows one honest state line (working / waiting on you / paused). */
export interface AIAgentTurnPhaseEvent {
  requestId: string
  phase: AgentTurnPhase
  /** Set while phase === 'awaiting_user': which card is holding the turn. */
  waitKind: AgentTurnWaitKind | null
  /** Set when phase === 'paused': the persisted checkpoint to resume from. */
  checkpointId: string | null
  pauseKind: AgentTurnPauseKind | null
}

/** A persisted resumable turn, as listed for the renderer. */
export interface AgentTurnCheckpointView {
  id: string
  threadId: number | null
  /** The user's question, verbatim — resume re-asks exactly this. */
  question: string
  phase: Extract<AgentTurnPhase, 'running' | 'awaiting_user' | 'paused'>
  pauseKind: AgentTurnPauseKind | null
  waitKind: AgentTurnWaitKind | null
  /** Last tool status line before the pause, for honest display ("Paused
   *  while searching your timeline"). Never raw arguments or payloads. */
  lastStatus: string | null
  createdAt: number
  updatedAt: number
}

// ─── Model picker costs (DEV-201) ────────────────────────────────────────────
// Cost transparency in money and estimated questions — never raw tokens first
// (billing-and-entitlements.md §Usage metering). Costs are computed in the
// main process from the same pricing table billing settlement estimates use,
// so the picker can never quote a different price than the meter charges.

/** Per-model cost line for the picker. */
export interface AIModelCostEntry {
  provider: AIProviderMode
  modelId: string
  /** Estimated cost of one typical Daylens question on this model, in USD. */
  typicalQuestionCostUsd: number
  /** Whole typical questions one US dollar covers on this model. */
  questionsPerUsd: number
}

/** Managed-allowance view for the picker, derived from the validated billing
 *  snapshot — remaining credit in money and estimated questions. */
export interface AIManagedAllowanceView {
  grantedUsd: number
  remainingUsd: number
  /** Whole typical questions the remaining credit still covers on the managed
   *  default tier. Null when there is no meaningful figure to divide. */
  estimatedQuestionsRemaining: number | null
  canUseManagedAI: boolean
  /** Plain-language reason when managed AI cannot serve a turn right now. */
  unavailableReason: string | null
}

export interface AIModelCostCatalog {
  models: AIModelCostEntry[]
  /** Null when this build has no billing service or it reports unavailable. */
  allowance: AIManagedAllowanceView | null
}

/** One file whose contents were disclosed to the model during a turn
 *  (DEV-184). Shown in the answer's sources row; the full record lives in the
 *  file_disclosures ledger. */
export interface AIMessageFileDisclosure {
  path: string
  name: string
  versionFingerprint: string
  excerptStart: number
  excerptEnd: number
  disclosedAt: number
}

/** One packet-item citation in an agent answer (DEV-182): the claim's
 *  superscript number and the recorded context-packet item it traces to. */
export interface AIMessageCitation {
  /** Display number, matching the superscript in the answer text. */
  marker: number
  /** Stable identity of the cited packet item (block:<id>, file:<path>, …). */
  identity: string
  kind: string
  /** The disclosed statement the claim traces to. */
  statement: string
}

// ─── Context packet inspection (DEV-183) ─────────────────────────────────────
// The renderer-facing shape of "what the AI saw" for one exchange: the
// recorded packet re-read from the local ledger, grouped per kind, with each
// item checked against the evidence that backs it today. Read-only — the
// inspector shows the record, it never edits it.

/** Whether the evidence behind a disclosed item still exists right now.
 *  The packet is a historical disclosure record: deleting evidence later
 *  cannot un-send it, so the inspector keeps the item and says what changed.
 *  - present: the backing record still exists.
 *  - deleted: the backing record has since been deleted or is no longer part
 *    of the current record (e.g. a recomputed timeline block).
 *  - access_revoked: the file grant that allowed the excerpt was revoked.
 *  - unverified: Daylens cannot check this identity form; stated, not hidden. */
export type ContextPacketEvidenceState = 'present' | 'deleted' | 'access_revoked' | 'unverified'

export interface ContextPacketInspectionItem {
  /** Stable identity of the underlying thing (block:<id>, file:<path>, …). */
  identity: string
  kind: string
  sourceType: string
  /** The exact statement or excerpt that was disclosed. */
  statement: string
  version: string | null
  /** Why this item was selected into the packet. */
  reason: string
  sensitivity: string
  date: string | null
  evidenceState: ContextPacketEvidenceState
  /** Plain-language note when evidenceState is not 'present'. */
  evidenceNote: string | null
}

/** One per-kind group. Every packet kind appears, empty or not, so the
 *  inspector can state honestly that e.g. no file contents were sent. */
export interface ContextPacketInspectionGroup {
  kind: string
  label: string
  items: ContextPacketInspectionItem[]
}

export interface ContextPacketInspectionOmission {
  kind: string
  count: number
  reason: string
  /** Plain-language rendering of the omission. */
  label: string
}

/** One tool the agent actually called during the exchange, read from the
 *  persisted turn trace bound to the packet's assistant message. `source`
 *  separates built-in Daylens tools from the person's own MCP servers (spec:
 *  inspection identifies which MCP server a result came from). */
export interface ContextPacketToolConsulted {
  tool: string
  calls: number
  source: 'daylens' | 'mcp'
}

export interface ContextPacketInspection {
  packetId: string
  exchangeKind: 'chat' | 'day_analysis'
  purpose: 'answer' | 'interpret'
  threadId: number | null
  messageId: number | null
  question: string
  dates: string[]
  timezone: string
  /** When the packet was recorded — always before the request left the device. */
  createdAt: number
  policyVersion: number
  contentFingerprint: string
  destination: string
  leftDevice: boolean
  itemCount: number
  /** Tools the agent called for this answer, in first-use order — from the
   *  persisted turn trace. Empty array: a bound turn ran and used no tools.
   *  Null: no turn record is bound (e.g. the turn failed after recording). */
  toolsConsulted: ContextPacketToolConsulted[] | null
  groups: ContextPacketInspectionGroup[]
  conflicts: Array<{ identity: string; detail: string; resolvedBy: string }>
  gaps: Array<{ date: string; detail: string; kind: string }>
  permissions: Array<{ kind: string; scopeKind: string; path: string; state: string; allowHighSensitivity: boolean }>
  omissions: ContextPacketInspectionOmission[]
}

/** One row in the packet browser: enough to recognize the exchange and open
 *  the full inspection. */
export interface ContextPacketListEntry {
  packetId: string
  exchangeKind: 'chat' | 'day_analysis'
  threadId: number | null
  messageId: number | null
  question: string
  destination: string
  createdAt: number
  itemCount: number
  /** Item counts per kind, e.g. { day_fact: 12, file_excerpt: 1 }. */
  counts: Record<string, number>
}

export interface AIThreadMessageMetadata {
  /** Agent-turn evidence: which tools ran and what they returned. */
  agent?: {
    toolTrace: Array<{ tool: string; input: unknown; output: string; failed?: boolean }>
    stepCount: number
    groundingRetried: boolean
    fileDisclosures?: AIMessageFileDisclosure[]
    /** The recorded context packet this answer was built from (DEV-182);
     *  null when the packet ledger is unavailable. */
    contextPacketId?: string | null
    /** Verified packet citations in the answer, in display order. */
    citations?: AIMessageCitation[]
  }
  answerKind?: AIAnswerKind | null
  suggestedFollowUps?: FollowUpSuggestion[]
  retryable?: boolean
  retrySourceUserMessageId?: number | null
  contextSnapshot?: AIConversationState | null
  providerError?: boolean
  actions?: AIMessageAction[]
  actionWidgets?: AIActionWidget[]
  artifacts?: AIMessageArtifact[]
  rating?: AIMessageRating | null
  ratingUpdatedAt?: number | null
}

export interface AIThreadMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  answerKind?: AIAnswerKind | null
  suggestedFollowUps?: FollowUpSuggestion[]
  retryable?: boolean
  retrySourceUserMessageId?: number | null
  contextSnapshot?: AIConversationState | null
  providerError?: boolean
  actions?: AIMessageAction[]
  actionWidgets?: AIActionWidget[]
  artifacts?: AIMessageArtifact[]
  /** Agent-turn evidence, mirrored from metadata so every caller (UI, bench) reads one shape. */
  agent?: AIThreadMessageMetadata['agent']
  rating?: AIMessageRating | null
  ratingUpdatedAt?: number | null
}

export interface AIChatTurnResult {
  assistantMessage: AIThreadMessage
  conversationState: AIConversationState | null
  // The thread this turn was persisted into. sendMessage auto-creates a thread
  // when the renderer sends from a new-chat draft; returning the id lets the
  // renderer adopt THAT thread instead of guessing "the newest one" from a
  // list refresh — the guess is what created duplicate sidebar threads.
  threadId: number | null
  // R1 instrumentation: number of provider HTTP calls this turn made
  // (tool-loop roundtrips + retries + prose pass). Used to keep the per-turn
  // median low; absent for deterministic turns that made no provider call.
  providerCallCount?: number
}

export interface AIStarterSuggestion {
  label: string
  prompt: string
  source: 'model' | 'recent'
}

export interface AIStarterSuggestionResult {
  suggestions: AIStarterSuggestion[]
  error: string | null
}

// Post-answer transforms. The renderer signals the transform explicitly so
// the main process rewrites the SPECIFIC prior answer (with its grounded numbers)
// instead of mis-routing a disguised English prompt to the generic report bundle.
export type AIAnswerTransformKind = 'shorter' | 'checklist' | 'bullets' | 'report'

export interface AIChatSendRequest {
  message: string
  contextOverride?: AIConversationState | null
  clientRequestId?: string | null
  threadId?: number | null
  transform?: AIAnswerTransformKind | null
  /** Set when this send resumes a paused turn (DEV-200): the checkpoint is
   *  adopted by this turn (paused → running) and deleted when the turn
   *  completes. The answer is rebuilt from a fresh context packet — never a
   *  replay of stale in-flight state. */
  resumeOfCheckpointId?: string | null
}

export interface AIDailyReportPreparationResult {
  date: string
  threadId: number | null
  artifactId: number | null
  prepared: boolean
  status: 'ready' | 'no_activity' | 'failed'
  error?: string | null
}

// ─── Threads & artifacts (AI surface) ────────────────────────────────────────
export interface AIThreadSummary {
  id: number
  title: string
  createdAt: number
  updatedAt: number
  lastMessageAt: number
  archived: boolean
  messageCount: number
  lastSnippet?: string | null
}

// Opening a conversation loads only its most recent messages; older pages are
// fetched on demand with a (createdAt, id) cursor — never the whole history.
export interface AIThreadPageRequest {
  threadId: number
  limit?: number
  before?: { createdAt: number; id: number } | null
}

export interface AIThreadDetail {
  thread: AIThreadSummary | null
  // Ascending page of messages ending just before the cursor (or the newest
  // messages when no cursor was passed).
  messages: AIThreadMessage[]
  hasEarlier: boolean
}

// Per-thread overrides, stored in ai_threads.metadata_json (no migration).
// `provider` + `model` are set together (a model picked from the catalog) and
// take precedence over the global chat provider for this thread's turns, but
// only when that provider actually has a key. `instructions` are appended to
// the system prompt. Empty/absent fields fall back to the global settings.
export interface AIThreadSettings {
  provider?: AIProviderMode | null
  model?: string | null
  instructions?: string | null
}

export type AIArtifactKind =
  | 'markdown'
  | 'csv'
  | 'html_chart'
  | 'json_table'
  | 'focus_session'
  | 'report'

export interface AIArtifactRecord {
  id: number
  threadId: number | null
  messageId: number | null
  kind: AIArtifactKind
  title: string
  summary: string | null
  filePath: string | null
  hasInline: boolean
  mimeType: string
  byteSize: number
  meta: Record<string, unknown>
  createdAt: number
}

export interface AIArtifactContent {
  record: AIArtifactRecord
  content: string | null
  // Set by the preview path (GET_ARTIFACT) when content was capped to the first
  // N bytes. Open/export read the full artifact and never set this.
  truncated?: boolean
}

export interface AIMessageFeedbackUpdate {
  messageId: number
  rating: AIMessageRating | null
}

export interface WebsiteSummary {
  domain: string
  totalSeconds: number
  visitCount: number
  topTitle: string | null
  browserBundleId: string | null
  canonicalBrowserId?: string | null
}

export type LabelSource = 'rule' | 'artifact' | 'workflow' | 'memory' | 'ai' | 'user'

export interface OpenTarget {
  kind: 'external_url' | 'local_path' | 'unsupported'
  value: string | null
}

export interface ArtifactRef {
  id: string
  artifactType: 'domain' | 'page' | 'document' | 'project' | 'repo' | 'window'
  displayTitle: string
  subtitle?: string | null
  totalSeconds: number
  confidence: number
  canonicalAppId?: string | null
  ownerBundleId?: string | null
  ownerAppName?: string | null
  ownerAppInstanceId?: string | null
  url?: string | null
  path?: string | null
  host?: string | null
  canonicalKey?: string
  openTarget: OpenTarget
  metadata?: Record<string, unknown> | null
}

export type ResolvedIconSource =
  | 'active_window'
  | 'app_file'
  | 'app_identity'
  | 'app_bundle'
  | 'uwp_manifest'
  | 'artifact_file'
  | 'artifact_app'
  | 'browser_cache'
  | 'site_origin'
  | 'site_fallback'
  | 'miss'

export type IconRequest =
  | {
      kind: 'app'
      bundleId?: string | null
      appName?: string | null
      canonicalAppId?: string | null
      appInstanceId?: string | null
    }
  | {
      kind: 'site'
      domain?: string | null
      pageUrl?: string | null
    }
  | {
      kind: 'artifact'
      artifactType?: ArtifactRef['artifactType']
      canonicalAppId?: string | null
      ownerBundleId?: string | null
      ownerAppName?: string | null
      ownerAppInstanceId?: string | null
      path?: string | null
      url?: string | null
      host?: string | null
      title?: string | null
    }

export interface ResolvedIconPayload {
  cacheKey: string
  dataUrl: string | null
  source: ResolvedIconSource
}

export interface PageRef extends ArtifactRef {
  artifactType: 'page'
  domain: string
  visitCount?: number
  browserBundleId?: string | null
  canonicalBrowserId?: string | null
  normalizedUrl?: string | null
  pageKey?: string | null
  pageTitle?: string | null
}

export interface DocumentRef extends ArtifactRef {
  artifactType: 'document' | 'project' | 'repo' | 'window'
  sourceSessionIds: number[]
}

export interface WorkflowRef {
  id: string
  signatureKey: string
  label: string
  confidence: number
  dominantCategory: AppCategory
  canonicalApps: string[]
  artifactKeys: string[]
}

interface BlockLabel {
  current: string
  source: LabelSource
  confidence: number
  narrative: string | null
  ruleBased: string
  aiSuggested: string | null
  override: string | null
}

interface FocusOverlapSummary {
  totalSeconds: number
  pct: number
  sessionIds: number[]
}

export interface TimelineEvidenceSummary {
  apps: WorkContextAppSummary[]
  pages: PageRef[]
  documents: DocumentRef[]
  domains: string[]
  windowTitles?: Array<{
    title: string
    bundleId: string
    appName: string
    startTime: number
    endTime: number
    totalSeconds: number
  }>
  sites?: PageRef[]
  files?: Array<{
    filename: string
    path: string | null
    appName: string
    windowTitle: string
    firstSeenAt: number
    totalSeconds: number
    inferred: true
  }>
}

export interface PeakHoursResult {
  peakStart: number
  peakEnd: number
  focusPct: number
}

export interface WeeklySummary {
  totalTrackedSeconds: number
  totalFocusSeconds: number
  focusPct: number
  avgFocusScore: number
  bestDay: { date: string; focusPct: number } | null
  mostActiveDay: { date: string; totalSeconds: number } | null
  topApps: { appName: string; bundleId: string; totalSeconds: number; category: AppCategory }[]
  dailyBreakdown: {
    date: string
    focusSeconds: number
    totalSeconds: number
    focusScore: number
  }[]
}

export const DISTRACTION_DOMAINS = [
  'youtube.com', 'x.com', 'twitter.com', 'instagram.com',
  'reddit.com', 'tiktok.com', 'netflix.com', 'facebook.com',
]

export interface DistractionCostPayload {
  daysTracked: number
  totalDistractionSeconds: number
  annualExtrapolatedSeconds: number
  byMonth: { month: string; totalSeconds: number }[]
  byHour: { hour: number; totalSeconds: number }[]
  byDomain: { domain: string; totalSeconds: number }[]
  peakHour: number | null
  trendDirection: 'improving' | 'worsening' | 'flat'
  previousPeriodSeconds: number
}

export interface AppCharacter {
  character:
    | 'deep_focus'
    | 'flow_compatible'
    | 'context_switching'
    | 'distraction'
    | 'communication'
    | 'neutral'
  label: string
  confidence: number
  avgSessionMinutes: number
  sessionCount: number
}

export interface WorkflowPattern {
  id: string
  signatureKey: string
  label: string
  dominantCategory: AppCategory
  canonicalApps: string[]
  artifactKeys: string[]
  occurrenceCount: number
  lastSeenAt: number
}

export interface AppDetailPayload {
  canonicalAppId: string
  displayName: string
  totalSeconds: number
  sessionCount: number
  topArtifacts: ArtifactRef[]
  /**
   * Where a browser app's time went — present only for browser apps
   * (Chrome, Safari, Arc, Dia, …); omit for native apps so the renderer
   * hides the section. Replaces a separate topDomains/topPages pair that
   * were raw sums over browser history that kept accruing in the
   * background, so they could never add up to the app's own foreground
   * total. This tree reconciles by construction:
   * Σ page.totalSeconds = its domain's totalSeconds, Σ domain.totalSeconds
   * = attributedSeconds, and attributedSeconds + unattributedSeconds =
   * totalSeconds (the same number as the header). `unattributedSeconds`
   * is foreground browser time with no page recorded (native browser UI,
   * new tabs, uncaptured pages) — rendered as an explicit "No page
   * recorded" row, never smeared into a domain (invariant 10).
   */
  browserActivity?: {
    totalSeconds: number
    attributedSeconds: number
    unattributedSeconds: number
    domains: Array<{
      domain: string
      totalSeconds: number
      visitCount: number
      pages: PageRef[]
    }>
  }
  blockAppearances: Array<{
    blockId: string
    startTime: number
    endTime: number
    label: string
    dominantCategory: AppCategory
  }>
  /**
   * Memory-pattern rollup of the same blocks: when several
   * `blockAppearances` share a promoted memory pattern (e.g. Tonny renamed
   * three Ghostty blocks to "Daylens development" so all three matched the
   * same `context_patterns` row), the renderer can collapse them under the
   * pattern label instead of listing near-identical rows.
   *
   * `patternLabel` is the promoted pattern's `label_suggestion`. Rows with
   * no matching pattern keep `patternId: null` and one row per block.
   */
  blockMemoryRollups?: Array<{
    patternId: string | null
    patternLabel: string
    sessionCount: number
    totalSeconds: number
    earliestStart: number
    latestEnd: number
    sampleBlockIds: string[]
  }>
  timeOfDayDistribution: Array<{ hour: number; totalSeconds: number }>
  rangeKey: string
}

export interface BreakRecommendation {
  triggerReason: 'sustained_focus'
  focusedMinutes: number
  currentApp: string | null
  message: string
  urgency: 'medium' | 'high'
}

export type AIProvider = 'anthropic' | 'openai' | 'google' | 'openrouter'
export type AIProviderMode = AIProvider | 'claude-cli' | 'chatgpt-cli' | 'gemini-cli' | 'codex-cli'
export type AIJobType =
  | 'block_label_preview'
  | 'block_label_finalize'
  | 'block_cleanup_relabel'
  | 'day_summary'
  | 'week_review'
  | 'app_narrative'
  | 'chat_answer'
  | 'chat_thread_title'
  | 'chat_followup_suggestions'
  | 'report_generation'
  | 'attribution_assist'
  | 'wrapped_narrative'
  | 'wrapped_period_narrative'
  | 'wrapped_question'
  | 'search_intent'
  | 'memory_write'
  | 'weekly_brief'
  | 'interpretation_agent'

export interface AIWrappedNarrative {
  /** The hook: a one-line read on the shape of the day. Always present, and
   *  reused verbatim as the morning/evening notification one-liner. Equals the
   *  opening slide's line. */
  lead: string
  /** Per-slide prose, keyed by the slide ids in the deterministic slide plan
   *  (`planDayWrapSlides` / `planPeriodWrapSlides`). A missing or null line
   *  means the slide falls back to its deterministic fallbackLine. The AI only
   *  ever phrases the numbers already on the slide; it never invents one. */
  lines: Record<string, string | null>
  /** The one question the AI is genuinely curious about, for the interactive
   *  slide. Always ends with a question mark. null when the AI had nothing
   *  worth asking (the slide is skipped). */
  question: string | null
  /** The finale: a one-paragraph end-of-period reflection, written like a
   *  message the AI would send. Longer than a slide line, still grounded. */
  reflection: string | null
  /** Tracks whether this came from a validated AI response or the deterministic fallback. */
  source: 'ai' | 'fallback'
  factsHash: string
  /** When this wrap was generated (epoch ms). Set when the wrap is persisted, so
   *  the UI shows an honest "generated <when>" marker instead of "just now" on
   *  every open. Absent only for a transient, un-persisted result. */
  generatedAt?: number
}

// ─── Versioned day analysis (DEV-206) ────────────────────────────────────────
// Every AI analysis of a day (the day wrap, the period wraps that contain it,
// and the timeline regroup/relabel run) is recorded as an append-only version:
// what it said, when, from which facts (facts hash), by which model and prompt
// version, and why it replaced the previous one. Old versions stay inspectable;
// a correction retires the current version instead of silently diverging.

export type DayAnalysisKind = 'day' | 'week' | 'month' | 'year' | 'timeline'

export type DayAnalysisReason =
  | 'initial'
  | 'facts-changed'
  | 'correction'
  | 'deletion'
  | 'evidence-change'
  | 'manual-regenerate'
  | 'regenerated'

export interface DayAnalysisVersionSummary {
  kind: DayAnalysisKind
  /** The date for 'day'/'timeline'; the period's start date otherwise. */
  periodKey: string
  /** 1-based, per (kind, periodKey). */
  version: number
  factsHash: string
  /** The provider model that wrote it; null for deterministic output. */
  model: string | null
  promptVersion: number
  triggerSource: string
  source: 'ai' | 'fallback' | 'deterministic'
  /** Why this version exists (what replaced the previous one). */
  reason: DayAnalysisReason
  /** One representative line of what this version said (the wrap lead, or a
   *  short summary for a timeline analysis run). */
  lead: string | null
  createdAt: number
  /** Set when a later correction/deletion retired this version. */
  retiredAt: number | null
  retiredReason: 'correction' | 'deletion' | 'evidence-change' | 'superseded' | null
}

/** A question asked from inside a wrap slide, answered in context. */
export interface WrappedAskRequest {
  cadence: 'day' | 'week' | 'month' | 'year'
  /** The date (day) or anchor date (period) the wrap was built for. */
  periodKey: string
  /** The slide the user asked from, so the answer can be grounded in it. */
  slideId: string
  /** The line shown on that slide when the user asked. */
  slideLine: string | null
  /** The user's question, or their answer when replying to the AI's question. */
  question: string
  /** Set when this is a reply to the wrap's own curious question. */
  replyingTo?: string | null
}

export interface WrappedAskResult {
  answer: string | null
  /** Honest failure reason when answer is null ("no provider", timeout, ...). */
  error: string | null
}

// ─── Frozen daily snapshots (Briefs & Wraps, invariant 4) ──────────────────────
// A day's numbers, frozen once the day is finalized. Weekly/monthly/annual wraps
// SUM these frozen snapshots instead of re-summarizing — so the stat card and the
// narrative on a wrap can never disagree (the 20h7m-vs-20h53m bug). Every number
// here comes from the same trusted timeline blocks the Timeline view reads.

export interface DaySnapshotThread {
  /** What the user was doing, named for the work — never a raw app/page title. */
  subject: string
  role: WorkIntentRole
  seconds: number
}

export interface DaySnapshot {
  date: string
  /** Total active seconds across trusted blocks — the load-bearing day total. */
  totalActiveSeconds: number
  /** The one reconciled kind split. work+leisure+personal+idle. */
  kind: { work: number; leisure: number; personal: number; idle: number }
  /** Dominant WORK category — never leisure. null when no real work. */
  dominantWorkCategory: AppCategory | null
  /** Per-category active seconds (work-relevant categories), most time first. */
  categories: Array<{ category: AppCategory; seconds: number }>
  /** Top apps by active seconds, most first. */
  apps: Array<{ appName: string; seconds: number; category: AppCategory; isBrowser: boolean }>
  /** Top domains by active seconds, most first. */
  domains: Array<{ domain: string; seconds: number }>
  /** Friendly leisure surfaces ("YouTube", "Netflix"), most time first. */
  leisureSurfaces: string[]
  /** Named work threads (what mattered), most time first. */
  threads: DaySnapshotThread[]
  /** The single longest trusted work stretch of the day. */
  longestBlock: { label: string; seconds: number; startClock: string } | null
  /** Sum of meeting-block SPANS — meeting truth is the calendar span, not
   *  active seconds (a 73-minute call is 73 minutes even hands-off). Additive;
   *  absent on snapshots frozen with an older builder version that predates
   *  this field. */
  meetingsSpanSeconds?: number
  /** SNAPSHOT_BUILDER_VERSION at freeze time. A frozen row whose version is
   *  older than the current builder is stale by construction and gets rebuilt
   *  once on read — a hash comparison alone can't see a LOGIC change. */
  builderVersion?: number
  /** Hash of the source facts — lets us detect when a frozen day needs refreezing. */
  factsHash: string
  /** ms epoch when frozen; 0 means provisional (today, still live). */
  finalizedAt: number
}

// ─── External signals ──────────────────────────────────────────────────────
// Optional, per-day results from local connectors. Each connector is
// independent: unavailable or unpermissioned sources simply produce no row.
// Stored in external_signals keyed by date+source.

// notes connector: 'notes' is the meeting-notes source (Granola / Notion sync).
export type ExternalSignalSource = 'git' | 'calendar' | 'focus_app' | 'notes'

export interface GitRepoActivity {
  /** Repo folder name — never a path. */
  repo: string
  commitCount: number
  /** Commit subject lines, newest first, truncated. */
  messages: string[]
  firstCommitClock: string | null
  lastCommitClock: string | null
  /** How the commits spread across the day, by local part-of-day. Absent on
   *  rows stored before the field existed. */
  commitHourBuckets?: { overnight: number; morning: number; afternoon: number; evening: number }
  /** Of commitCount, how many landed under an agent-runner author identity
   *  (Claude, Cursor Agent, …) — the user's output via agents, never a
   *  teammate's (unknown human authors are excluded entirely). */
  agentCommitCount?: number
}

export interface GitPRActivity {
  title: string
  /** open | merged | closed | draft */
  state: string
  repo: string
}

export interface GitActivitySignal {
  repos: GitRepoActivity[]
  totalCommits: number
  /** PR activity from the gh CLI; empty when gh is unavailable. */
  prs: GitPRActivity[]
}

export interface CalendarEventSignal {
  title: string
  startClock: string
  durationMinutes: number
  /** Attendee COUNT only — never names. Null when the source doesn't say. */
  attendeeCount: number | null
}

export interface CalendarSignal {
  events: CalendarEventSignal[]
}

export interface FocusAppSignal {
  /** Focus tool detected on this machine ("Raycast Focus", "Session"). */
  app: string
  /** Parsed focus sessions for the day, when the tool's logs were readable. */
  sessions: Array<{ startClock: string | null; durationMinutes: number | null; label: string | null }>
}

export interface StoredExternalSignal<T = unknown> {
  date: string
  source: ExternalSignalSource
  payload: T
  capturedAt: number
}

// event-type inference: what a calendar event most likely WAS (a class, a 1:1,
// a presentation, ...), inferred deterministically from the title, attendee
// count, and duration already on CalendarEventSignal — never a network call or
// an AI guess. See src/main/services/eventTypeInference.ts for the classifier.
// The writer may use this only at high confidence; otherwise it stays
// literal, "the meeting".
export type EventType =
  | 'class'
  | 'one_on_one'
  | 'presentation'
  | 'interview'
  | 'workout'
  | 'team_meeting'
  | 'deep_work'
  | 'generic'

// notes connector: what actually happened IN one meeting, read from a
// meeting-notes source (Granola / a Notion sync). Metadata-level only — the
// user's recorded action items / decisions, NEVER the full verbatim transcript.
export interface MeetingNoteSignal {
  /** Meeting title. */
  title: string
  /** Participant FIRST NAMES only — never emails, never surnames. */
  participants: string[]
  /** The user's recorded action items / decisions. Short note lines, capped;
   *  never the transcript. */
  actionItems: string[]
  /** Scheduled start clock ("2pm") when the source recorded one. Optional. */
  scheduledClock?: string | null
}

// notes connector: the day's meeting notes from one meeting-notes source.
export interface MeetingNotesSignal {
  /** The source the notes came from ("Granola", "Notion"). */
  app: string
  notes: MeetingNoteSignal[]
}

// ─── Full-history export (privacy-retention-and-sync.md §Export, DEV-196) ────
// The renderer sees plans, progress, results, and verification reports — never
// a raw row. Everything here is metadata about the export, safe to display.

/** One withheld category, listed in the manifest so nothing is silently
 *  omitted. `tables` and/or `rows` are present when the omission is countable. */
export interface HistoryExportOmission {
  category: string
  reason: string
  tables?: string[]
  rows?: number
}

/** Per-table line of an export plan or manifest. */
export interface HistoryExportTableSummary {
  table: string
  /** Rows that will be (or were) written. */
  rows: number
  /** Rows withheld because the person deleted them (tombstones). */
  deletedWithheld: number
  /** Rows withheld pending the explicit high-sensitivity selection. */
  highSensitivityWithheld: number
}

/** One human-readable section of the export ("Captured activity", "Memory"…). */
export interface HistoryExportSectionSummary {
  id: string
  label: string
  rows: number
  tables: HistoryExportTableSummary[]
}

/** What an export WOULD contain — shown in Settings before running. */
export interface HistoryExportPlan {
  sections: HistoryExportSectionSummary[]
  omissions: HistoryExportOmission[]
  totalRows: number
  totalTables: number
  /** Rows currently withheld that flipping includeHighSensitivity would add. */
  highSensitivityRows: number
  /** ISO local-day bounds of captured evidence, null when nothing captured. */
  firstDay: string | null
  lastDay: string | null
}

export interface HistoryExportProgress {
  stage: 'tables' | 'summaries' | 'verify'
  /** Table currently streaming, null between stages. */
  table: string | null
  tableIndex: number
  tableCount: number
  rowsDone: number
  totalRows: number
}

export interface HistoryExportVerification {
  ok: boolean
  issues: string[]
  tablesChecked: number
  rowsChecked: number
}

export type HistoryExportRunResult =
  | {
      ok: true
      exportDir: string
      manifestPath: string
      totalRows: number
      totalTables: number
      totalBytes: number
      omissions: HistoryExportOmission[]
      verification: HistoryExportVerification
    }
  | {
      ok: false
      error: string
      /** Sections that were incomplete when the export failed (spec: export
       *  failure identifies incomplete sections). */
      incompleteSections: string[]
    }

/** The day's external signals, RESOLVED for the wrap writer: sanitized,
 *  humanized, pre-formatted, and stripped of anything the model must never
 *  echo (raw paths, branches, clock times it can't ground). Each block is
 *  null when its connector found nothing. This is what turns "4h in Cursor" into
 *  "wrote 9 commits to the billing service and opened a PR". */
export interface DayEnrichment {
  /** What the day PRODUCED, from git + gh. */
  shipped: {
    /** Commits per repo, humanized folder name, biggest first. `spread` is a
     *  pre-formatted part-of-day telling ("14 overnight, 21 through the
     *  morning") — null when the stored row predates commit-hour buckets. */
    commitsByProject: Array<{ project: string; commits: number; spread?: string | null; viaAgents?: number | null }>
    /** Sanitized, humanized commit subjects / PR titles worth naming — never a
     *  raw path or branch (already stripped). Deduped, capped. */
    highlights: string[]
    /** PRs grouped by project + state (open | merged | closed | draft). */
    pullRequests: Array<{ project: string; state: string; count: number }>
  } | null
  /** What MEETINGS shaped the day — the DEV-189 day-level resolution (issue
   *  #3): calendar signal and captured meeting-app evidence combined, with
   *  calendar-only / captured-only / matched reported as separate buckets so
   *  no calendar event becomes claimed work without supporting evidence and
   *  no observed meeting is denied for lacking a calendar entry. */
  meetings: {
    /** Total recognized meetings across all three buckets. */
    count: number
    /** Longest first (by scheduled length, observed length for captured-only).
     *  title null when the source gave none. Never an attendee name or count.
     *  `scheduled` / `observed` are pre-formatted lengths — scheduled is null
     *  for captured-only meetings, observed is null for calendar-only ones.
     *  // event-type inference: `type` + `confidence` from eventTypeInference.ts,
     *  so the writer may say "your ML class" instead of "the meeting" at high
     *  confidence, and must stay literal when it is not. */
    items: Array<{
      title: string | null
      scheduled: string | null
      observed: string | null
      attendance: 'matched' | 'calendar_only' | 'captured_only'
      type: EventType
      confidence: number
    }>
    matched: number
    calendarOnly: number
    capturedOnly: number
  } | null
  /** Focus-timer runs, when the user enabled a focus app. Barest by design. */
  focusSessions: {
    tool: string
    sessions: number
    /** Pre-formatted total focused time. */
    focused: string
  } | null
  /** notes connector: what actually happened IN meetings, from a meeting-notes
   *  source (Granola / Notion) — title, first-name participants, and the user's
   *  recorded action items / decisions. Sanitized; metadata-level, never a
   *  transcript. Null when no notes source had anything. */
  meetingNotes: {
    app: string
    items: Array<{ title: string; participants: string[]; actionItems: string[] }>
  } | null
}

/** Discovered optional enrichment sources shown in Settings: MCP servers from
 *  the Claude Desktop config and focus tools on this machine. Discovery
 *  only — nothing is called until the user enables it AND the enrichment is
 *  actually wired up. */
export interface EnrichmentSourcesState {
  mcpServers: Array<{ name: string; transport: 'stdio' | 'http' | 'unknown'; enabled: boolean }>
  focusApps: Array<{ app: string; installed: boolean; enabled: boolean }>
}

// ─── Wrap pre-flight ────────────────────────────────────────────────────────
// Honest, specific warnings BEFORE a wrap generates. None of them block:
// the user can always generate anyway with one tap.

export type WrapPreflightWarningKind = 'lowWork' | 'notAnalyzed' | 'missingTitles' | 'staleCapture' | 'partialCapture'

export interface WrapPreflightWarning {
  kind: WrapPreflightWarningKind
  /** Honest, specific copy naming the real numbers — never a generic error. */
  message: string
}

/** Which connector sources actually had data for a day — the same presence the
 *  wrap writer's enrichment resolution sees, so the coverage card and the prose
 *  can never disagree about what was available. */
export interface WrapDaySources {
  calendar: boolean
  git: boolean
  focus: boolean
  notes: boolean
}

export interface WrapPreflightResult {
  date: string
  warnings: WrapPreflightWarning[]
  /** True when a generated wrap is already stored for this date — opening it
   *  shows the stored wrap, so no pre-flight warning is needed. */
  hasStoredWrap: boolean
  workSeconds: number
  /** Percent of the day's app sessions missing a window title (0-100). */
  missingTitlePct: number | null
  analyzed: boolean
  /** Minutes since the last captured session ended; null when nothing tracked. */
  lastActivityAgoMinutes: number | null
  /** The clock of the FIRST activity Daylens captured this day, e.g. "12:08pm".
   *  Null when nothing was tracked. The wrap uses this to be honest about when
   *  its view of the day actually began. */
  firstCaptureClock: string | null
  /** Connector sources that had real data for this day (drives the wrap's
   *  coverage card: what the recap is built on, and what it isn't). */
  sources: WrapDaySources
}

export type WrappedPeriod = 'week' | 'month' | 'year'

export interface WrappedPeriodThread {
  subject: string
  seconds: number
  /** How many days in the period this thread showed up — "across four days". */
  daysActive: number
}

export interface WrappedPeriodFacts {
  period: WrappedPeriod
  /** Any date inside the period; the period is derived from it. */
  anchorDate: string
  /** Human label for the range, e.g. "Jun 16 – Jun 22" or "June 2026". */
  rangeLabel: string
  /** SUM of the frozen day totals — this is THE stat-card number. */
  totalSeconds: number
  workSeconds: number
  leisureSeconds: number
  personalSeconds: number
  previousPeriodSeconds: number
  daysWithActivity: number
  /** Main mode = the dominant WORK category, never leisure. */
  dominantWorkCategory: AppCategory | 'unknown'
  dominantWorkCategoryPct: number
  /** Where the work time went, most time first — for the "story", with a legend. */
  categories: Array<{ category: AppCategory; seconds: number }>
  topApps: Array<{ appName: string; seconds: number }>
  /** The biggest named threads — what mattered. */
  threads: WrappedPeriodThread[]
  leisureSurfaces: string[]
  busiestDay: { dateStr: string; dayLabel: string; totalSeconds: number } | null
  quietestActiveDay: { dateStr: string; dayLabel: string; totalSeconds: number } | null
  /** Longest single work stretch in the period — a real superlative.
   *  startClock ("9:12am") is carried from the frozen snapshot when known. */
  longestStretch: { dateStr: string; dayLabel: string; seconds: number; label: string; startClock?: string | null } | null
  /** Sub-rollup: week → 7 days; month → weeks; year → months. */
  buckets: Array<{ label: string; totalSeconds: number; dominantWorkCategory: AppCategory | 'unknown' }>
  busiestBucket: { label: string; totalSeconds: number } | null
  /** Per-day kind splits from the frozen snapshots, chronological. Powers the
   *  best/worst-day and work-vs-leisure slides without re-summing anything. */
  days: Array<{ dateStr: string; dayLabel: string; totalSeconds: number; workSeconds: number; leisureSeconds: number }>
  /** Meetings-category seconds summed across the period. 0 = no slide. */
  meetingsSeconds: number
  /** The real first/last activity clock per active day, read from the same
   *  trusted timeline blocks the Timeline shows. Empty when unknown — the
   *  late-night / early-start slides are skipped rather than guessed. */
  dayEdges: Array<{ dateStr: string; dayLabel: string; firstClock: string; lastClock: string; firstHour: number; lastHour: number }>
}

export interface WrappedPeriodNarrative {
  period: WrappedPeriod
  /** The period in one line — the headline story. Always present. Equals the
   *  opening slide's line. */
  lead: string
  /** Per-slide prose keyed by the ids in `planPeriodWrapSlides`. Missing/null
   *  lines fall back to the slide's deterministic fallbackLine. */
  lines: Record<string, string | null>
  /** The AI's one curious question for the interactive slide. */
  question: string | null
  /** The finale paragraph: the end-of-period message the AI would send. */
  reflection: string | null
  source: 'ai' | 'fallback'
  factsHash: string
  /** Epoch ms when this wrap was generated and persisted. */
  generatedAt?: number
}

/** The no-credits rule: with no provider connected, no brief
 *  or wrap is generated — the surface shows one message pointing to Settings and
 *  nothing else. The renderer reads this before rendering any wrap. */
export interface WrapProviderState {
  /** A provider/model is configured for the wrapped job. */
  connected: boolean
  /** The provider name to show in the "connect" / error message. */
  provider: string | null
}

export type AISurface =
  | 'timeline_day'
  | 'timeline_week'
  | 'apps_list'
  | 'app_detail'
  | 'ai_chat'
  | 'settings'
  | 'background'

export type AIInvocationSource = 'user' | 'background' | 'system'
export type AIModelStrategy = 'balanced' | 'quality' | 'economy' | 'custom'

export interface ProcessSnapshot {
  pid: number
  name: string
  cpuPercent: number
  memoryMb: number
  capturedAt: number
}

export type AppTheme = 'system' | 'light' | 'dark'

export type OnboardingPlatform = 'macos' | 'windows' | 'linux'

export type NotificationPermissionState = 'granted' | 'denied' | 'not-determined' | 'unsupported'

export type TrackingPermissionState =
  | 'granted'
  | 'missing'
  | 'awaiting_relaunch'
  | 'unsupported_or_unknown'

export type CapturePermissionStatus = 'granted' | 'missing' | 'unsupported_or_unknown'

// Safari (WebKit) history reads ~/Library/Safari/History.db, which is TCC-protected
// and requires Full Disk Access. macOS gives no programmatic way to check FDA ahead
// of time, so this is inferred from whether the copy of that file actually succeeds:
// 'unknown' until the first WebKit poll attempt, 'ok' once a copy has succeeded,
// 'denied' if a copy fails with EPERM/EACCES (cleared back to 'ok' the next time a
// poll succeeds — no restart required).
export type SafariHistoryAccessStatus = 'ok' | 'denied' | 'unknown'

export interface TrackingPermissionDetails {
  accessibility: CapturePermissionStatus
  screenRecording: CapturePermissionStatus
  combined: TrackingPermissionState
  platformNote?: string | null
  captureHelperRunning?: boolean | null
}

export type OnboardingStage =
  | 'welcome'
  | 'why'
  | 'permission'
  | 'relaunch_required'
  | 'verifying_permission'
  | 'proof'
  | 'tour'
  | 'superpowers'
  | 'about'
  | 'voice'
  | 'work'
  | 'connections'
  | 'privacy'
  | 'personalize'   // legacy: split into about/work/connections/privacy; kept so stale state migrates cleanly
  | 'ai_setup'
  | 'ready'
  | 'complete'

/** How the user's working day is shaped — tunes brief timing and day boundaries.
 *  Captured in onboarding ("when do you work?"). */
export type WorkRhythm = 'early' | 'standard' | 'night' | 'always'

/** How Daylens's written summaries should sound. Chosen in onboarding, applied
 *  to every recap / wrap / brief prompt (`src/shared/summaryVoice.ts`). */
export type SummaryVoice = 'straight' | 'warm' | 'witty'

export type ProofState = 'idle' | 'collecting' | 'ready'
type PersonalizationState = 'pending' | 'completed'
type AISetupState = 'pending' | 'dismissed' | 'connected'

export interface OnboardingState {
  flowVersion: number
  platform: OnboardingPlatform
  stage: OnboardingStage
  trackingPermissionState: TrackingPermissionState
  permissionRequestedAt: number | null
  proofState: ProofState
  personalizationState: PersonalizationState
  aiSetupState: AISetupState
  completedAt: number | null
}

type ProviderConnectionStatus =
  | 'valid'
  | 'invalid_credentials'
  | 'unsupported_format'
  | 'provider_unreachable'

export interface ProviderConnectionResult {
  status: ProviderConnectionStatus
  provider: AIProvider
  detectedProvider: AIProvider | null
  message: string
  canSaveAnyway: boolean
}

export interface WorkspaceResult {
  workspaceId: string
  mnemonic: string
  linkCode: string
  linkToken: string
}

export interface BrowserLinkResult {
  displayCode: string
  fullToken: string
}

export interface SyncStatus {
  isLinked: boolean
  workspaceId: string | null
  lastHeartbeatAt: number | null
  lastSuccessfulSyncAt: number | null
  state: 'local_only' | 'linked' | 'pending_first_sync' | 'healthy' | 'stale' | 'failed'
  lastFailureAt?: number | null
  lastFailureMessage?: string | null
}

export interface AppSettings {
  /** MCP servers the chat agent may connect to. Same shape as Claude Desktop
   *  entries; edited in settings JSON for now. */
  mcpServers?: Array<{ name: string; command: string; args?: string[]; env?: Record<string, string> }>
  // Provider API keys are stored in OS keychain via keytar (never in plain-text)
  // Anonymous analytics is always on; the only kill switch is building
  // without a PostHog key.
  shareAIFeedbackExamples: boolean // legacy setting; cloud feedback upload is disabled in local-only builds
  launchOnLogin: boolean
  theme: AppTheme
  onboardingComplete: boolean
  onboardingState: OnboardingState
  /** Explicit capture consent — the state that gates every capture adapter.
   *  See src/shared/captureConsent.ts. */
  captureConsent: import('./captureConsent').CaptureConsentState
  userName: string
  userGoals: string[]
  userIntent: string            // why the user is here, captured in onboarding; fed to AI suggestions
  summaryVoice?: SummaryVoice   // how recaps/wraps/briefs should sound; default 'warm'
  focusApps?: string[]          // apps the user counts as "real work" (bundle ids and/or names)
  interestedCategories?: AppCategory[] // categories the user said they care about; fed to AI context
  userRole?: string             // what the user does (e.g. "Designer"); seeds suggestions + AI context
  userClients?: string[]        // clients/projects the user works with; helps AI recognise & attribute work
  workRhythm?: WorkRhythm       // shape of the working day; tunes brief timing / day boundaries
  firstLaunchDate: number       // Unix ms — set on first launch, used for day-7 feedback prompt
  feedbackPromptShown: boolean  // true once the day-7 prompt has been shown
  aiProvider: AIProviderMode
  anthropicModel: string
  openaiModel: string
  googleModel: string
  openrouterModel: string
  aiFallbackOrder: AIProvider[]
  aiModelStrategy: AIModelStrategy
  // The only per-surface provider override left: an explicit, user-chosen
  // provider for the AI chat tab. Every other surface follows `aiProvider`
  // (invariant #12). When unset, chat follows `aiProvider` too.
  aiChatProvider?: AIProviderMode
  aiBackgroundEnrichment?: boolean
  aiActiveBlockPreview?: boolean
  aiPromptCachingEnabled?: boolean
  aiSpendSoftLimitUsd?: number
  /** DEV-228 kill switch: false stops every machine-initiated AI call
   *  (background and system triggers of background job types) immediately.
   *  User-initiated calls always run. Default true. */
  backgroundAiEnabled?: boolean
  /** DEV-228: each feature's daily spend budget in USD. Applies to every
   *  feature unless overridden per feature below. Default $0.50. */
  aiFeatureDailyBudgetUsd?: number
  /** Per-feature budget overrides, keyed by the user-facing feature name
   *  from shared/aiFeatures.ts (the same names the Usage screen shows). */
  aiFeatureBudgetOverridesUsd?: Record<string, number>
  aiRedactFilePaths?: boolean
  aiRedactEmails?: boolean
  allowThirdPartyWebsiteIconFallback?: boolean // false = keep website icons local/browser-cache only
  aiReportPersonalizationEnabled?: boolean
  dailySummaryEnabled?: boolean
  morningNudgeEnabled?: boolean
  /** The weekly brief: fires at the week boundary and opens the week's wrap.
   *  Independently disableable like the other briefs (briefs.md). */
  weeklyBriefEnabled?: boolean
  /** Activity-free notification text (briefs.md §Notification content and
   *  privacy): when true, brief notifications say only that the brief is ready
   *  ("Your evening wrap is ready") — no activity content on the lock screen —
   *  without losing the brief itself. */
  activityFreeNotificationText?: boolean
  /** The interpretation-agent live switch (agent-runtime-and-context.md,
   *  DEV-206): OFF by default. Turning it on routes automatic day analysis
   *  through the packet-based interpretation agent instead of the direct
   *  regroup/relabel pipeline — allowed only once the offline fixture eval
   *  (interpretationEval) passes for the packaged runtime. Until that runtime
   *  lands, the flag is honored but the direct pipeline still runs (logged). */
  interpretationAgentEnabled?: boolean
  distractionAlertThresholdMinutes?: number
  distractionAlertsEnabled?: boolean
  notificationPermissionState?: NotificationPermissionState
  mcpServerEnabled?: boolean
  workMemoryConsolidationEnabled?: boolean   // Evening consolidation: archive the day, score and promote patterns, decay stale ones.
  useRemoteAI?: boolean   // legacy setting; remote workspace AI is disabled in local-only builds.
  // Tracking Controls (opt-in, OFF by default). When disabled and not
  // paused, capture is unchanged. See src/shared/trackingControls.ts.
  trackingControlsEnabled?: boolean
  trackingExcludedApps?: string[]   // bundle ids and/or app names
  trackingExcludedSites?: string[]  // hosts/domains
  // trackingSkipIncognito was removed: private/incognito exclusion is
  // unconditional (see trackingControls.ts) and was never a real setting. A
  // persisted value in old configs is simply ignored.
  trackingPaused?: boolean          // ad-hoc pause; blocks capture regardless of the master switch
  billingInstallationId?: string    // random local install identity; raw activity never leaves with it
  // Appearance (Settings → General). Colors are per-category overrides of the
  // shared activityColors palette — set via the grouped picker, validated to
  // #rrggbb + known categories on write (see shared/activityColors.ts).
  activityColorOverrides?: Partial<Record<AppCategory, string>>
  dimLeisureBlocks?: boolean        // fade non-work blocks on the calendar; default true
  // Optional enrichment sources: user enable/disable flags for discovered
  // MCP servers ("mcp:notion") and focus apps ("focus:Session"). Discovery
  // is free; nothing is called until enabled AND the enrichment is wired up.
  enrichmentSources?: Record<string, boolean>
  // Screen-context experiment (DEV-197). Consent is separate from capture,
  // sync, browser, and connector consent, and is offered ONLY from the
  // experiment setup — enabling normal tracking never sets it. Absent means
  // not consented; revoking clears it and deletes unprocessed frames.
  screenContextExperimentEnabled?: boolean
  // Ad-hoc pause for screen sampling only; core tracking is untouched.
  screenContextPaused?: boolean
  // Unix ms of the explicit consent decision (DEV-198) — shown in the
  // experiment status so the person can see exactly when they agreed.
  // Cleared on revoke.
  screenContextConsentAt?: number
  // Tier-2 agent capability (docs/north-star/context-agent.md): may the chat
  // agent read Granola meeting notes from the local cache? On by default —
  // turning it off makes read_meeting_notes refuse honestly.
  granolaAccessEnabled?: boolean
  // Consent-gated agent capability: may the chat agent run allowlisted
  // read-only terminal commands (run_command)? OFF by default; first use in a
  // session additionally raises the in-chat permission card.
  terminalAccessEnabled?: boolean
}

// ─── Screen-context experiment surface (DEV-198) ─────────────────────────────
// The renderer-facing status and backlog shapes. Deliberately content-free
// beyond what the person may inspect about their own frames: app identity,
// timing, byte size, lifecycle state, and a bounded structural error — never
// OCR text, titles, or derived evidence content.

export interface ScreenContextBacklogFrame {
  id: string
  capturedAt: number
  trigger: string
  appName: string | null
  appBundleId: string | null
  state: string
  byteSize: number
  retryCount: number
  lastError: string | null
  nextRetryAt: number | null
}

export interface ScreenContextExclusionOffer {
  /** The excluded app as the person excluded it (name or bundle id). */
  source: string
  frameCount: number
  evidenceCount: number
}

export interface ScreenContextStatus {
  /** The experiment exists on macOS and Windows only. */
  supportedPlatform: boolean
  /** Consent can be offered: supported platform AND core tracking already
   *  consented and working (the experiment never leads onboarding). */
  eligible: boolean
  /** Honest reason when not eligible; null when eligible. */
  eligibilityReason: string | null
  enabled: boolean
  paused: boolean
  consentAt: number | null
  /** Whether an OS capture sampler is wired in this build (macOS via
   *  ScreenCaptureKit / Windows via Windows.Graphics.Capture, both through
   *  the Electron capturer). False → sampling can never be active. */
  samplerInstalled: boolean
  /** True only while the sampler loop is running WITH consent and not paused
   *  — the exact signal the persistent indicator shows. */
  samplerActive: boolean
  /** Which adapter is wired ('macos-screencapturekit', 'windows-graphics-capture',
   *  'fake' in tests), or null when none is. */
  samplerKind: string | null
  backlog: { frames: number; bytes: number }
  backlogCapReached: boolean
  quarantinedCount: number
  /** Derived screen evidence rows currently stored (local-only). */
  evidenceCount: number
  lastCapturedAt: number | null
  /** Excluded apps that still have screen-context records — each one is an
   *  explicit offer to delete the prior evidence for that source. */
  exclusionOffers: ScreenContextExclusionOffer[]
}

export type BillingAccessMode = 'free_credit' | 'subscription' | 'local_pass' | 'own_key' | 'none' | 'unavailable'
export type BillingUsageType = 'free_credit' | 'subscription' | 'local_pass' | 'own_key'

export interface PaymentRecord {
  provider: string
  txRef: string
  amount: number
  currency: string
  status: string
  providerReference: string | null
  createdAt: number
  updatedAt: number
}

// ─── Entitlement snapshot (billing-and-entitlements spec) ───────────────────
// The signed contract the billing service returns from GET /v1/entitlement.
// This is the consolidation target that replaces BillingAccessSnapshot for
// access decisions; the desktop validates the Ed25519 signature against a
// build-pinned public key and never infers paid access from a UI flag alone.

export type EntitlementState = 'trial' | 'active' | 'grace' | 'exhausted' | 'expired' | 'refunded'

export interface EntitlementSnapshot {
  accountId: string
  state: EntitlementState
  periodStart: number | null
  periodEnd: number | null
  managedCreditGrantedUsd: number
  managedCreditReservedUsd: number
  managedCreditConsumedUsd: number
  canUseManagedAI: boolean
  canUseCloud: boolean
  issuedAt: number
  expiresAt: number
  kid: string
  signature: string
}

export interface BillingAccessSnapshot {
  mode: BillingAccessMode
  canUseAI: boolean
  managed: boolean
  creditGrantedUsd: number
  creditRemainingUsd: number
  periodSpendUsd: number
  paidSpendUsd: number
  renewalAt: number | null
  localPassExpiresAt: number | null
  fairUseRemainingUsd: number | null
  subscriptionStatus: string | null
  providerLabel: string | null
  checkoutAvailable: boolean
  localCheckoutAvailable: boolean
  portalAvailable: boolean
  message: string
  // Whole questions the remaining allowance can still answer, computed on the
  // desktop from the remaining credit and per-model pricing. Allowance is
  // displayed in money and estimated questions — never raw tokens first. Null
  // when there is no remaining managed allowance to estimate (own key,
  // unavailable, or paused access).
  estimatedQuestionsRemaining?: number | null
}

export type BillingUsageCostSource = 'provider' | 'estimated' | 'unknown'

export interface BillingUsageRow {
  id: string
  occurredAt: number
  type: BillingUsageType
  feature: string
  screen?: string | null
  triggerSource?: string | null
  provider: string | null
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
  tokens: number | null
  costUsd: number | null
  costSource?: BillingUsageCostSource
  success: boolean
  // Aggregate export lines (pre-retention-window days rolled up per day; see
  // aiUsageRetention.ts) carry the group's call/failure counts here. Ordinary
  // per-event rows omit them (calls = 1, failures = success ? 0 : 1).
  calls?: number
  failures?: number
}

export interface BillingUsagePoint {
  day: string
  model: string
  feature?: string
  spendUsd: number
  tokens: number
}

export type BillingUsageSource = 'local_meter' | 'daylens_managed'

export interface BillingUsageJobSummary {
  feature: string
  screen: string | null
  triggerSource: string | null
  provider: string | null
  model: string | null
  calls: number
  successes: number
  failures: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  tokens: number
  costUsd: number | null
}

/** DEV-228: what the Usage screen's Background AI card shows — the kill
 *  switch state plus each feature's daily budget and spend so far today. */
export interface SpendGuardrailsReport {
  backgroundAiEnabled: boolean
  defaultDailyBudgetUsd: number
  features: Array<{
    feature: string
    budgetUsd: number
    spentTodayUsd: number
    exhausted: boolean
  }>
}

export interface BillingUsageHourlyPoint {
  hour: number
  label: string
  feature: string
  model: string | null
  calls: number
  tokens: number
  costUsd: number | null
}

export interface BillingUsageReport {
  from: number
  to: number
  source?: BillingUsageSource
  sourceLabel?: string
  totalSpendUsd: number
  totalTokens: number
  totalCalls?: number
  failedCalls?: number
  backgroundCalls?: number
  backgroundTokens?: number
  freeCreditUsedUsd: number
  paidSpendUsd: number
  points: BillingUsagePoint[]
  featurePoints?: BillingUsagePoint[]
  rows: BillingUsageRow[]
  jobSummaries?: BillingUsageJobSummary[]
  hourlyPoints?: BillingUsageHourlyPoint[]
}

// In-flight session that has not yet been flushed to the DB.
// Exposed via IPC so the renderer can merge it into Today's display totals.
export interface LiveSession {
  bundleId: string
  appName: string
  startTime: number   // Unix ms
  category: AppCategory
  windowTitle?: string | null
  rawAppName?: string | null
  canonicalAppId?: string | null
  appInstanceId?: string | null
  captureSource?: string | null
}

export type TrackingModuleSource = 'package' | 'unpacked' | 'hyprctl' | 'swaymsg' | 'xdotool' | 'xprop'
type LinuxTrackingSupportLevel = 'ready' | 'limited' | 'unsupported'

interface LinuxTrackingHelperCommands {
  hyprctl: boolean
  swaymsg: boolean
  xdotool: boolean
  xprop: boolean
}

export interface LinuxTrackingDiagnostics {
  supportLevel: LinuxTrackingSupportLevel
  supportMessage: string
  sessionType: string
  desktop: string
  helperCommands: LinuxTrackingHelperCommands
  display: string | null
  waylandDisplay: string | null
}

interface TrackingRawWindowDiagnostics {
  title: string
  application: string
  path: string
  pid: number
  isUWPApp: boolean
  uwpPackage: string
}

interface TrackingResolvedWindowDiagnostics {
  backend: string
  bundleId: string
  appName: string
  title: string
  pid: number
  path: string
}

interface TrackingStatusDiagnostics {
  moduleSource: TrackingModuleSource | null
  loadError: string | null
  pollError: string | null
  backendTrace: string[]
  lastRawWindow: TrackingRawWindowDiagnostics | null
  lastResolvedWindow: TrackingResolvedWindowDiagnostics | null
}

type LinuxPackageType = 'appimage' | 'deb' | 'rpm' | 'pacman' | 'unknown' | null

interface LinuxDesktopDiagnostics {
  sessionType: string | null
  display: string | null
  waylandDisplay: string | null
  desktop: string | null
  packageType: LinuxPackageType
  packageDetectionSource: 'appimage-env' | 'dpkg-query' | 'rpm-query' | 'pacman-query' | 'unresolved' | null
  packageOwner: string | null
  packageManagerCommand: 'dpkg-query' | 'rpm' | 'pacman' | null
  packageMatchedPath: string | null
  packageDetectionErrors: string[]
  appImage: string | null
  autostartPath: string
  autostartEnabled: boolean
  notificationSupported: boolean
  secureStoreAvailable: boolean
  secureStoreError: string | null
  secureStoreHint: string | null
  dbusSessionBusAddress: string | null
  dbusSessionBusAddressInferred: boolean
  secretServiceReachable: boolean | null
}

/** DEV-229: the permission watcher's live verdict on whether capture can
 *  actually read window titles — the OS grant flag AND a real-read proxy
 *  (titled share of recently persisted samples). 'blind' = flag revoked or
 *  grant silently dead; 'degraded' = under half of samples titled;
 *  'waiting' = too few samples to judge. */
export interface CaptureVerificationState {
  status: 'healthy' | 'degraded' | 'blind' | 'waiting'
  axTrusted: boolean
  recentSamples: number
  recentSamplesWithTitle: number
  checkedAt: number
}

export interface TrackingDiagnosticsPayload {
  platform: NodeJS.Platform
  trackingStatus: TrackingStatusDiagnostics
  captureHealth: {
    permissions: TrackingPermissionDetails
    windowTitles: {
      // 'degraded' = titles are arriving but on under half of samples —
      // capture works, badly (DEV-229's "most samples carry titles" bar).
      status: 'healthy' | 'degraded' | 'waiting' | 'missing'
      recentSamples: number
      recentSamplesWithTitle: number
      lastCapturedAt: number | null
    }
    browsers?: {
      discoveredCount: number
      names: string[]
      safariHistoryAccess: SafariHistoryAccessStatus
    }
    captureHelperRunning?: boolean | null
    // Per-display visibility stream health (macOS). Counts only — no app
    // names, titles, or identities. 'visible' = a display currently shows a
    // full-screen app; 'none' = the stream reports but nothing is full-screen;
    // 'unavailable' = no samples (helper too old, not running, or not macOS).
    displays?: {
      status: 'visible' | 'none' | 'unavailable'
      recentSamples: number
      distinctDisplays: number
      lastSampleAt: number | null
    }
    // Events dropped before persistence (malformed payloads, unsupported
    // schema versions), keyed by adapter. Counts only — never event content.
    rejectedEvents?: Record<string, { total: number; byReason: Record<string, number> }>
  }
  linuxTracking: LinuxTrackingDiagnostics | null
  linuxDesktop: LinuxDesktopDiagnostics | null
}

export type AppCategory =
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

// The full set of valid categories, for validating untrusted input (e.g. an
// IPC payload) before it's persisted or cast to AppCategory.
const APP_CATEGORIES: readonly AppCategory[] = [
  'development', 'communication', 'research', 'writing', 'aiTools', 'design',
  'browsing', 'meetings', 'entertainment', 'email', 'productivity', 'social',
  'system', 'uncategorized',
]

export function isAppCategory(value: unknown): value is AppCategory {
  return typeof value === 'string' && (APP_CATEGORIES as readonly string[]).includes(value)
}

export const FOCUSED_CATEGORIES: AppCategory[] = [
  'development',
  'research',
  'writing',
  'aiTools',
  'design',
  'productivity',
]

// ─── Attribution / Work Session types for renderer ───────────────────────────

type AttributionStatus = 'attributed' | 'ambiguous' | 'unattributed'

interface ClientSummary {
  id: string
  name: string
  color: string | null
  status: string
  projectCount: number
}

export interface ClientRecord {
  id: string
  name: string
  color: string | null
  status: 'active' | 'archived'
  created_at: number
  updated_at: number
  projectCount: number
}

export interface ProjectSummary {
  id: string
  client_id: string
  name: string
  color: string | null
}

/** Active project row for attribution pickers (client + project). */
export interface AttributionProject {
  id: string
  client_id: string
  name: string
  client_name: string
}

export interface WorkSessionApp {
  app_name: string
  duration_ms: number
  role: string // primary | supporting | ambient
}

interface WorkSessionEvidence {
  type: string   // domain | file_path | title | repo_remote | email_domain | sequence
  value: string
  weight: number
}

export interface WorkSessionPayload {
  id: string
  started_at: number
  ended_at: number
  duration_ms: number
  active_ms: number
  idle_ms: number
  client_id: string | null
  client_name: string | null
  client_color: string | null
  project_id: string | null
  project_name: string | null
  attribution_status: AttributionStatus
  attribution_confidence: number | null
  title: string | null
  apps: WorkSessionApp[]
  evidence: WorkSessionEvidence[]
}

export interface ActivitySegmentPayload {
  id: string
  started_at: number
  ended_at: number
  duration_ms: number
  primary_app_name: string
  class: string // focused | supporting | ambient | idle
}

export interface RollupEntry {
  day_local: string
  client_id: string | null
  project_id: string | null
  attributed_ms: number
  ambiguous_ms: number
  session_count: number
}

export interface ClientDetailPayload {
  client: ClientSummary
  projects: ProjectSummary[]
  rollups: RollupEntry[]
  sessions: WorkSessionPayload[]
  ambiguous_sessions: WorkSessionPayload[]
}

export interface TimelineWorkSession extends WorkSessionPayload {
  is_live?: boolean
}

export interface DayWorkSessionsPayload {
  date: string
  sessions: TimelineWorkSession[]
  total_attributed_ms: number
  total_ambiguous_ms: number
  total_unattributed_ms: number
}

// Identity payload the renderer passes to the Intercom Messenger on boot. Only
// public values cross this bridge — the Identity Verification secret stays in
// services/billing, which computes userHash server-side (null until that secret
// is configured and the billing service is reachable).
export interface IntercomIdentity {
  userId: string
  // The desktop app has no connected-account email today; kept in the contract
  // so the Messenger picks it up the day one exists.
  email: string | null
  userHash: string | null
  platform: string
  version: string
  subscriptionStatus: string
  daysSinceInstall: number
  totalTrackedDays: number
}

// IPC channel names — single source of truth
export const IPC = {
  DB: {
    GET_TODAY: 'db:get-today',
    GET_HISTORY: 'db:get-history',
    GET_HISTORY_DAY: 'db:get-history-day',
    GET_TIMELINE_DAY: 'db:get-timeline-day',
    REBUILD_TIMELINE_DAY: 'db:rebuild-timeline-day',
    // Progress ticks streamed while REBUILD_TIMELINE_DAY runs (DEV-270), so the
    // Analyze button shows what the system is actually doing, not a blank spinner.
    ANALYZE_PROGRESS: 'db:analyze-progress',
    // The material answer-or-skip questions the day-analysis agent has for a day,
    // and the channel to answer or dismiss them (DEV-247/270 clarification).
    GET_DAY_CLARIFICATIONS: 'db:get-day-clarifications',
    RESOLVE_DAY_CLARIFICATION: 'db:resolve-day-clarification',
    GET_APP_SUMMARIES: 'db:get-app-summaries',
    GET_APP_SUMMARIES_FOR_DATE: 'db:get-app-summaries-for-date',
    GET_ALL_APPS_FOR_LABELING: 'db:get-all-apps-for-labeling',
    GET_CATEGORY_OVERRIDES: 'db:get-category-overrides',
    SET_CATEGORY_OVERRIDE: 'db:set-category-override',
    CLEAR_CATEGORY_OVERRIDE: 'db:clear-category-override',
    GET_APP_SESSIONS: 'db:get-app-sessions',
    GET_WEBSITE_SUMMARIES: 'db:get-website-summaries',
    GET_PEAK_HOURS: 'db:get-peak-hours',
    GET_WEEKLY_SUMMARY: 'db:get-weekly-summary',
    GET_APP_CHARACTER: 'db:get-app-character',
    GET_APP_DETAIL: 'db:get-app-detail',
    GET_APP_ACTIVITY_DIGEST: 'db:get-app-activity-digest',
    GET_WORK_MEMORY_SUMMARY: 'db:get-work-memory-summary',
    FORGET_WORK_MEMORY_PATTERN: 'db:forget-work-memory-pattern',
    FORGET_ALL_WORK_MEMORY: 'db:forget-all-work-memory',
    BACKFILL_WORK_MEMORY: 'db:backfill-work-memory',
    GET_WORK_MEMORY_PROFILE: 'db:get-work-memory-profile',
    UPDATE_WORK_MEMORY_FACT: 'db:update-work-memory-fact',
    ADD_WORK_MEMORY_FACT: 'db:add-work-memory-fact',
    FORGET_WORK_MEMORY_FACT: 'db:forget-work-memory-fact',
    CONFIRM_DRAFTED_MEMORY_FACT: 'db:confirm-drafted-memory-fact',
    LIST_SUPPLIED_MEMORY_FACTS: 'db:list-supplied-memory-facts',
    UPDATE_SUPPLIED_MEMORY_FACT: 'db:update-supplied-memory-fact',
    DELETE_SUPPLIED_MEMORY_FACT: 'db:delete-supplied-memory-fact',
    LIST_MEMORY_PROPOSAL_REJECTIONS: 'db:list-memory-proposal-rejections',
    DELETE_MEMORY_PROPOSAL_REJECTION: 'db:delete-memory-proposal-rejection',
    REBUILD_WORK_MEMORY: 'db:rebuild-work-memory',
    GET_MEMORY_AUDIT: 'db:get-memory-audit',
    GET_SCOPED_MEMORY_PROFILE: 'db:get-scoped-memory-profile',
    ADD_CLIENT_MEMORY_FACT: 'db:add-client-memory-fact',
    GET_BLOCK_DETAIL: 'db:get-block-detail',
    GET_WORKFLOW_SUMMARIES: 'db:get-workflow-summaries',
    GET_ARTIFACT_DETAILS: 'db:get-artifact-details',
    SET_BLOCK_LABEL_OVERRIDE: 'db:set-block-label-override',
    CLEAR_BLOCK_LABEL_OVERRIDE: 'db:clear-block-label-override',
    SET_BLOCK_REVIEW: 'db:set-block-review',
    DELETE_TIMELINE_BLOCK: 'db:delete-timeline-block',
    MERGE_TIMELINE_EPISODES: 'db:merge-timeline-episodes',
    SET_BLOCK_SPAN: 'db:set-block-span',
    UPDATE_TIMELINE_BLOCK: 'db:update-timeline-block',
    PURGE_TRACKED_EVIDENCE: 'db:purge-tracked-evidence',
    PURGE_TIMELINE_BLOCK: 'db:purge-timeline-block',
    PREVIEW_CORRECTION: 'db:preview-correction',
    APPLY_CORRECTION: 'db:apply-correction',
    UNDO_CORRECTION: 'db:undo-correction',
    GET_DISTRACTION_COST: 'db:get-distraction-cost',
    GET_TIMELINE_RANGE_BLOCKS: 'db:get-timeline-range-blocks',
  },
  DEBUG: {
    GET_INFO: 'debug:get-info',
  },
  FOCUS: {
    START: 'focus:start',
    STOP: 'focus:stop',
    GET_ACTIVE: 'focus:get-active',
    GET_RECENT: 'focus:get-recent',
    GET_BY_DATE_RANGE: 'focus:get-by-date-range',
    GET_BREAK_RECOMMENDATION: 'focus:get-break-recommendation',
    SAVE_REFLECTION: 'focus:save-reflection',
    GET_DISTRACTION_COUNT: 'focus:get-distraction-count',
  },
  AI: {
    SEND_MESSAGE: 'ai:send-message',
    CANCEL_MESSAGE: 'ai:cancel-message',
    PAUSE_MESSAGE: 'ai:pause-message',
    TURN_PHASE: 'ai:turn-phase',
    LIST_PAUSED_TURNS: 'ai:list-paused-turns',
    DISCARD_PAUSED_TURN: 'ai:discard-paused-turn',
    GET_MODEL_COSTS: 'ai:get-model-costs',
    STREAM_EVENT: 'ai:stream-event',
    AGENT_QUESTION: 'ai:agent-question',
    AGENT_ANSWER: 'ai:agent-answer',
    GET_STARTER_SUGGESTIONS: 'ai:get-starter-suggestions',
    COMMIT_ACTION: 'ai:commit-action',
    UNDO_ACTION: 'ai:undo-action',
    DISMISS_ACTION: 'ai:dismiss-action',
    SET_MESSAGE_FEEDBACK: 'ai:set-message-feedback',
    GENERATE_DAY_SUMMARY: 'ai:generate-day-summary',
    GET_WEEK_REVIEW: 'ai:get-week-review',
    GET_APP_NARRATIVE: 'ai:get-app-narrative',
    GET_WRAPPED_NARRATIVE: 'ai:get-wrapped-narrative',
    GET_WRAPPED_PERIOD_NARRATIVE: 'ai:get-wrapped-period-narrative',
    GET_DAY_ANALYSIS_HISTORY: 'ai:get-day-analysis-history',
    GET_WRAP_PROVIDER_STATE: 'ai:get-wrap-provider-state',
    GET_WRAP_PREFLIGHT: 'ai:get-wrap-preflight',
    ASK_WRAPPED: 'ai:ask-wrapped',
    GENERATE_BLOCK_INSIGHT: 'ai:generate-block-insight',
    REGENERATE_BLOCK_LABEL: 'ai:regenerate-block-label',
    SUGGEST_APP_CATEGORY: 'ai:suggest-app-category',
    DETECT_CLI_TOOLS: 'ai:detect-cli-tools',
    TEST_CLI_TOOL: 'ai:test-cli-tool',
    LIST_THREADS: 'ai:list-threads',
    GET_THREAD: 'ai:get-thread',
    ARCHIVE_THREAD: 'ai:archive-thread',
    RENAME_THREAD: 'ai:rename-thread',
    DELETE_THREAD: 'ai:delete-thread',
    GET_THREAD_SETTINGS: 'ai:get-thread-settings',
    SET_THREAD_SETTINGS: 'ai:set-thread-settings',
    OPEN_ARTIFACT: 'ai:open-artifact',
  },
  SETTINGS: {
    GET: 'settings:get',
    SET: 'settings:set',
    GET_ENRICHMENT_SOURCES: 'settings:get-enrichment-sources',
    HAS_API_KEY: 'settings:has-api-key',
    SET_API_KEY: 'settings:set-api-key',
    CLEAR_API_KEY: 'settings:clear-api-key',
    VALIDATE_API_KEY: 'settings:validate-api-key',
  },
  BILLING: {
    GET_ACCESS: 'billing:get-access',
    GET_USAGE: 'billing:get-usage',
    CREATE_POLAR_CHECKOUT: 'billing:create-polar-checkout',
    CREATE_FLUTTERWAVE_CHECKOUT: 'billing:create-flutterwave-checkout',
    OPEN_PORTAL: 'billing:open-portal',
    EXPORT_USAGE_CSV: 'billing:export-usage-csv',
    REFRESH: 'billing:refresh',
    GET_PAYMENTS: 'billing:get-payments',
    GET_SPEND_GUARDRAILS: 'billing:get-spend-guardrails',
  },
  PROJECTIONS: {
    INVALIDATED: 'projections:invalidated',
  },
  ICONS: {
    RESOLVE: 'icons:resolve',
  },
  NOTIFICATIONS: {
    GET_PERMISSION_STATE: 'notifications:get-permission-state',
    REQUEST_PERMISSION: 'notifications:request-permission',
    OPEN_SETTINGS: 'notifications:open-settings',
  },
  TRACKING: {
    GET_LIVE: 'tracking:get-live',
    GET_DIAGNOSTICS: 'tracking:get-diagnostics',
    GET_PROCESS_METRICS: 'tracking:get-process-metrics',
    GET_PERMISSION_STATE: 'tracking:get-permission-state',
    GET_PERMISSION_DETAILS: 'tracking:get-permission-details',
    REQUEST_SCREEN_PERMISSION: 'tracking:request-screen-permission',
    // DEV-229: main-process permission watcher — a pull for the current
    // verdict plus a push channel fired on every status change.
    GET_CAPTURE_VERIFICATION: 'tracking:get-capture-verification',
    CAPTURE_VERIFICATION_CHANGED: 'tracking:capture-verification-changed',
    // Delete already-captured history for an excluded app/site.
    DELETE_APP_HISTORY: 'tracking:delete-app-history',
    DELETE_SITE_HISTORY: 'tracking:delete-site-history',
    DELETE_ACTIVITY: 'tracking:delete-activity',
  },
  APP: {
    RELAUNCH: 'app:relaunch',
    COMPLETE_ONBOARDING: 'app:complete-onboarding',
    SET_CAPTURE_CONSENT: 'app:set-capture-consent',
    GET_COMPUTER_NAME: 'app:get-computer-name',
    RESET_AND_UNINSTALL: 'app:reset-and-uninstall',
  },
  INTERCOM: {
    GET_IDENTITY: 'intercom:get-identity',
  },
  SYNC: {
    GET_STATUS: 'sync:get-status',
    LINK: 'sync:link',
    CREATE_BROWSER_LINK: 'sync:create-browser-link',
    DISCONNECT: 'sync:disconnect',
    GET_MNEMONIC: 'sync:get-mnemonic',
  },
  ATTRIBUTION: {
    GET_CLIENT_QUERY: 'attribution:get-client-query',
    GET_DAY_CONTEXT: 'attribution:get-day-context',
    FIND_CLIENT: 'attribution:find-client',
    LIST_CLIENTS: 'attribution:list-clients',
    LIST_CLIENTS_DETAILED: 'attribution:list-clients-detailed',
    LIST_PROJECTS: 'attribution:list-projects',
    CREATE_CLIENT: 'attribution:create-client',
    ENSURE_CLIENTS: 'attribution:ensure-clients',
    UPDATE_CLIENT: 'attribution:update-client',
    ARCHIVE_CLIENT: 'attribution:archive-client',
    RESTORE_CLIENT: 'attribution:restore-client',
    DELETE_CLIENT: 'attribution:delete-client',
    RUN_FOR_RANGE: 'attribution:run-for-range',
    GET_CLIENT_DETAIL: 'attribution:get-client-detail',
    GET_WORK_SESSIONS_FOR_DAY: 'attribution:get-work-sessions-for-day',
    GET_WORK_SESSION_SEGMENTS: 'attribution:get-work-session-segments',
    GET_ROLLUPS: 'attribution:get-rollups',
    GET_APP_WORK_SESSIONS: 'attribution:get-app-work-sessions',
    REASSIGN_SESSION: 'attribution:reassign-session',
    REASSIGN_RANGE: 'attribution:reassign-range',
  },
  ENTITIES: {
    LIST: 'entities:list',
    DETAIL: 'entities:detail',
    SUGGESTED_MERGES: 'entities:suggested-merges',
    MERGE_ALL_DUPLICATES: 'entities:merge-all-duplicates',
    PREVIEW_CORRECTION: 'entities:preview-correction',
    APPLY_CORRECTION: 'entities:apply-correction',
    UNDO_CORRECTION: 'entities:undo-correction',
    CREATE_PROJECT: 'entities:create-project',
  },
  SCREEN_CONTEXT: {
    // The screen-context experiment surface (DEV-198). Consent, pause, and
    // revoke gate the DEV-197 lifecycle; backlog/quarantine inspection with
    // explicit Retry/Delete; and the full wipe that removes every raw frame
    // AND every derived record. All local — nothing here touches the network.
    STATUS: 'screen-context:status',
    ENABLE: 'screen-context:enable',
    SET_PAUSED: 'screen-context:set-paused',
    REVOKE: 'screen-context:revoke',
    LIST_BACKLOG: 'screen-context:list-backlog',
    RETRY_FRAME: 'screen-context:retry-frame',
    DELETE_FRAME: 'screen-context:delete-frame',
    DELETE_FOR_SOURCE: 'screen-context:delete-for-source',
    WIPE: 'screen-context:wipe',
    DIAGNOSTIC_SAMPLE: 'screen-context:diagnostic-sample',
  },
  FILE_ACCESS: {
    LIST_GRANTS: 'file-access:list-grants',
    ADD_GRANT: 'file-access:add-grant',
    REVOKE_GRANT: 'file-access:revoke-grant',
    LIST_DISCLOSURES: 'file-access:list-disclosures',
    PICK_PATH: 'file-access:pick-path',
  },
  EXPORT: {
    // Full-history export (DEV-196). PLAN previews what an export would
    // contain; RUN streams the database into a folder the person chose and
    // verifies it; VERIFY re-checks any previous export against its manifest.
    PLAN: 'export:plan',
    CHOOSE_DESTINATION: 'export:choose-destination',
    RUN: 'export:run',
    VERIFY: 'export:verify',
    PROGRESS: 'export:progress',
  },
  CONTEXT_PACKETS: {
    GET: 'context-packets:get',
    GET_FOR_MESSAGE: 'context-packets:get-for-message',
    LIST: 'context-packets:list',
    // DEV-183: the assembled read-only inspection behind "What the AI saw" —
    // the recorded packet grouped per kind, with omissions in plain language
    // and each item checked against the evidence backing it today.
    INSPECT: 'context-packets:inspect',
    LIST_ENTRIES: 'context-packets:list-entries',
  },
  SHELL: {
    OPEN_EXTERNAL: 'shell:open-external',
    OPEN_PATH: 'shell:open-path',
  },
  MCP: {
    GET_CONFIG: 'mcp:get-config',
  },
  ERRORS: {
    RENDERER_CRASH: 'errors:renderer-crash',
  },
  SYSTEM: {
    THEME_CHANGED: 'system:theme-changed',
  },
} as const

// A render crash caught by the renderer's ErrorBoundary, forwarded to the main
// process for Sentry reporting. Code-level context only (error identity plus
// React component names) — never captured activity, titles, or page content.
export interface RendererCrashReport {
  name: string
  message: string
  stack: string | null
  componentStack: string | null
  boundary: string
}
