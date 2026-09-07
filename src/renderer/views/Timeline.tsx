import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { EyeOff, Trash2, X } from 'lucide-react'
import { ANALYTICS_EVENT, blockCountBucket, trackedTimeBucket } from '@shared/analytics'
import type { AIDaySummaryResult, AISurfaceSummary, AppCategory, AttributionProject, CalendarRangeBlock, CalendarRangeDay, ClientRecord, CorrectionCommand, DayTimelinePayload, RebuildTimelineDayResult, TimelineAnalyzeProgress, TimelineClarification, TimelineClarificationAnswer, TimelineGapSegment, TimelineScheduledMeeting, WorkContextBlock } from '@shared/types'
import { activityColorForCategory, leisureBlocksDimmed } from '@shared/activityColors'
import { assignLanes, calendarCardHeights } from '../lib/timelineBlockLayout'
import { blockActiveSeconds, blockDisplayedSpanSeconds } from '@shared/blockDuration'
import { userVisibleBlockLabel } from '@shared/blockLabel'
import { blockTypeTag, effectiveBlockKind } from '@shared/workKind'
import AppIcon from '../components/AppIcon'
import EntityIcon from '../components/EntityIcon'
import EvidenceIdentity from '../components/EvidenceIdentity'
import PeriodNavigator from '../components/PeriodNavigator'
import { useCompactLayout } from '../hooks/useCompactLayout'
import { useProjectionResource } from '../hooks/useProjectionResource'
import { track } from '../lib/analytics'
import { buildDetailRowTree, type DetailRowNode } from '../lib/blockDetailRowTree'
import {
  blockSpanDraftChanged,
  clampEndTimeDraft,
  clampStartTimeDraft,
  draftTimeInputChange,
  fromTimeInputValue,
  toTimeInputValue,
} from '../lib/blockTimeEdit'
import { useCorrectionFlow } from '../components/CorrectionFlow'
import { mergeSelectionSpan, spanMergeState } from '../lib/timelineMergeSelection'
import { ipc } from '../lib/ipc'
import { sanitizeIpcError } from '../lib/ipcError'
import { formatDisplayAppName } from '../lib/apps'
import { formatDuration, formatFullDate, shiftDateString, todayString, weekStartString } from '../lib/format'
import { openArtifact } from '../lib/openTarget'
import { activityCategoryLabel, EDITABLE_BLOCK_CATEGORY_OPTIONS } from '@shared/activityCategories'
import { blockShortSummary, cleanTitleForDisplay, safeTimelineText, shortDomainLabel } from '../lib/timelineText'

// The types a user can assign a block in Edit → Type. Category drives the
// block's color everywhere, so this doubles as the recolor control. The
// neutral system/uncategorized values are not offered — a corrected block
// always has a real type.
const BLOCK_CATEGORY_OPTIONS = EDITABLE_BLOCK_CATEGORY_OPTIONS

function weekRangeLabel(dateStr: string): string {
  const start = weekStartString(dateStr)
  const end = shiftDateString(start, 6)
  const [sy, sm, sd] = start.split('-').map(Number)
  const [ey, em, ed] = end.split('-').map(Number)
  const startLabel = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(sy, sm - 1, sd))
  const endLabel = sm === em
    ? String(ed)
    : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(ey, em - 1, ed))
  return `${startLabel}–${endLabel}`
}

function formatClockTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp)
}

// Human-readable phrasing for why an episode started or stopped.

function blockNarrative(block: WorkContextBlock): string | null {
  return block.label.narrative?.trim() || null
}

// Calendar geometry. The timeline is drawn as a real calendar grid: a block
// sits at its wall-clock position (top = start, bottom = end), so height =
// duration falls out of the clock itself (timeline.md §3.4 / invariant 1) and
// gaps read as the empty space they are.
const DAY_HOUR_HEIGHT = 88
const WEEK_HOUR_HEIGHT = 52
const TIME_GUTTER_WIDTH = 56
// Day/week zoom (DEV-235): shortcut/gesture-driven only — ⌘+/⌘−/⌘0 and
// pinch (or ⌘-scroll) on the grid; no persistent on-screen control. Day and
// week each keep their own zoom level, persisted so the choice sticks.
const TIMELINE_ZOOM_MIN = 0.6
const TIMELINE_ZOOM_MAX = 1.8
const TIMELINE_ZOOM_STEP = 0.2
type ZoomableView = 'day' | 'week'
const TIMELINE_ZOOM_KEYS: Record<ZoomableView, string> = {
  day: 'daylens.timeline.zoom.day',
  week: 'daylens.timeline.zoom.week',
}
// The pre-split single-factor key; migrated into both views on first load.
const TIMELINE_ZOOM_LEGACY_KEY = 'daylens.timeline.zoom'
function loadTimelineZoom(): Record<ZoomableView, number> {
  if (typeof localStorage === 'undefined') return { day: 1, week: 1 }
  const legacy = Number(localStorage.getItem(TIMELINE_ZOOM_LEGACY_KEY))
  const fallback = Number.isFinite(legacy) && legacy >= TIMELINE_ZOOM_MIN && legacy <= TIMELINE_ZOOM_MAX ? legacy : 1
  const load = (view: ZoomableView): number => {
    const stored = Number(localStorage.getItem(TIMELINE_ZOOM_KEYS[view]))
    return Number.isFinite(stored) && stored >= TIMELINE_ZOOM_MIN && stored <= TIMELINE_ZOOM_MAX ? stored : fallback
  }
  return { day: load('day'), week: load('week') }
}
// Smallest drawable card. The engine's 15-minute floor means a real block at
// the day scale is ≥ 22px; this only catches meetings and edge-case slivers,
// and 22px is the least height at which a one-line title still reads.
const MIN_CARD_HEIGHT = 22
// Day-view floor: a block that just started must still read and click like a
// real calendar event (title + time row), not a sliver. 44px is the least
// height that shows both lines.
const MIN_DAY_CARD_HEIGHT = 44

// The read-only block detail panel is height-capped so it never grows with its
// content: the title header stays fixed and the evidence below scrolls inside a
// bounded box. Two candidate caps render side by side under the dev preview
// (?panelVariants=1) to compare final feel before settling on one.
const DETAIL_PANEL_MAX_HEIGHT_A = 320
const DETAIL_PANEL_MAX_HEIGHT_B = 480
const DETAIL_PANEL_MAX_HEIGHT_DEFAULT = 560

// Daylens won't shape a day into named blocks until there's enough to work
// with — at least 2 hours tracked. Below this the Analyze action stays
// disabled with a gentle "keep going" nudge.
const ANALYZE_MIN_SECONDS = 2 * 60 * 60

// The day's tracked seconds, from the same blocks the timeline draws (invariant
// 7) with the raw total as a floor. Shared by the recap footer and the gate.
function trackedSecondsFor(payload: DayTimelinePayload): number {
  const blockSeconds = payload.blocks.reduce((sum, block) => sum + blockActiveSeconds(block), 0)
  return blockSeconds > 0 ? blockSeconds : payload.totalSeconds
}

// Local midnight of a YYYY-MM-DD date — the top of that day's calendar track.
function dayStartMs(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

// The furthest the track may run past midnight. A block owned by the day can
// spill into the small hours (the owned day carries late-night work), so the
// track extends with it — up to 6 AM the next day as a sanity cap.
const MAX_TRACK_MINUTES = 30 * 60

// Minutes from local midnight. Not clamped to 24h: a block that runs past
// midnight extends the track instead of piling up at the bottom edge.
function minutesIntoDay(ts: number, dayStart: number): number {
  return Math.min(MAX_TRACK_MINUTES, Math.max(0, (ts - dayStart) / 60_000))
}

function hourLabel(hour: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(new Date(2000, 0, 1, hour % 24))
}

// The day bounds follow actual activity: the track runs from the hour of the
// first tracked event to the hour of the last — empty midnight hours simply
// don't exist in the view. On today the track extends to "now" so the
// current-time line always has a home.
interface TrackBounds {
  startHour: number
  endHour: number
}

function trackBoundsFor(
  days: Array<{ date: string; blocks: WorkContextBlock[]; scheduledMeetings?: TimelineScheduledMeeting[] }>,
  nowMs: number | null,
): TrackBounds {
  let firstMin = Number.POSITIVE_INFINITY
  let lastMin = Number.NEGATIVE_INFINITY
  for (const day of days) {
    const dayStart = dayStartMs(day.date)
    for (const block of day.blocks) {
      firstMin = Math.min(firstMin, minutesIntoDay(block.startTime, dayStart))
      lastMin = Math.max(lastMin, minutesIntoDay(block.endTime, dayStart))
    }
    // Scheduled context stretches the visible hours too: an 8am calendar-only
    // event must be on screen even when captured activity started at 10.
    for (const meeting of day.scheduledMeetings ?? []) {
      firstMin = Math.min(firstMin, minutesIntoDay(meeting.startMs, dayStart))
      lastMin = Math.max(lastMin, minutesIntoDay(meeting.endMs, dayStart))
    }
    if (nowMs != null && nowMs >= dayStart && nowMs < dayStart + 24 * 60 * 60_000) {
      lastMin = Math.max(lastMin, minutesIntoDay(nowMs, dayStart))
    }
  }
  if (!Number.isFinite(firstMin) || !Number.isFinite(lastMin) || lastMin <= firstMin) {
    return { startHour: 8, endHour: 18 }
  }
  const startHour = Math.max(0, Math.floor(firstMin / 60))
  const endHour = Math.min(MAX_TRACK_MINUTES / 60, Math.max(startHour + 1, Math.ceil(lastMin / 60)))
  return { startHour, endHour }
}

function monthKey(dateStr: string): string {
  return dateStr.slice(0, 7)
}

function monthLabel(dateStr: string): string {
  const [y, m] = dateStr.split('-').map(Number)
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1))
}

// First day of the month `delta` months away, as YYYY-MM-DD.
function shiftMonth(dateStr: string, delta: number): string {
  const [y, m] = dateStr.split('-').map(Number)
  const next = new Date(y, m - 1 + delta, 1)
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-01`
}

// Every date drawn on the month grid: full Monday-start weeks covering the
// month, so the grid is always 7 columns × 4–6 rows.
function monthGridDates(dateStr: string): string[] {
  const [y, m] = dateStr.split('-').map(Number)
  const first = `${y}-${String(m).padStart(2, '0')}-01`
  const lastDay = new Date(y, m, 0).getDate()
  const last = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  const start = weekStartString(first)
  const end = shiftDateString(weekStartString(last), 6)
  const dates: string[] = []
  for (let d = start; d <= end; d = shiftDateString(d, 1)) dates.push(d)
  return dates
}

interface TimelineNavState {
  view: 'day' | 'week' | 'month'
  date: string
}

function timelineNavStateFromParams(searchParams: URLSearchParams): TimelineNavState {
  const rawView = searchParams.get('view')
  return {
    view: rawView === 'week' ? 'week' : rawView === 'month' ? 'month' : 'day',
    date: searchParams.get('date') ?? todayString(),
  }
}

// One block drawn as a calendar event: absolutely positioned at its clock
// time inside a day track. `compact` is the week-column variant (smaller
// type, title-first, no prose).
function CalendarBlockCard({
  block,
  top,
  height,
  left,
  width,
  compact,
  isSelected,
  inMergeRange = false,
  dimmed = false,
  onClick,
  onContextMenu,
}: {
  block: WorkContextBlock
  top: number
  height: number
  // Google-Calendar lane geometry: overlapping cards share the track by
  // column, so `left`/`width` are CSS lengths, not the old fixed inset.
  left: string
  width: string
  compact: boolean
  isSelected: boolean
  // True when this block sits inside the shift-selected merge span (but isn't
  // the anchor). It highlights like a selection so the whole run reads as one
  // pending merge, without claiming the single-selection panel.
  inMergeRange?: boolean
  // True when a tag filter is active and this block isn't in it. Filtered
  // blocks become flat neutral gray ghost cards — full-size, text dimmed but
  // readable, still clickable — so the shape of the day never lies (decided
  // Jul 22, DEV-235).
  dimmed?: boolean
  onClick?: (event: ReactMouseEvent) => void
  onContextMenu?: (event: ReactMouseEvent) => void
}) {
  // timeline.md §3.4 rule 4: color coding is universal — every block is drawn
  // in its category's accent, live or finalized. Only the NAME stays neutral
  // while live (§4); a provisional block already carries a real
  // dominantCategory computed from its accumulated evidence
  // (buildProvisionalLiveBlocks → buildBlockFromCandidate), so it just needs
  // to be read here instead of overridden with a hardcoded grey.
  const accent = activityColorForCategory(block.dominantCategory)
  // Leisure / personal blocks are muted so the eye finds work first —
  // unless the user turned that off (Settings → General → Dim leisure blocks).
  const muted = effectiveBlockKind(block) !== 'work' && leisureBlocksDimmed()
  const label = userVisibleBlockLabel(block)
  const timeRange = `${formatClockTime(block.startTime)} – ${formatClockTime(block.endTime)}`
  const showTime = height >= (compact ? 34 : 40)
  const titleLines = height >= (compact ? 48 : 56) ? 2 : 1

  return (
    <button
      type="button"
      data-timeline-block-id={block.id}
      aria-label={`Open ${label}, ${formatDuration(blockDisplayedSpanSeconds(block))}`}
      aria-pressed={isSelected}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={`${label} · ${timeRange}`}
      style={{
        position: 'absolute',
        top,
        height,
        left,
        width,
        // Explicit top-aligned column: a calendar event's title sits at its
        // start time. (A bare <button> vertically centers its content, which
        // floated the title into the middle of tall blocks.)
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        justifyContent: 'flex-start',
        textAlign: 'left',
        cursor: 'pointer',
        // Tight radius, flat fill: the calendar-app card shape. The old 3px
        // border-left rounded into pill caps at the stripe's ends — the accent
        // stripe is now an inset element (below) with square ends.
        borderRadius: compact ? 4 : 5,
        border: dimmed
          ? '1px solid var(--color-border-ghost)'
          : block.isLive
            ? `1.5px solid ${accent}`
            : (isSelected || inMergeRange) ? `1px solid ${accent}88` : `1px solid ${accent}26`,
        background: dimmed
          ? 'var(--color-surface-low, var(--color-surface))'
          : (isSelected || inMergeRange) ? `${accent}40` : block.isLive ? `${accent}33` : `${accent}26`,
        boxShadow: isSelected ? '0 6px 20px rgba(0,0,0,0.18)' : 'none',
        transition: 'border-color 120ms, background 120ms, opacity 120ms',
        padding: compact ? '2px 6px 2px 9px' : '4px 9px 4px 12px',
        // Day view: overflow stays visible so the sticky content wrapper below
        // can slide within the block. (overflow:hidden would make the card its
        // own scrollport and freeze the sticky text at the block top.) The
        // week's compact cards keep the clip — they're too small to stick.
        // A ghosted (filtered-out) block clips too: its dimmed text truncates
        // instead of overflowing onto a matching block or an event (DEV-234).
        overflow: (compact || dimmed) ? 'hidden' : 'visible',
        minWidth: 0,
        opacity: dimmed ? 0.55 : muted ? 0.75 : 1,
        zIndex: isSelected ? 3 : 1,
      }}
    >
      {/* The category stripe: inset with square ends so it never rounds into
          pill caps, hidden on ghosted blocks so only matches carry color. */}
      {!dimmed && (
        <span aria-hidden style={{
          position: 'absolute',
          left: compact ? 2 : 3,
          top: compact ? 2 : 3,
          bottom: compact ? 2 : 3,
          width: 3,
          borderRadius: 1,
          background: accent,
        }} />
      )}
      {/* The text pins into view while a tall block spans past the top of the
          scrollport — the block stays fixed in its time slot; only the timeline
          scrolls. Sticky keeps the title, time, and summary fully readable at
          every scroll position, with a small breathing offset. */}
      <div style={(compact || dimmed) ? undefined : { position: 'sticky', top: 8, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'start', gap: 6, minWidth: 0 }}>
        <span style={{
          flex: 1,
          minWidth: 0,
          fontSize: compact ? 11 : 12.5,
          fontWeight: dimmed ? 550 : 650,
          color: dimmed ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)',
          lineHeight: 1.25,
          display: '-webkit-box',
          WebkitBoxOrient: 'vertical',
          WebkitLineClamp: titleLines,
          overflow: 'hidden',
          overflowWrap: 'break-word',
          wordBreak: 'break-word',
        }}>
          {label}
        </span>
        {block.isLive && (
          <span aria-label="Live" style={{
            flexShrink: 0,
            marginTop: 3,
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: '#22c55e',
            animation: 'live-pulse 2s ease-in-out infinite',
          }} />
        )}
      </div>
      {/* Title + time on every card — the narrative lives in the detail panel
          (day view) or the popover (week view), shown on click. A TALL card
          additionally carries its one-line account, so hours of the day are
          never a large empty rectangle (DEV-286); short cards stay calm. */}
      {showTime && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: compact ? 10 : 11, color: 'var(--color-text-tertiary)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          <ClockGlyph size={compact ? 9 : 10} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {timeRange} · {formatDuration(blockDisplayedSpanSeconds(block))}
          </span>
        </div>
      )}
      {!compact && !dimmed && height >= 110 && (
        <div style={{
          marginTop: 6,
          fontSize: 11.5,
          lineHeight: 1.5,
          color: 'var(--color-text-secondary)',
          display: '-webkit-box',
          WebkitBoxOrient: 'vertical',
          WebkitLineClamp: 3,
          overflow: 'hidden',
          overflowWrap: 'break-word',
        }}>
          {blockNarrative(block) ?? blockShortSummary(block)}
        </div>
      )}
      </div>
    </button>
  )
}

// A tiny clock, Apple-Calendar style, marking a line as a time range.
function ClockGlyph({ size = 10 }: { size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 12 12" style={{ flexShrink: 0, opacity: 0.75 }}>
      <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 3.4 V6 L7.8 7.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// The hour labels column shared by the day and week grids. Runs only over the
// bounded span — the hours the day actually lived in.
function HourGutter({ hourHeight, bounds }: { hourHeight: number; bounds: TrackBounds }) {
  const hours = Array.from(
    { length: Math.max(0, bounds.endHour - bounds.startHour + 1) },
    (_, index) => bounds.startHour + index,
  )
  return (
    <div style={{ position: 'relative', height: (bounds.endHour - bounds.startHour) * hourHeight, width: TIME_GUTTER_WIDTH }}>
      {hours.map((hour) => (
        <div
          key={hour}
          style={{
            position: 'absolute',
            top: (hour - bounds.startHour) * hourHeight,
            right: 8,
            transform: 'translateY(-50%)',
            fontSize: 10,
            color: 'var(--color-text-tertiary)',
            whiteSpace: 'nowrap',
          }}
        >
          {hourLabel(hour)}
        </div>
      ))}
    </div>
  )
}

// One day as a 24-hour calendar track: hour lines, blocks at their clock
// positions, and the current-time line on today. Idle/away time renders as
// blank space between blocks, sized by the clock — no card, no fill, nothing
// clickable — but never unexplained: each visible gap carries one quiet
// line saying what kind of absence it was
// (Asleep / Away / Idle / Passive / Tracking paused / Untracked) and for how
// long. Blocks are buttons carrying data-timeline-block-id, so the day view's
// click-capture selection (plain click, shift-click merge, click-empty
// deselect) works unchanged.
function CalendarDayTrack({
  date,
  blocks,
  bounds,
  gapSegments = [],
  scheduledMeetings = [],
  onScheduledMeetingClick,
  hourHeight,
  compact = false,
  selectedBlockId = null,
  selectedSpanIds,
  nowMs = null,
  dimBlock,
  onBlockClick,
  onBlockContextMenu,
}: {
  date: string
  blocks: WorkContextBlock[]
  bounds: TrackBounds
  gapSegments?: TimelineGapSegment[]
  // DEV-189: scheduled calendar events. Ones without a supporting block draw
  // as an outline — context, never a block, never time (timeline.md
  // §Meetings: a calendar event alone is not proof the meeting occurred).
  // Evidence-matched ones are already represented by their meeting block.
  scheduledMeetings?: TimelineScheduledMeeting[]
  // Opens the attended/skipped/moved/unrelated mark menu for a scheduled
  // event outline (day view only).
  onScheduledMeetingClick?: (meeting: TimelineScheduledMeeting, event: ReactMouseEvent) => void
  hourHeight: number
  compact?: boolean
  selectedBlockId?: string | null
  // The blocks in the current shift-selected merge span (includes the anchor).
  // Everything in here highlights as one pending merge.
  selectedSpanIds?: ReadonlySet<string>
  nowMs?: number | null
  // When set, blocks outside the active tag filter render dimmed.
  dimBlock?: (block: WorkContextBlock) => boolean
  onBlockClick?: (block: WorkContextBlock, event: ReactMouseEvent) => void
  // Right-click on a block, Google-Calendar style (day view only).
  onBlockContextMenu?: (block: WorkContextBlock, event: ReactMouseEvent) => void
}) {
  const dayStart = dayStartMs(date)
  const trackStartMin = bounds.startHour * 60
  const trackEndMin = bounds.endHour * 60
  const trackHeight = ((trackEndMin - trackStartMin) / 60) * hourHeight
  const topFor = (ts: number) => ((minutesIntoDay(ts, dayStart) - trackStartMin) / 60) * hourHeight
  const nowMinutes = nowMs != null ? (nowMs - dayStart) / 60_000 : null
  const showNowLine = nowMinutes != null && nowMinutes >= trackStartMin && nowMinutes <= trackEndMin
  const hourCount = Math.max(0, bounds.endHour - bounds.startHour + 1)

  // The columns have ONE meaning (calendar-and-blocks spec, DEV-286): blocks
  // are the spine and always start at the left; scheduled events are quieter
  // context in their own column on the right, only where they overlap tracked
  // time. Blocks are a partition of the day and never overlap each other, so
  // they never split among themselves; events may overlap other events and
  // lane only against each other. Edge insets: 4px outer margin, 6px gutter.
  const unmatchedMeetings = compact ? [] : scheduledMeetings.filter((m) => m.matchedBlockId == null)
  const laneKeyForMeeting = (m: TimelineScheduledMeeting) => `m:${m.startMs}:${m.title}`
  const blockLayoutEnd = (block: WorkContextBlock): number =>
    block.isLive && nowMs != null ? Math.max(block.endTime, nowMs) : block.endTime
  const spansOverlap = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean =>
    Math.min(aEnd, bEnd) - Math.max(aStart, bStart) > 0
  // The event column's share of the track where an event sits beside a block.
  const EVENT_COLUMN_PCT = 38
  const eventLaneInputs = unmatchedMeetings.map((m) => ({ key: laneKeyForMeeting(m), start: m.startMs, end: m.endMs }))
  const eventPlacements = assignLanes(eventLaneInputs)
  const eventLaneByKey = new Map(eventLaneInputs.map((input, i) => [input.key, eventPlacements[i]]))
  const blockGeometry = (block: WorkContextBlock): { left: string; width: string } => {
    const besideEvent = unmatchedMeetings.some((m) =>
      spansOverlap(block.startTime, blockLayoutEnd(block), m.startMs, m.endMs))
    return besideEvent
      ? { left: '4px', width: `calc(${100 - EVENT_COLUMN_PCT}% - 10px)` }
      : { left: '4px', width: 'calc(100% - 8px)' }
  }
  const meetingGeometry = (meeting: TimelineScheduledMeeting): { left: string; width: string } => {
    const placement = eventLaneByKey.get(laneKeyForMeeting(meeting)) ?? { lane: 0, lanes: 1 }
    const besideBlock = blocks.some((block) =>
      spansOverlap(block.startTime, blockLayoutEnd(block), meeting.startMs, meeting.endMs))
    const regionLeftPct = besideBlock ? 100 - EVENT_COLUMN_PCT : 0
    const regionWidthPct = besideBlock ? EVENT_COLUMN_PCT : 100
    const columnPct = regionWidthPct / placement.lanes
    return {
      left: `calc(${regionLeftPct + placement.lane * columnPct}% + ${besideBlock ? 0 : 4}px)`,
      width: `calc(${columnPct}% - ${besideBlock || placement.lanes > 1 ? 6 : 8}px)`,
    }
  }

  return (
    <div style={{ position: 'relative', height: trackHeight, minWidth: 0 }}>
      {/* Hour lines, quieter than any card border: the grid should be felt,
          not read — a whisper under the blocks in both day and week tracks. */}
      {Array.from({ length: hourCount }, (_, index) => (
        <div
          key={index}
          style={{
            position: 'absolute',
            top: index * hourHeight,
            left: 0,
            right: 0,
            borderTop: '1px solid var(--color-border-ghost)',
            opacity: 0.45,
            pointerEvents: 'none',
          }}
        />
      ))}

      {/* Gap reasons: the blank space stays blank — one quiet, non-interactive
          line names the kind of absence and its length. */}
      {!compact && gapSegments.map((gap) => {
        const top = topFor(gap.startTime)
        const gapHeight = topFor(gap.endTime) - top
        if (gapHeight < 26) return null
        // A scheduled event can span the same empty stretch ("Wind down for
        // bed" over an idle evening). The caption keeps its own readable
        // backdrop and sits above the event outline so the two never render
        // as colliding text (DEV-286).
        const overlapsEvent = unmatchedMeetings.some((m) =>
          spansOverlap(gap.startTime, gap.endTime, m.startMs, m.endMs))
        return (
          <div
            key={`gap:${gap.startTime}`}
            style={{
              position: 'absolute',
              top,
              height: gapHeight,
              left: 4,
              right: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
              zIndex: 2,
            }}
          >
            <span style={{
              fontSize: 11,
              color: 'var(--color-text-tertiary)',
              whiteSpace: 'nowrap',
              ...(overlapsEvent ? {
                background: 'var(--color-surface)',
                border: '1px solid var(--color-border-ghost)',
                borderRadius: 999,
                padding: '2px 8px',
              } : {}),
            }}>
              {gap.label} · {formatDuration(Math.max(60, Math.round((gap.endTime - gap.startTime) / 1000)))}
            </span>
          </div>
        )
      })}

      {/* Scheduled context (DEV-189): scheduled events with no supporting
          block, drawn as quiet outlines under the real blocks. No fill, no
          minutes — a calendar entry is never activity. Dashed = calendar-only
          (or explicitly marked skipped/moved/unrelated); solid = the person
          confirmed attendance. Clicking opens the attended/skipped/moved/
          unrelated mark menu (timeline.md §Meetings). */}
      {!compact && scheduledMeetings.filter((meeting) => meeting.matchedBlockId == null).map((meeting) => {
        const top = topFor(meeting.startMs)
        const ghostHeight = Math.max(20, topFor(meeting.endMs) - top)
        const confirmed = meeting.attendance === 'matched'
        const declined = meeting.marked === 'skipped' || meeting.marked === 'unrelated'
        // Calendar-and-blocks spec: when tracked activity overlaps the event,
        // the blocks are the spine and the event is faint context beside them
        // — never a filled slab competing with the real work (DEV-285). Only
        // an event over genuinely empty time keeps the attended hatch, and it
        // says plainly that nothing was captured.
        const overlapsActivity = blocks.some((block) =>
          Math.min(block.endTime, meeting.endMs) - Math.max(block.startTime, meeting.startMs) > 0)
        // Outlined ghost card (decided Jul 22, DEV-264): a real card spanning
        // the event's scheduled duration — hairline border, near-transparent
        // fill. Dashed = unconfirmed plan; solid + check = you attended;
        // struck title, fainter = you said you didn't. "Planned" next to the
        // solid "happened" blocks — never activity, never counted time.
        const stateLine = confirmed
          ? (overlapsActivity ? '✓ Attended' : '✓ Attended · nothing captured')
          : meeting.marked === 'skipped'
            ? 'Skipped'
            : meeting.marked === 'moved'
              ? 'Moved'
              : meeting.marked === 'unrelated'
                ? 'Unrelated'
                : (overlapsActivity ? 'Scheduled' : 'Scheduled · nothing captured')
        return (
          <div
            key={`scheduled:${meeting.startMs}:${meeting.title}`}
            title={confirmed
              ? (overlapsActivity
                ? `${meeting.title} — you marked this attended; the tracked blocks beside it are the observed activity`
                : `${meeting.title} — you marked this attended; no screen activity was captured in this window`)
              : `${meeting.title} — on your calendar; no observed activity supports that you attended`}
            onClick={onScheduledMeetingClick ? (event) => onScheduledMeetingClick(meeting, event) : undefined}
            style={{
              position: 'absolute',
              top,
              // The seam: every event card stops 2px short of its slot, so
              // back-to-back events read as two cards with daylight between
              // them (the Apple/Google convention) — imperceptible on a lone
              // event, decisive in a stack.
              height: Math.max(18, ghostHeight - 2),
              ...meetingGeometry(meeting),
              borderRadius: 5,
              // --color-border is transparent by design; events need a real
              // (still hairline) edge to exist against their faint fill.
              border: confirmed ? '1px solid rgba(127, 127, 127, 0.35)' : '1px dashed rgba(127, 127, 127, 0.35)',
              // Attended reads as "consumed": the Apple-Calendar diagonal
              // hatch — but only over empty time. Over tracked activity the
              // blocks carry the story and the event stays a quiet outline.
              background: confirmed && !overlapsActivity
                ? 'repeating-linear-gradient(-45deg, rgba(127, 127, 127, 0.13) 0 3px, transparent 3px 8px)'
                : 'rgba(127, 127, 127, 0.05)',
              padding: '3px 9px',
              overflow: 'hidden',
              cursor: onScheduledMeetingClick ? 'pointer' : 'default',
              opacity: declined ? 0.55 : 1,
              zIndex: 1,
            }}
          >
            <div style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--color-text-secondary)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              textDecoration: declined ? 'line-through' : 'none',
            }}>
              {meeting.title}
            </div>
            {ghostHeight >= 36 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontVariantNumeric: 'tabular-nums' }}>
                <ClockGlyph size={9} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {formatClockTime(meeting.startMs)} – {formatClockTime(meeting.endMs)} · {stateLine}
                </span>
              </div>
            )}
          </div>
        )
      })}

      {(() => {
        // Card heights are computed together so the readability floor can be
        // clamped against the NEXT block: a floored short card must never paint
        // over the idle gap's caption or the next block (invariant 4 — the
        // clock wins over the floor). See renderer/lib/timelineBlockLayout.ts.
        const spans = blocks.map((block) => {
          const top = topFor(block.startTime)
          // The live block's payload end freezes at the moment the payload was
          // computed; glue its bottom to the current-time line so the active
          // session visibly grows between refreshes instead of lagging the clock.
          const layoutEnd = block.isLive && nowMs != null ? Math.max(block.endTime, nowMs) : block.endTime
          return { top, bottom: topFor(layoutEnd) }
        })
        const heights = calendarCardHeights(spans, compact ? MIN_CARD_HEIGHT : MIN_DAY_CARD_HEIGHT)
        return blocks.map((block, index) => {
        const top = spans[index].top
        const height = heights[index]
        return (
          <CalendarBlockCard
            key={block.id}
            block={block}
            top={top}
            height={height}
            {...blockGeometry(block)}
            compact={compact}
            isSelected={selectedBlockId === block.id}
            inMergeRange={selectedBlockId !== block.id && (selectedSpanIds?.has(block.id) ?? false)}
            dimmed={dimBlock ? dimBlock(block) : false}
            onClick={onBlockClick ? (event) => onBlockClick(block, event) : undefined}
            onContextMenu={onBlockContextMenu ? (event) => onBlockContextMenu(block, event) : undefined}
          />
        )
        })
      })()}

      {/* The current-time line, Google-Calendar style: a thin red line across
          the track with a dot at its left edge, drawn over the blocks. */}
      {showNowLine && (
        <div style={{
          position: 'absolute',
          top: ((nowMinutes - trackStartMin) / 60) * hourHeight,
          left: 0,
          right: 0,
          zIndex: 4,
          pointerEvents: 'none',
        }}>
          <div style={{ position: 'absolute', left: -3, top: -3.5, width: 8, height: 8, borderRadius: '50%', background: '#ef4444' }} />
          <div style={{ borderTop: '2px solid #ef4444' }} />
        </div>
      )}
    </div>
  )
}

// The mark menu on a scheduled event outline (DEV-189, timeline.md
// §Meetings: "A person can mark a scheduled meeting as attended, skipped,
// moved, or unrelated"). Every choice flows through the corrections
// machinery — previewed, durable, undoable.
function ScheduledMeetingMenu({
  x,
  y,
  meeting,
  busy,
  onMark,
  onClose,
}: {
  x: number
  y: number
  meeting: TimelineScheduledMeeting
  busy: boolean
  onMark: (status: 'attended' | 'skipped' | 'moved' | 'unrelated' | null) => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const MENU_WIDTH = 220
  const options: Array<{ status: 'attended' | 'skipped' | 'moved' | 'unrelated' | null; label: string }> = [
    { status: 'attended', label: 'I attended this' },
    { status: 'skipped', label: 'I skipped it' },
    { status: 'moved', label: 'It moved' },
    { status: 'unrelated', label: 'Not related to my day' },
    ...(meeting.marked || meeting.attendance === 'matched' ? [{ status: null, label: 'Clear my mark' } as const] : []),
  ]
  const MENU_HEIGHT = options.length * 36 + 42
  const left = Math.min(x, window.innerWidth - MENU_WIDTH - 8)
  const top = Math.min(y, window.innerHeight - MENU_HEIGHT - 8)

  const itemStyle: CSSProperties = {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    border: 'none',
    background: 'transparent',
    borderRadius: 7,
    padding: '7px 10px',
    fontSize: 12.5,
    fontWeight: 600,
    color: 'var(--color-text-primary)',
    cursor: busy ? 'default' : 'pointer',
    opacity: busy ? 0.5 : 1,
  }

  return (
    <div
      data-timeline-inspector="true"
      style={{ position: 'fixed', inset: 0, zIndex: 60 }}
      onClick={onClose}
      onContextMenu={(event) => { event.preventDefault(); onClose() }}
    >
      <div
        role="menu"
        style={{
          position: 'fixed',
          left,
          top,
          width: MENU_WIDTH,
          borderRadius: 10,
          border: '1px solid var(--color-border-ghost)',
          background: 'var(--color-surface)',
          boxShadow: '0 12px 36px rgba(0,0,0,0.24)',
          padding: 5,
          zIndex: 61,
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={{ padding: '6px 10px 4px', fontSize: 11, fontWeight: 700, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {meeting.title}
        </div>
        {options.map((option) => (
          <button
            key={option.label}
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => onMark(option.status)}
            style={itemStyle}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-high)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// The right-click menu on a block, Google-Calendar style: Edit, Regenerate
// summary, Delete. Rendered fixed at the cursor; a full-screen backdrop closes
// it on any click or Escape.
function BlockContextMenu({
  x,
  y,
  busy,
  onEdit,
  onSplit,
  onRegenerate,
  onDelete,
  onClose,
  mergeSpan,
  mergeAbove,
  mergeBelow,
}: {
  x: number
  y: number
  busy: boolean
  onEdit: () => void
  // Split at a chosen time — opens the small time-picker dialog. Hidden for
  // provisional blocks (the day hasn't settled enough to cut).
  onSplit: (() => void) | null
  onRegenerate: () => void
  onDelete: () => void
  onClose: () => void
  // The shift-selected multi-block merge. Set only when the right-clicked
  // block is part of an active span of two or more; it then replaces the
  // single-neighbour above/below items with one "Merge N blocks" action, so
  // both merge gestures live in the same menu without stacking up (spec §2).
  mergeSpan: { count: number; disabled: boolean; onClick: () => void } | null
  // Omitted entirely when the block has no neighbour on that side; disabled
  // (but still shown) when a neighbour exists but can't yet be merged (a
  // live block on either side of the pair) — timeline.md §2/§3.4 rule 5.
  mergeAbove: { disabled: boolean; onClick: () => void } | null
  mergeBelow: { disabled: boolean; onClick: () => void } | null
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const MENU_WIDTH = 200
  const ITEM_HEIGHT = 36
  const itemCount = 3 + (onSplit ? 1 : 0) + (mergeSpan ? 1 : (mergeAbove ? 1 : 0) + (mergeBelow ? 1 : 0))
  const MENU_HEIGHT = itemCount * ITEM_HEIGHT + 10
  const left = Math.min(x, window.innerWidth - MENU_WIDTH - 8)
  const top = Math.min(y, window.innerHeight - MENU_HEIGHT - 8)

  const itemStyle = (danger = false): CSSProperties => ({
    display: 'block',
    width: '100%',
    textAlign: 'left',
    border: 'none',
    background: 'transparent',
    borderRadius: 7,
    padding: '7px 10px',
    fontSize: 12.5,
    fontWeight: 600,
    color: danger ? '#f87171' : 'var(--color-text-primary)',
    cursor: busy ? 'default' : 'pointer',
    opacity: busy ? 0.5 : 1,
  })

  return (
    <div
      // Marked as inspector chrome so the day grid's capture-phase click
      // handler leaves the selection alone — clicking a menu item (or the
      // backdrop to dismiss) must not bleed into select/deselect state.
      data-timeline-inspector="true"
      style={{ position: 'fixed', inset: 0, zIndex: 60 }}
      onClick={onClose}
      onContextMenu={(event) => { event.preventDefault(); onClose() }}
    >
      <div
        role="menu"
        style={{
          position: 'fixed',
          left,
          top,
          width: MENU_WIDTH,
          borderRadius: 10,
          border: '1px solid var(--color-border-ghost)',
          background: 'var(--color-surface)',
          boxShadow: '0 12px 36px rgba(0,0,0,0.24)',
          padding: 5,
          zIndex: 61,
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" role="menuitem" disabled={busy} onClick={onEdit} style={itemStyle()}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-high)' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
          Edit
        </button>
        {mergeSpan ? (
          <button type="button" role="menuitem" disabled={busy || mergeSpan.disabled} onClick={mergeSpan.onClick} style={itemStyle()}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-high)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
            Merge {mergeSpan.count} blocks
          </button>
        ) : (
          <>
            {mergeAbove && (
              <button type="button" role="menuitem" disabled={busy || mergeAbove.disabled} onClick={mergeAbove.onClick} style={itemStyle()}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-high)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
                Merge with above
              </button>
            )}
            {mergeBelow && (
              <button type="button" role="menuitem" disabled={busy || mergeBelow.disabled} onClick={mergeBelow.onClick} style={itemStyle()}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-high)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
                Merge with below
              </button>
            )}
          </>
        )}
        {onSplit && (
          <button type="button" role="menuitem" disabled={busy} onClick={onSplit} style={itemStyle()}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-high)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
            Split block…
          </button>
        )}
        <button type="button" role="menuitem" disabled={busy} onClick={onRegenerate} style={itemStyle()}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-high)' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
          {busy ? 'Regenerating…' : 'Regenerate summary'}
        </button>
        <button type="button" role="menuitem" disabled={busy} onClick={onDelete} style={itemStyle(true)}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-high)' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
          Remove from day
        </button>
      </div>
    </div>
  )
}

// ─── The block editor modal ──────────────────────────────────────────────────
// Right-click → Edit opens this separate centered popup, Google Calendar's
// event editor shape: title, time range, type/color with the suggested color
// and a one-sentence reason, the tracked records with a permanent-remove per
// row, and Delete block (full erasure of the block and its tracked data).
// Save applies every change and closes; Discard closes with nothing applied.
// The read-only detail panel never hosts any of this.

function BlockEditModal({
  block,
  payload,
  onClose,
  onDeleted,
  onRefresh,
  onCorrection,
}: {
  block: WorkContextBlock
  payload: DayTimelinePayload
  onClose: () => void
  // Called after the block is permanently purged, so the parent can drop the
  // (now dangling) selection before the refreshed day lands.
  onDeleted: () => void
  onRefresh: () => Promise<void>
  // Runs a correction command through the shared preview → apply → undo flow
  // (DEV-172). Resolves true once applied, false if the preview was cancelled.
  onCorrection: (command: CorrectionCommand) => Promise<boolean>
}) {
  const [titleDraft, setTitleDraft] = useState(() => userVisibleBlockLabel(block))
  const [categoryDraft, setCategoryDraft] = useState<AppCategory>(block.dominantCategory)
  const [startDraft, setStartDraft] = useState(() => toTimeInputValue(block.startTime))
  const [endDraft, setEndDraft] = useState(() => toTimeInputValue(block.endTime))
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [purgingKey, setPurgingKey] = useState<string | null>(null)
  const [hidingKey, setHidingKey] = useState<string | null>(null)
  const [assigningClient, setAssigningClient] = useState(false)
  const [clients, setClients] = useState<ClientRecord[]>([])
  const [projects, setProjects] = useState<AttributionProject[]>([])
  const [error, setError] = useState<string | null>(null)
  const busy = saving || deleting || purgingKey !== null || hidingKey !== null || assigningClient

  // Clients and projects for the attribution select — loaded once; an empty
  // client list simply hides the control (nothing to assign to yet).
  useEffect(() => {
    let cancelled = false
    Promise.all([
      ipc.attribution.listClientsDetailed(),
      ipc.attribution.listProjects().catch(() => [] as AttributionProject[]),
    ])
      .then(([clientList, projectList]) => {
        if (cancelled) return
        setClients(clientList.filter((client) => client.status === 'active'))
        setProjects(projectList)
      })
      .catch(() => { /* the select just stays hidden */ })
    return () => { cancelled = true }
  }, [])

  // Escape = Discard, like closing GCal's editor without saving.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  // The suggested type: what the evidence says this block mostly was — shown
  // as its color plus one plain sentence saying why that color was chosen.
  const suggestion = useMemo(() => {
    const split = Object.entries(block.categoryDistribution ?? {})
      .filter((entry): entry is [AppCategory, number] => typeof entry[1] === 'number' && entry[1] >= 60)
      .sort((a, b) => b[1] - a[1])
    const topCategory = split[0]?.[0]
    if (!topCategory || !BLOCK_CATEGORY_OPTIONS.some((option) => option.value === topCategory)) return null
    const topApp = block.topApps[0]
    const topSite = block.websites[0]
    const carrier = topApp && (!topSite || topApp.totalSeconds >= topSite.totalSeconds)
      ? formatDisplayAppName(topApp.appName)
      : topSite ? shortDomainLabel(topSite.domain) : null
    const label = BLOCK_CATEGORY_OPTIONS.find((option) => option.value === topCategory)?.label ?? activityCategoryLabel(topCategory)
    return {
      category: topCategory,
      color: activityColorForCategory(topCategory),
      reason: carrier
        ? `This is the ${label} color — most of this block's time was in ${carrier}.`
        : `This is the ${label} color — it covers the largest share of this block's time.`,
    }
  }, [block])

  // Delete the block AND its tracked data, permanently. This is the full
  // erasure path for sensitive stretches: the main process confirms with a
  // native dialog, then the underlying records — app sessions, site visits,
  // focus events — are deleted from Daylens entirely, not hidden.
  const deleteBlock = async () => {
    if (busy) return
    setDeleting(true)
    setError(null)
    try {
      const { purged } = await ipc.db.purgeTimelineBlock({ blockId: block.id, date: payload.date })
      if (purged) {
        track(ANALYTICS_EVENT.BLOCK_EDITED, { block_id: block.id, what_changed: 'deleted' })
        daySummaryRecapCache.delete(payload.date)
        onDeleted()
        await onRefresh()
        onClose()
        return
      }
    } catch (err) {
      setError(sanitizeIpcError(err, "Couldn't delete the block. Try again in a moment.").message)
    }
    setDeleting(false)
  }

  const save = async () => {
    if (busy) return
    setSaving(true)
    setError(null)
    try {
      const title = titleDraft.trim()
      const clampedStart = clampStartTimeDraft(startDraft, block.startTime)
      const clampedEnd = clampEndTimeDraft(endDraft, block.endTime)
      setStartDraft(clampedStart)
      setEndDraft(clampedEnd)
      const spanDraft = blockSpanDraftChanged(clampedStart, clampedEnd, block)
      const label = title && title !== block.label.current ? title : undefined
      const category = categoryDraft !== block.dominantCategory ? categoryDraft : undefined
      const startMs = spanDraft?.changed ? spanDraft.startMs : undefined
      const endMs = spanDraft?.changed ? spanDraft.endMs : undefined
      if (label === undefined && category === undefined && startMs === undefined && endMs === undefined) {
        onClose()
        return
      }
      // The shared preview → apply flow: the dialog opens over this modal,
      // and the modal only closes once the correction actually applied.
      const applied = await onCorrection({ kind: 'edit', date: payload.date, blockId: block.id, label, category, startMs, endMs })
      if (!applied) {
        setSaving(false)
        return
      }
      // One event per save; when several fields changed, report the most
      // structural one (time > category > label).
      const whatChanged = startMs !== undefined || endMs !== undefined
        ? 'time'
        : category !== undefined ? 'category' : 'label'
      track(ANALYTICS_EVENT.BLOCK_EDITED, { block_id: block.id, what_changed: whatChanged })
      onClose()
    } catch (err) {
      setError(sanitizeIpcError(err, "Couldn't save the changes. Try again in a moment.").message)
      setSaving(false)
    }
  }

  // Assign the block's time to a client and optional project (or clear). Runs
  // through the same preview flow; the modal closes once applied because the
  // day's attribution facts re-form underneath it.
  const assignClient = async (clientId: string | null, projectId: string | null = null) => {
    if (busy) return
    setAssigningClient(true)
    setError(null)
    try {
      const applied = await onCorrection({
        kind: 'assign-client',
        date: payload.date,
        blockId: block.id,
        clientId,
        projectId: clientId == null ? null : projectId,
      })
      if (applied) {
        track(ANALYTICS_EVENT.BLOCK_EDITED, { block_id: block.id, what_changed: 'client' })
        onClose()
        return
      }
    } catch (err) {
      setError(sanitizeIpcError(err, "Couldn't assign the client. Try again in a moment.").message)
    }
    setAssigningClient(false)
  }

  // Hide a tracked record from the corrected facts without destroying it —
  // the undoable counterpart to purgeRow's permanent erase.
  const hideRow = async (row: { key: string; kind: 'app' | 'site'; bundleId?: string; appName?: string; domain?: string }) => {
    if (busy) return
    setHidingKey(row.key)
    setError(null)
    try {
      const applied = await onCorrection({
        kind: 'exclude-evidence',
        date: payload.date,
        blockId: block.id,
        evidence: { kind: row.kind, bundleId: row.bundleId ?? null, appName: row.appName ?? null, domain: row.domain ?? null },
      })
      if (applied) {
        onClose()
        return
      }
    } catch (err) {
      setError(sanitizeIpcError(err, "Couldn't hide the record. Try again in a moment.").message)
    }
    setHidingKey(null)
  }

  // Permanently remove a sensitive tracked record. The main process shows the
  // native "are you sure" dialog; on confirm the underlying rows are deleted
  // everywhere — not hidden — and the day re-forms from what remains.
  const purgeRow = async (row: { key: string; kind: 'app' | 'site'; bundleId?: string; appName?: string; domain?: string }) => {
    if (busy) return
    setPurgingKey(row.key)
    setError(null)
    try {
      const { purged } = await ipc.db.purgeTrackedEvidence({
        kind: row.kind,
        bundleId: row.bundleId,
        appName: row.appName,
        domain: row.domain,
        fromMs: block.startTime,
        toMs: block.endTime,
      })
      if (purged) {
        daySummaryRecapCache.delete(payload.date)
        await onRefresh()
        onClose()
      }
    } catch (err) {
      setError(sanitizeIpcError(err, "Couldn't remove the record. Try again in a moment.").message)
    } finally {
      setPurgingKey(null)
    }
  }

  // Sites are breakdowns of their browser's time — the browser owns the slot,
  // the sites say where inside it the minutes went. They render nested under
  // the owning app so the list never reads as additive parallel entries
  // (Dia 1h 27m *plus* x.com 24m would double-count the same clock time).
  type TrackedRow = {
    key: string
    kind: 'app' | 'site'
    bundleId?: string
    appName?: string
    domain?: string
    name: string
    detail: string | null
    seconds: number
    icon: ReactNode
    withinApp?: boolean
  }
  const appRows: TrackedRow[] = block.topApps.slice(0, 10).map((app) => ({
    key: `app:${app.bundleId}`,
    kind: 'app' as const,
    bundleId: app.bundleId,
    appName: app.appName,
    name: formatDisplayAppName(app.appName),
    detail: activityCategoryLabel(app.category),
    seconds: app.totalSeconds,
    icon: <AppIcon bundleId={app.bundleId} appName={app.appName} size={24} fontSize={10} color={activityColorForCategory(app.category)} />,
  }))
  const siteRowFor = (site: WorkContextBlock['websites'][number], withinApp: boolean): TrackedRow => ({
    key: `site:${site.domain}`,
    kind: 'site' as const,
    domain: site.domain,
    name: shortDomainLabel(site.domain),
    detail: site.topTitle?.trim() || null,
    seconds: site.totalSeconds,
    icon: <EntityIcon artifactType="page" domain={site.domain} title={site.domain} size={withinApp ? 20 : 24} />,
    withinApp,
  })
  const sitesByOwner = new Map<string, TrackedRow[]>()
  const orphanSites: TrackedRow[] = []
  for (const site of block.websites.slice(0, 10)) {
    const owner = block.topApps.find((app) =>
      app.bundleId === site.browserBundleId
      || (site.canonicalBrowserId != null && app.canonicalAppId === site.canonicalBrowserId))
    if (owner) {
      const list = sitesByOwner.get(`app:${owner.bundleId}`) ?? []
      list.push(siteRowFor(site, true))
      sitesByOwner.set(`app:${owner.bundleId}`, list)
    } else {
      orphanSites.push(siteRowFor(site, false))
    }
  }
  const trackedRows: TrackedRow[] = [...appRows, ...orphanSites]
    .sort((a, b) => b.seconds - a.seconds)
    .flatMap((row) => [row, ...(sitesByOwner.get(row.key) ?? []).sort((a, b) => b.seconds - a.seconds)])

  const inputBase: CSSProperties = {
    borderRadius: 9,
    border: '1px solid var(--color-border-ghost)',
    background: 'var(--color-surface-low)',
    color: 'var(--color-text-primary)',
    fontSize: 13,
    outline: 'none',
  }

  return (
    <div
      // Inspector-marked so the day grid's capture-phase click handler never
      // treats modal clicks (backdrop included) as select/deselect intent.
      data-timeline-inspector="true"
      style={{ position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={() => { if (!busy) onClose() }}
    >
      <div
        role="dialog"
        aria-label="Edit block"
        style={{
          width: 560,
          maxWidth: '100%',
          maxHeight: '84vh',
          overflowY: 'auto',
          borderRadius: 18,
          border: '1px solid var(--color-border-ghost)',
          background: 'var(--color-surface)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.35)',
          padding: '16px 24px 20px',
        }}
        onClick={(event) => event.stopPropagation()}
      >
        {/* Title row, GCal editor style: close on the left, the title as a big
            underlined field. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <button
            type="button"
            aria-label="Discard changes"
            title="Discard"
            onClick={() => { if (!busy) onClose() }}
            style={{ width: 32, height: 32, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', border: 'none', background: 'transparent', color: 'var(--color-text-secondary)', cursor: 'pointer', flexShrink: 0 }}
          >
            <X size={17} strokeWidth={2} aria-hidden="true" />
          </button>
          <input
            type="text"
            aria-label="Block title"
            value={titleDraft}
            autoFocus
            onChange={(event) => setTitleDraft(event.target.value)}
            placeholder="Block title"
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 19,
              fontWeight: 650,
              border: 'none',
              borderBottom: '1.5px solid var(--color-border-ghost)',
              background: 'transparent',
              color: 'var(--color-text-primary)',
              padding: '4px 2px 7px',
              outline: 'none',
            }}
          />
        </div>

        <div style={{ display: 'grid', gap: 16, paddingLeft: 44 }}>
          {/* Time range. Trim-only: a block is tracked activity, so its edges
              move inward — Daylens never turns idle time into work. */}
          <div>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, color: 'var(--color-text-primary)', fontWeight: 600 }}>{formatFullDate(payload.date)}</span>
              <input
                type="time"
                aria-label="Start time"
                value={startDraft}
                disabled={block.provisional}
                onChange={(event) => setStartDraft(draftTimeInputChange(event.target.value))}
                onBlur={() => setStartDraft((draft) => clampStartTimeDraft(draft, block.startTime))}
                style={{ ...inputBase, padding: '5px 8px', opacity: block.provisional ? 0.5 : 1 }}
              />
              <span style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>to</span>
              <input
                type="time"
                aria-label="End time"
                value={endDraft}
                disabled={block.provisional}
                onChange={(event) => setEndDraft(draftTimeInputChange(event.target.value))}
                onBlur={() => setEndDraft((draft) => clampEndTimeDraft(draft, block.endTime))}
                style={{ ...inputBase, padding: '5px 8px', opacity: block.provisional ? 0.5 : 1 }}
              />
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 6, lineHeight: 1.5 }}>
              {block.provisional
                ? 'Time edits unlock after Analyze day — this block is still settling.'
                : 'Edges move inward only — the trimmed-off stretch becomes its own block. Daylens never counts idle time as activity.'}
            </div>
          </div>

          {/* Type + color, with the evidence-based suggestion and its reason. */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <select
                aria-label="Block type"
                value={categoryDraft}
                onChange={(event) => setCategoryDraft(event.target.value as AppCategory)}
                style={{ ...inputBase, height: 32, padding: '0 8px', cursor: 'pointer' }}
              >
                {!BLOCK_CATEGORY_OPTIONS.some((option) => option.value === categoryDraft) && (
                  <option value={categoryDraft}>{activityCategoryLabel(categoryDraft)}</option>
                )}
                {BLOCK_CATEGORY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <span aria-hidden="true" style={{ width: 14, height: 14, borderRadius: 4, background: activityColorForCategory(categoryDraft), flexShrink: 0 }} />
            </div>
            {/* The suggested color and, in one plain sentence, why. Always
                visible — the user should never wonder where a color came from. */}
            {suggestion && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 8, fontSize: 12, color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
                <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 3, background: suggestion.color, flexShrink: 0 }} />
                <span>{suggestion.reason}</span>
                {suggestion.category !== categoryDraft && (
                  <button
                    type="button"
                    onClick={() => setCategoryDraft(suggestion.category)}
                    style={{ border: 'none', background: 'transparent', color: 'var(--color-primary)', fontSize: 12, fontWeight: 650, cursor: 'pointer', padding: 0 }}
                  >
                    Use
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Attribution: assign this block's time to a client, or a project
              under that client. Shown only when clients exist; runs through
              the preview flow like every other correction. */}
          {clients.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <select
                aria-label="Assign to client or project"
                value=""
                disabled={busy}
                onChange={(event) => {
                  const value = event.target.value
                  if (!value) return
                  if (value === '__none__') {
                    void assignClient(null, null)
                    return
                  }
                  if (value.startsWith('project:')) {
                    const projectId = value.slice('project:'.length)
                    const project = projects.find((row) => row.id === projectId)
                    if (!project) return
                    void assignClient(project.client_id, project.id)
                    return
                  }
                  void assignClient(value, null)
                }}
                style={{ ...inputBase, height: 32, padding: '0 8px', cursor: busy ? 'default' : 'pointer' }}
              >
                <option value="">{assigningClient ? 'Assigning…' : 'Assign to client or project…'}</option>
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>{client.name}</option>
                ))}
                {projects.length > 0 && (
                  <optgroup label="Projects">
                    {projects.map((project) => (
                      <option key={project.id} value={`project:${project.id}`}>
                        {project.client_name} · {project.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                <option value="__none__">No client (clear assignment)</option>
              </select>
            </div>
          )}

          {/* Tracked records, each permanently removable — real deletion of
              the underlying data, for anything the user doesn't want Daylens
              to hold (native confirm before anything is touched). */}
          {trackedRows.length > 0 && (
            <div>
              <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', color: 'var(--color-text-tertiary)', marginBottom: 10, textTransform: 'uppercase' }}>
                Tracked in this block
              </div>
              <div style={{ display: 'grid', gap: 12 }}>
                {trackedRows.map((row) => (
                  <div key={row.key} style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, paddingLeft: row.withinApp ? 34 : 0 }}>
                    {row.icon}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: row.withinApp ? 12.5 : 13, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</div>
                      {row.detail && (
                        <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>{row.detail}</div>
                      )}
                    </div>
                    <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{formatDuration(row.seconds)}</span>
                    <button
                      type="button"
                      aria-label={`Hide ${row.name} from this block`}
                      title="Hide from timeline (undoable — the record itself is kept)"
                      disabled={busy}
                      onClick={() => { void hideRow(row) }}
                      style={{ width: 26, height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7, border: 'none', background: 'transparent', color: 'var(--color-text-secondary)', cursor: busy ? 'default' : 'pointer', opacity: hidingKey && hidingKey !== row.key ? 0.4 : 1, flexShrink: 0 }}
                    >
                      <EyeOff size={14} strokeWidth={2} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Permanently remove ${row.name} from Daylens`}
                      title="Remove permanently"
                      disabled={purgingKey !== null}
                      onClick={() => { void purgeRow(row) }}
                      style={{ width: 26, height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7, border: 'none', background: 'transparent', color: purgingKey === row.key ? 'var(--color-text-tertiary)' : '#f87171', cursor: purgingKey ? 'default' : 'pointer', opacity: purgingKey && purgingKey !== row.key ? 0.4 : 1, flexShrink: 0 }}
                    >
                      <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 8, lineHeight: 1.5 }}>
                Hide keeps the record but drops it from timeline, apps, and AI (undoable). Remove deletes it from Daylens entirely.
              </div>
            </div>
          )}

          {error && (
            <div style={{ fontSize: 11.5, lineHeight: 1.5, color: '#f87171' }}>{error}</div>
          )}
        </div>

        {/* Delete erases the block and its tracked data entirely (native
            confirm first); Save applies and closes; Discard closes with no
            changes. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 20 }}>
          <button
            type="button"
            disabled={busy}
            onClick={() => { void deleteBlock() }}
            title="Permanently delete this block and everything tracked inside it"
            style={{ border: '1px solid rgba(248, 113, 113, 0.4)', background: 'transparent', color: '#f87171', fontSize: 12.5, fontWeight: 650, cursor: busy ? 'default' : 'pointer', padding: '7px 14px', borderRadius: 9, opacity: busy && !deleting ? 0.5 : 1, marginRight: 'auto' }}
          >
            {deleting ? 'Deleting…' : 'Delete block'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            style={{ border: '1px solid var(--color-border-ghost)', background: 'transparent', color: 'var(--color-text-secondary)', fontSize: 12.5, fontWeight: 650, cursor: busy ? 'default' : 'pointer', padding: '7px 14px', borderRadius: 9 }}
          >
            Discard
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => { void save() }}
            style={{ border: 'none', background: 'var(--gradient-primary)', color: 'var(--color-primary-contrast)', fontSize: 12.5, fontWeight: 700, cursor: busy ? 'default' : 'pointer', padding: '7px 16px', borderRadius: 9, opacity: saving ? 0.6 : 1 }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Split dialog ────────────────────────────────────────────────────────────
// Right-click → Split block…: pick the cut time (defaults to the midpoint),
// then the shared preview flow shows exactly what the two halves will be
// before anything applies. The service enforces a one-minute minimum on each
// side of the cut.

function SplitBlockDialog({
  block,
  onClose,
  onSubmit,
}: {
  block: WorkContextBlock
  onClose: () => void
  // Runs the split through the preview flow; resolves true once applied.
  onSubmit: (cutMs: number) => Promise<boolean>
}) {
  const midpointMs = block.startTime + Math.floor((block.endTime - block.startTime) / 2)
  const [draft, setDraft] = useState(() => toTimeInputValue(midpointMs))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const submit = async () => {
    if (busy) return
    const cutMs = fromTimeInputValue(draft, block.startTime)
    if (cutMs == null || cutMs <= block.startTime || cutMs >= block.endTime) {
      setError('Pick a time inside the block.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const applied = await onSubmit(cutMs)
      if (!applied) setBusy(false)
    } catch (err) {
      setError(sanitizeIpcError(err, "Couldn't preview the split. Try again in a moment.").message)
      setBusy(false)
    }
  }

  const rangeHint = `${new Date(block.startTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} – ${new Date(block.endTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`

  return (
    <div
      data-timeline-inspector="true"
      style={{ position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={() => { if (!busy) onClose() }}
    >
      <div
        role="dialog"
        aria-label="Split block"
        style={{
          width: 380,
          maxWidth: '100%',
          borderRadius: 16,
          border: '1px solid var(--color-border-ghost)',
          background: 'var(--color-surface)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.35)',
          padding: '18px 22px',
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)', lineHeight: 1.4 }}>
          Split “{userVisibleBlockLabel(block)}”
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 4 }}>
          {rangeHint} · each half needs at least a minute
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
          <span style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', fontWeight: 600 }}>Split at</span>
          <input
            type="time"
            aria-label="Split time"
            value={draft}
            autoFocus
            disabled={busy}
            onChange={(event) => setDraft(draftTimeInputChange(event.target.value))}
            onKeyDown={(event) => { if (event.key === 'Enter') void submit() }}
            style={{ borderRadius: 9, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface-low)', color: 'var(--color-text-primary)', fontSize: 13, outline: 'none', padding: '5px 8px' }}
          />
        </div>
        {error && (
          <div style={{ fontSize: 11.5, lineHeight: 1.5, color: '#f87171', marginTop: 10 }}>{error}</div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            style={{ border: '1px solid var(--color-border-ghost)', background: 'transparent', color: 'var(--color-text-secondary)', fontSize: 12.5, fontWeight: 650, cursor: busy ? 'default' : 'pointer', padding: '7px 14px', borderRadius: 9 }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => { void submit() }}
            style={{ border: 'none', background: 'var(--gradient-primary)', color: 'var(--color-primary-contrast)', fontSize: 12.5, fontWeight: 700, cursor: busy ? 'default' : 'pointer', padding: '7px 16px', borderRadius: 9, opacity: busy ? 0.6 : 1 }}
          >
            {busy ? 'Previewing…' : 'Preview split'}
          </button>
        </div>
      </div>
    </div>
  )
}

const daySummaryRecapCache = new Map<string, AIDaySummaryResult>()

// Report what Analyze / Re-analyze actually did (DEV-231) rather than a fixed
// success line — the real re-labeled and merged counts, or "already up to date"
// when the run touched nothing.
// A truthful line for each phase the analyze pipeline is actually in (DEV-270),
// so the button says what the system is doing instead of a blank "Analyzing…".
function analyzeProgressMessage(progress: TimelineAnalyzeProgress): string {
  switch (progress.stage) {
    case 'preparing': return 'Reading the day…'
    case 'merging': return 'Joining continued work…'
    case 'naming': return progress.total > 0 ? `Naming your work… ${progress.done}/${progress.total}` : 'Naming your work…'
    case 'finishing': return 'Finishing up…'
    default: return 'Analyzing…'
  }
}

function analyzeOutcomeMessage(result: RebuildTimelineDayResult, provisional: boolean): string {
  const plural = (n: number) => (n === 1 ? '' : 's')
  if (provisional) {
    const count = result.payload.blocks.filter((block) => !block.isLive).length
    return count > 0 ? `Shaped the day into ${count} block${plural(count)}` : 'Day shaped into blocks'
  }
  if (!result.changed) return 'All labels already up to date'
  const parts: string[] = []
  if (result.relabeled > 0) parts.push(`Re-labeled ${result.relabeled} block${plural(result.relabeled)}`)
  if (result.mergedCount > 0) parts.push(`merged ${result.mergedCount} block${plural(result.mergedCount)}`)
  let message = parts.length > 0 ? parts.join(' · ') : 'Refreshed the day'
  if (result.failed > 0) {
    // Never a bare failure count (DEV-278): say why and how to finish the job.
    const rawReason = result.failureReason?.trim()
    const reason = rawReason ? (/[.!?…]$/.test(rawReason) ? rawReason : `${rawReason}.`) : null
    message += reason
      ? ` · ${result.failed} couldn’t be named — ${reason} Re-analyze retries them.`
      : ` · ${result.failed} couldn’t be named — Re-analyze retries them.`
  }
  return message
}

// The analyze run-state, lifted OUT of DaySummaryInspector so it survives the
// panel swapping to a block's detail mid-run (DEV-270: the outcome/progress no
// longer vanishes when you click a block while Analyze is working). Owned by the
// Timeline component; the inspector and the block-detail status pill both read it.
export interface DayAnalysisController {
  analyzing: boolean
  status: string | null
  progress: TimelineAnalyzeProgress | null
  run: (hint?: string) => Promise<RebuildTimelineDayResult | null>
}

function useDayAnalysis(dateStr: string, provisional: boolean, onRefresh?: () => Promise<void>): DayAnalysisController {
  const [analyzing, setAnalyzing] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [progress, setProgress] = useState<TimelineAnalyzeProgress | null>(null)
  // The outcome line belongs to the day it described; clear it when the day changes.
  useEffect(() => { setStatus(null); setProgress(null) }, [dateStr])
  const run = useCallback(async (hint?: string): Promise<RebuildTimelineDayResult | null> => {
    if (analyzing) return null
    track(ANALYTICS_EVENT.ANALYZE_DAY_CLICKED, { date: dateStr })
    setAnalyzing(true)
    setStatus(null)
    setProgress(null)
    const unsubscribe = ipc.db.onAnalyzeProgress((update) => setProgress(update))
    try {
      const result = await ipc.db.rebuildTimelineDay(dateStr, hint)
      daySummaryRecapCache.delete(dateStr)
      await onRefresh?.()
      setStatus(analyzeOutcomeMessage(result, provisional))
      return result
    } catch (error) {
      const { message } = sanitizeIpcError(error, 'Analysis failed. Try again in a moment.')
      setStatus(message)
      return null
    } finally {
      unsubscribe()
      setAnalyzing(false)
      setProgress(null)
    }
  }, [analyzing, dateStr, provisional, onRefresh])
  return { analyzing, status, progress, run }
}

// One answer-or-skip question the day-analysis agent has for the person — the
// same pattern Cursor / Claude Code / Codex use. Answering writes a durable
// correction; Skip dismisses it for good. Never blocks the recap.
function ClarificationCard({ clarification, onResolve }: {
  clarification: TimelineClarification
  onResolve: (answer: TimelineClarificationAnswer) => void
}) {
  const [customText, setCustomText] = useState('')
  const isMeeting = clarification.kind === 'unconfirmed-meeting'

  const chooseOption = (option: { id: string; label: string }) => {
    if (isMeeting) {
      onResolve({ id: clarification.id, kind: 'unconfirmed-meeting', action: 'answer', eventKey: clarification.eventKey, attendance: option.id as TimelineClarificationAnswer['attendance'] })
    } else {
      onResolve({ id: clarification.id, kind: 'unnamed-block', action: 'answer', blockId: clarification.blockId, label: option.label })
    }
  }
  const submitCustom = () => {
    const label = customText.trim()
    if (!label) return
    onResolve({ id: clarification.id, kind: 'unnamed-block', action: 'answer', blockId: clarification.blockId, label })
  }

  return (
    <div style={{ display: 'grid', gap: 8, padding: 12, borderRadius: 12, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)' }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', lineHeight: 1.5 }}>{clarification.question}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {clarification.options.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => chooseOption(option)}
            style={{ border: '1px solid var(--color-border-ghost)', background: 'transparent', color: 'var(--color-text-secondary)', borderRadius: 8, padding: '5px 10px', fontSize: 12.5, cursor: 'pointer' }}
          >
            {option.label}
          </button>
        ))}
      </div>
      {!isMeeting && (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={customText}
            onChange={(event) => setCustomText(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') submitCustom() }}
            placeholder="Or describe it in your own words…"
            style={{ flex: 1, minWidth: 0, border: '1px solid var(--color-border-ghost)', background: 'transparent', color: 'var(--color-text-primary)', borderRadius: 8, padding: '5px 8px', fontSize: 12.5 }}
          />
          <button type="button" onClick={submitCustom} disabled={!customText.trim()} style={{ border: 'none', background: 'var(--gradient-primary)', color: 'var(--color-primary-contrast)', borderRadius: 8, padding: '5px 10px', fontSize: 12.5, fontWeight: 600, cursor: customText.trim() ? 'pointer' : 'default', opacity: customText.trim() ? 1 : 0.5 }}>Save</button>
        </div>
      )}
      <button
        type="button"
        onClick={() => onResolve({ id: clarification.id, kind: clarification.kind, action: 'skip' })}
        style={{ justifySelf: 'start', border: 'none', background: 'transparent', color: 'var(--color-text-tertiary)', fontSize: 11.5, cursor: 'pointer', padding: 0 }}
      >
        Skip
      </button>
    </div>
  )
}

function DaySummaryInspector({ payload, analysis }: { payload: DayTimelinePayload; analysis: DayAnalysisController; onSelectBlock?: (blockId: string) => void }) {
  const [recap, setRecap] = useState<AIDaySummaryResult | null>(null)
  const [recapLoading, setRecapLoading] = useState(false)
  const [recapError, setRecapError] = useState<string | null>(null)
  // Seeded from the payload the day arrived with; refetched only when an
  // answer or an invalidation changes what the day is asking.
  const [clarifications, setClarifications] = useState<TimelineClarification[]>(
    () => payload.clarifications ?? [],
  )
  const { analyzing, status: analyzeStatus, progress: analyzeProgress, run: runAnalyze } = analysis
  // The optional-note step of Analyze day: a one-line hint grounds the AI.
  const [wrapOpen, setWrapOpen] = useState(false)
  const [wrapNote, setWrapNote] = useState('')

  const provisional = payload.blocks.some((block) => block.provisional)
  // Daylens makes no claim about the day until it has enough to work with.
  const enoughToAnalyze = trackedSecondsFor(payload) >= ANALYZE_MIN_SECONDS

  const loadClarifications = useCallback(() => {
    void ipc.db.getDayClarifications(payload.date).then(setClarifications).catch(() => setClarifications([]))
  }, [payload.date])

  // A payload that carries its own questions needs no second round trip. One
  // that does not — an older main process, or a caller that did not ask —
  // falls back to fetching them, so the day is never left without them.
  const carriedClarifications = payload.clarifications
  useEffect(() => {
    if (carriedClarifications) setClarifications(carriedClarifications)
    else loadClarifications()
  }, [carriedClarifications, loadClarifications])

  useEffect(() => {
    setRecapError(null)
    setWrapOpen(false)
    setWrapNote('')
    const cached = daySummaryRecapCache.get(payload.date)
    setRecap(cached ?? null)
    setRecapLoading(false)
  }, [payload.date])

  useEffect(() => ipc.projections.onInvalidated((event) => {
    if (event.scope !== 'timeline' && event.scope !== 'all') return
    if (event.date && event.date !== payload.date) return
    daySummaryRecapCache.delete(payload.date)
    setRecap(null)
    loadClarifications()
  }), [payload.date, loadClarifications])

  // Answer or skip one question. An answer writes a durable correction in the
  // main process (which invalidates the day, refreshing the timeline and recap);
  // either way the card leaves the list immediately.
  const resolveClarification = (answer: TimelineClarificationAnswer) => {
    setClarifications((current) => current.filter((item) => item.id !== answer.id))
    void ipc.db.resolveDayClarification(payload.date, answer).catch(() => loadClarifications())
  }

  // Analyze Day (today) / Re-analyze (a past day): finalize the provisional day
  // into named blocks and refresh deterministic-floor / low-confidence labels.
  // The run itself (ipc call, progress subscription, outcome) lives in the
  // lifted controller so it survives selecting a block mid-run (DEV-270); this
  // only clears the optional-note step on success.
  const handleAnalyze = async (hint?: string) => {
    const result = await runAnalyze(hint)
    if (result) {
      setWrapOpen(false)
      setWrapNote('')
    }
  }

  // Generate Recap: a short, grounded AI summary of the day built from the same
  // blocks. Cached per date so re-opening the day doesn't re-spend the call.
  const handleGenerateRecap = async () => {
    if (recapLoading) return
    setRecapLoading(true)
    setRecapError(null)
    try {
      const result = await ipc.ai.generateDaySummary(payload.date)
      daySummaryRecapCache.set(payload.date, result)
      setRecap(result)
    } catch (error) {
      const { message } = sanitizeIpcError(error, "Couldn't generate the recap. Try again in a moment.")
      setRecapError(message)
    } finally {
      setRecapLoading(false)
    }
  }

  return (
    <div style={{
      position: 'sticky',
      top: 24,
      maxHeight: 'calc(100vh - 140px)',
      overflowY: 'auto',
      scrollbarWidth: 'none',
      msOverflowStyle: 'none',
      overscrollBehavior: 'contain',
      borderRadius: 18,
      border: '1px solid var(--color-border-ghost)',
      background: 'var(--color-surface)',
      padding: 22,
      display: 'grid',
      gap: 16,
    }} className="timeline-summary-inspector">
      {/* No date heading here — the nav pill above the grid already names the
          day: the panel goes straight to the recap, Analyze day, and stats. */}
      {payload.totalSeconds === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)', lineHeight: 1.6 }}>
          Nothing tracked yet.
        </div>
      ) : (
        <>
          {/* The day recap — calm, grounded prose once generated. */}
          {recap?.summary && (
            <div style={{ display: 'grid', gap: 6 }}>
              {/* Nothing fails silently: when the AI recap couldn't run, the
                  factual fallback says so plainly rather than posing as prose. */}
              {recap.degraded && (
                <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
                  {recap.degradedReason
                    ? `The full recap couldn't be generated — ${recap.degradedReason} Showing the day's facts; ${recap.degradedNeedsAction ? 'generate again once that is sorted.' : 'Generate recap retries.'}`
                    : "The full recap couldn't be generated. Showing the day's facts; Generate recap retries."}
                </div>
              )}
              <div style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--color-text-primary)' }}>
                {recap.summary}
              </div>
            </div>
          )}

          {recapError && (
            <div style={{ fontSize: 11.5, lineHeight: 1.5, color: '#f87171' }}>{recapError}</div>
          )}

          {/* The agent's answer-or-skip questions — only when it genuinely has
              a material one. Answering refines the day; skipping dismisses it. */}
          {clarifications.length > 0 && (
            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
                A couple of quick checks to get today right — answer or skip.
              </div>
              {clarifications.map((clarification) => (
                <ClarificationCard key={clarification.id} clarification={clarification} onResolve={resolveClarification} />
              ))}
            </div>
          )}

          {(
            // The divider only draws when prose sits above it — as the panel's
            // first element it would read as a stray line under the padding.
            <div style={{ borderTop: (recap?.summary || recapError) ? '1px solid var(--color-border-ghost)' : 'none', paddingTop: (recap?.summary || recapError) ? 14 : 0, display: 'grid', gap: 8, justifyItems: 'start', width: '100%' }}>
              {analyzing ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 650, color: 'var(--color-text-primary)' }}>
                  <span style={{ width: 13, height: 13, borderRadius: '50%', border: '2px solid var(--color-border-ghost)', borderTopColor: 'var(--color-text-secondary)', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />
                  {analyzeProgress ? analyzeProgressMessage(analyzeProgress) : 'Analyzing day…'}
                </div>
              ) : provisional ? (
                // TODAY, unanalyzed: Analyze day shapes the provisional day into
                // named blocks. Gated until there's at least 2 hours to work with.
                !wrapOpen ? (
                  <>
                    <button
                      type="button"
                      disabled={!enoughToAnalyze}
                      onClick={() => setWrapOpen(true)}
                      style={{ justifySelf: 'start', border: 'none', background: 'var(--gradient-primary)', color: 'var(--color-primary-contrast)', borderRadius: 10, padding: '8px 14px', fontSize: 13, fontWeight: 700, cursor: enoughToAnalyze ? 'pointer' : 'default', opacity: enoughToAnalyze ? 1 : 0.5 }}
                    >
                      Analyze day
                    </button>
                    {!enoughToAnalyze && (
                      <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', lineHeight: 1.4 }}>
                        Available after ~2 hours of tracked time.
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ display: 'grid', gap: 8, width: '100%' }}>
                    <textarea
                      value={wrapNote}
                      onChange={(event) => setWrapNote(event.target.value)}
                      placeholder="Optional: in a line, what were you working on today?"
                      rows={2}
                      style={{ width: '100%', resize: 'vertical', borderRadius: 9, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', color: 'var(--color-text-primary)', padding: '8px 10px', fontSize: 12.5, outline: 'none', fontFamily: 'inherit', lineHeight: 1.5 }}
                    />
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => { void handleAnalyze(wrapNote) }}
                        style={{ border: 'none', background: 'var(--gradient-primary)', color: 'var(--color-primary-contrast)', borderRadius: 9, padding: '7px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}
                      >
                        Analyze
                      </button>
                      <button
                        type="button"
                        onClick={() => { setWrapOpen(false); setWrapNote('') }}
                        style={{ border: '1px solid var(--color-border-ghost)', background: 'transparent', color: 'var(--color-text-secondary)', borderRadius: 9, padding: '7px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )
              ) : (
                // A past / already-analyzed day: re-analyze + recap, side by side.
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => { void handleAnalyze() }}
                    disabled={analyzing}
                    style={{ border: '1px solid var(--color-border-ghost)', background: 'transparent', color: 'var(--color-text-secondary)', borderRadius: 10, padding: '7px 12px', fontSize: 12.5, fontWeight: 600, cursor: analyzing ? 'default' : 'pointer', opacity: analyzing ? 0.6 : 1, display: 'inline-flex', alignItems: 'center', gap: 7 }}
                  >
                    {analyzing && <span aria-hidden style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid var(--color-border-ghost)', borderTopColor: 'var(--color-text-secondary)', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />}
                    {analyzing ? (analyzeProgress ? analyzeProgressMessage(analyzeProgress) : 'Analyzing…') : 'Re-analyze with AI'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { void handleGenerateRecap() }}
                    disabled={recapLoading}
                    style={{ border: '1px solid var(--color-border-ghost)', background: 'transparent', color: 'var(--color-text-secondary)', borderRadius: 10, padding: '7px 12px', fontSize: 12.5, fontWeight: 600, cursor: recapLoading ? 'default' : 'pointer', opacity: recapLoading ? 0.6 : 1 }}
                  >
                    {recapLoading ? 'Generating…' : recap ? 'Regenerate recap' : 'Generate recap'}
                  </button>
                </div>
              )}
              {analyzeStatus && !analyzing && (
                <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', lineHeight: 1.4 }}>
                  {analyzeStatus}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// The block detail in the persistent right panel: clicking a block swaps the
// right column from the day recap to this READ-ONLY view — color chip +
// title, the date/time line, type tags, the summary, and the app/site
// evidence underneath — and clicking anywhere outside the block swaps it
// back: nothing ever floats over the timeline. Selection state lives in Timeline;
// this component just renders the selected block. No edit controls live
// here: editing happens exclusively through right-click → Edit, which opens
// the separate editor modal.
function BlockDetailInspector({
  block,
  payload,
  onClose,
  onCorrection,
  maxHeightPx = DETAIL_PANEL_MAX_HEIGHT_DEFAULT,
  sticky = true,
}: {
  block: WorkContextBlock
  payload: DayTimelinePayload
  onClose: () => void
  // DEV-189: lets the matched-meeting card offer "I didn't attend" / "Not
  // this meeting" — the mark-meeting correction through the same pipeline.
  onCorrection?: (command: CorrectionCommand) => Promise<boolean>
  // The fixed cap on the whole panel. Content never grows the panel past this;
  // the evidence body scrolls inside instead.
  maxHeightPx?: number
  // Pinned to the scrolling day (the shipping layout) vs. sitting statically in
  // the dev variant overlay, which does its own centering.
  sticky?: boolean
}) {
  const accent = activityColorForCategory(block.dominantCategory)

  // One evidence view (timeline.md §2/§3.0): the apps, sites, and files behind
  // the block, in a single list sorted by time — the old "Apps used" and "Key
  // artifacts" merged into one. Work-first ordering falls out of sorting by
  // seconds. Off-task evidence is split out below as side trips (§6). The
  // nesting itself (which rows are children of which app) is pure logic,
  // extracted to blockDetailRowTree.ts so it's unit-testable without a DOM.
  const { evidence, detours, detourSeconds, briefCount, briefSeconds } = buildDetailRowTree(block)

  // DEV-189: the calendar event this block's captured meeting-app evidence
  // supports, when one matched. The block's own time stays observed activity;
  // the scheduled range is shown as context (timeline.md §Meetings).
  const matchedMeeting = payload.scheduledMeetings?.find(
    (meeting) => meeting.attendance === 'matched' && meeting.matchedBlockId === block.id,
  ) ?? null

  // The block's type tag + how the time inside splits by category. Real facts,
  // compactly: "Focused work" · Development 2h 10m · AI tools 40m.
  const typeTag = blockTypeTag(block)
  // The category appears once (DEV-272). A duration chip that merely restates
  // the type tag ("Browsing" under a "Browsing" tag) is dropped; only a genuine
  // split across two-plus categories earns its own chips.
  const categoryEntries = Object.entries(block.categoryDistribution ?? {})
    .filter((entry): entry is [AppCategory, number] => typeof entry[1] === 'number' && entry[1] >= 60)
    .sort((a, b) => b[1] - a[1])
  const categorySplitAll: Array<[string, number]> = categoryEntries
    .slice(0, 3)
    .map(([category, seconds]) => [activityCategoryLabel(category), seconds])
  // The chips must reconcile with the block (DEV-280): what the top three
  // don't cover is shown, not silently dropped.
  const categoryResidual = categoryEntries.slice(3).reduce((sum, [, seconds]) => sum + seconds, 0)
  if (categoryResidual >= 60) categorySplitAll.push(['Everything else', categoryResidual])
  const categorySplit = categorySplitAll.length <= 1
    ? categorySplitAll.filter(([label]) => label !== typeTag)
    : categorySplitAll
  // The type tag is dropped when it only echoes the block's own title (a
  // "Browsing" block titled "Browsing"), so the category is stated once, not
  // three times (DEV-272).
  const showTypeTag = typeTag.trim().toLowerCase() !== userVisibleBlockLabel(block).trim().toLowerCase()

  // Presentation (name/detail/icon/onOpen) for a row tree node, built from
  // whichever raw source object it carries. Kept separate from the pure
  // nesting logic so that logic stays testable without React/icon deps.
  const presentationFor = (row: DetailRowNode): { name: string; detail: string | null; icon: ReactNode; onOpen?: () => void } => {
    if (row.kind === 'app' && row.app) {
      const app = row.app
      return {
        name: formatDisplayAppName(app.appName),
        detail: activityCategoryLabel(app.category),
        icon: <AppIcon bundleId={app.bundleId} appName={app.appName} size={24} fontSize={10} color={accent} />,
      }
    }
    if (row.kind === 'artifact' && row.artifact) {
      const artifact = row.artifact
      return {
        name: cleanTitleForDisplay(artifact.displayTitle.trim()),
        detail: artifact.subtitle ? formatDisplayAppName(artifact.subtitle) : (artifact.host || artifact.path || null),
        icon: (
          <EntityIcon
            artifactType={artifact.artifactType}
            canonicalAppId={artifact.canonicalAppId}
            ownerBundleId={artifact.ownerBundleId}
            ownerAppName={artifact.ownerAppName}
            ownerAppInstanceId={artifact.ownerAppInstanceId}
            title={artifact.displayTitle}
            path={artifact.path}
            domain={artifact.host}
            url={artifact.url}
            size={24}
          />
        ),
        onOpen: artifact.openTarget.kind === 'unsupported' || !artifact.openTarget.value ? undefined : () => void openArtifact(artifact),
      }
    }
    if (row.kind === 'residual') {
      // The reconciliation footer: browser time no page accounts for. Shown so
      // the child rows visibly sum to the parent (invariant 7) instead of
      // leaving a silent hole the user reads as a lie.
      return {
        name: 'No page recorded',
        detail: null,
        icon: <EntityIcon artifactType="page" title="No page recorded" size={24} />,
      }
    }
    const site = row.site
    return {
      name: site ? shortDomainLabel(site.domain) : '',
      detail: site?.topTitle?.trim() || null,
      icon: <EntityIcon artifactType="page" domain={site?.domain} title={site?.domain} size={24} />,
    }
  }

  const renderEvidenceRow = (row: DetailRowNode, dimmed: boolean, indented = false) => {
    const { name, detail, icon, onOpen } = presentationFor(row)
    const content = (
      <>
        <EvidenceIdentity
          icon={icon}
          title={name}
          titleStyle={{ fontSize: indented ? 12.5 : 13 }}
          detail={detail ? (
            <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail}</div>
          ) : undefined}
        />
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
          {formatDuration(row.seconds)}
        </div>
      </>
    )
    // Rows that happened inside another app indent under it: their minutes are
    // a breakdown of the parent's time, so they must not read as additive.
    // The indent must stay a single `padding` shorthand: mixing the shorthand
    // with a `paddingLeft` longhand in one spread object lets the shorthand
    // land AFTER the longhand in key order (spread dedup keeps the longhand's
    // first position) and silently reset the indent to 0 — which flattened
    // every nested site row under its browser.
    const baseStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', minWidth: 0, opacity: dimmed ? 0.6 : 1, padding: indented ? '0 0 0 34px' : 0 }
    const rowNode = onOpen
      ? (
        <button type="button" onClick={onOpen} style={{ ...baseStyle, border: 'none', background: 'transparent', textAlign: 'left', cursor: 'pointer' }}>
          {content}
        </button>
      )
      : <div style={baseStyle}>{content}</div>
    if (!row.children?.length) return <Fragment key={row.key}>{rowNode}</Fragment>
    return (
      <Fragment key={row.key}>
        {rowNode}
        {row.children.map((child) => renderEvidenceRow(child, dimmed, true))}
      </Fragment>
    )
  }

  const iconButtonStyle = (disabled = false): CSSProperties => ({
    width: 32,
    height: 32,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '50%',
    border: 'none',
    background: 'transparent',
    color: 'var(--color-text-secondary)',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  })
  const iconHover = {
    onMouseEnter: (e: ReactMouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = 'var(--color-surface-high)' },
    onMouseLeave: (e: ReactMouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = 'transparent' },
  }

  return (
    // Outer wrapper only positions the panel (pinned to the scrolling day, or
    // static inside the dev variant overlay). The fixed-height card lives
    // inside it so the cap and the internal scroll are unaffected by sticky.
    <div
      data-timeline-inspector="true"
      style={sticky
        ? { position: 'sticky', top: 24, alignSelf: 'start' }
        : { position: 'relative' }}
    >
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        // The hard cap: content never grows the panel past this — the body
        // below scrolls instead. overflow:hidden clips the rounded corners so
        // the internal scrollbar never pokes past the card edge.
        maxHeight: maxHeightPx,
        borderRadius: 18,
        border: '1px solid var(--color-border-ghost)',
        background: 'var(--color-surface)',
        overflow: 'hidden',
      }}>
        {/* The title header is a fixed flex sibling of the scroll body, so it
            never scrolls away — the block name + time stay pinned at the top of
            the panel however far the evidence below is scrolled. The bottom
            border is the subtle separator from the scrollable content. Read-only
            panel: close is the only control (editing lives in right-click →
            Edit). */}
        <div style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          padding: '14px 14px 14px 22px',
          borderBottom: '1px solid var(--color-border-ghost)',
        }}>
          <span aria-hidden="true" style={{ width: 14, height: 14, borderRadius: 4, background: accent, flexShrink: 0, marginTop: 4 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              title={userVisibleBlockLabel(block)}
              style={{
                fontSize: 16,
                fontWeight: 700,
                color: 'var(--color-text-primary)',
                lineHeight: 1.3,
                overflowWrap: 'break-word',
                wordBreak: 'break-word',
              }}
            >
              {userVisibleBlockLabel(block)}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', marginTop: 3 }}>
              {formatFullDate(payload.date)} ⋅ {formatClockTime(block.startTime)} – {formatClockTime(block.endTime)} · {formatDuration(blockDisplayedSpanSeconds(block))}
              {/* When the block spans lulls, the active number the chips and
                  summary reconcile against is stated, not left to arithmetic
                  the person cannot do (DEV-280). */}
              {blockDisplayedSpanSeconds(block) - blockActiveSeconds(block) >= 60 && (
                <> · {formatDuration(blockActiveSeconds(block))} active</>
              )}
            </div>
          </div>
          <button type="button" aria-label="Back to day summary" title="Back to day summary" onClick={onClose} style={{ ...iconButtonStyle(), flexShrink: 0, marginTop: -3, marginRight: -3 }} {...iconHover}>
            <X size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>

        {/* The scroll body owns its own scroll context: overscroll-behavior
            contain stops a scroll here from chaining out to the timeline, and
            (being the only scrollport inside the fixed card) scrolling the
            calendar outside never moves it. Thin styled scrollbar via CSS. */}
        <div className="timeline-detail-scroll" style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          padding: '16px 22px 20px',
        }}>
          {/* What kind of block this was, and how the time inside splits. */}
          {((showTypeTag && typeTag) || categorySplit.length > 0) && (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 14 }}>
              {showTypeTag && typeTag && (
                <span style={{
                  padding: '3px 9px',
                  borderRadius: 999,
                  fontSize: 11,
                  fontWeight: 700,
                  color: accent,
                  background: `${accent}1c`,
                  border: `1px solid ${accent}40`,
                }}>
                  {typeTag}
                </span>
              )}
              {categorySplit.map(([label, seconds]) => (
                <span key={label} style={{
                  padding: '3px 9px',
                  borderRadius: 999,
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--color-text-tertiary)',
                  border: '1px solid var(--color-border-ghost)',
                }}>
                  {label} · {formatDuration(seconds)}
                </span>
              ))}
            </div>
          )}

          {/* DEV-189: an attended meeting — the block's captured evidence
              matched a calendar event. Observed time stays the block's truth;
              the scheduled range is context. A wrong match is corrected with
              the existing tools (hide the block, exclude the meeting app's
              evidence, or change the block's type) and re-resolves. */}
          {matchedMeeting && (
            <div style={{
              display: 'grid',
              gap: 3,
              padding: '10px 12px',
              borderRadius: 12,
              border: '1px solid var(--color-border-ghost)',
              marginBottom: 14,
            }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-primary)' }}>
                Attended meeting · {safeTimelineText(matchedMeeting.title)}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
                Scheduled {formatClockTime(matchedMeeting.startMs)} – {formatClockTime(matchedMeeting.endMs)} · the time above is what was actually observed
              </div>
              {matchedMeeting.participants.length > 0 && (
                <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
                  With {matchedMeeting.participants.join(', ')}
                </div>
              )}
              {onCorrection && (
                <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                  <button
                    type="button"
                    style={{ fontSize: 11, padding: '3px 10px', borderRadius: 999, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-text-secondary)', cursor: 'pointer' }}
                    onClick={() => void onCorrection({
                      kind: 'mark-meeting',
                      date: payload.date,
                      meeting: { title: matchedMeeting.title, startMs: matchedMeeting.startMs },
                      status: 'skipped',
                    })}
                  >
                    I didn&apos;t attend
                  </button>
                  <button
                    type="button"
                    style={{ fontSize: 11, padding: '3px 10px', borderRadius: 999, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-text-secondary)', cursor: 'pointer' }}
                    onClick={() => void onCorrection({
                      kind: 'mark-meeting',
                      date: payload.date,
                      meeting: { title: matchedMeeting.title, startMs: matchedMeeting.startMs },
                      status: 'unrelated',
                    })}
                  >
                    Not this meeting
                  </button>
                </div>
              )}
            </div>
          )}

          {/* The block's summary — AI narrative once it lands, deterministic
              fallback before, same rule the block card follows. */}
          <p style={{ fontSize: 13.5, lineHeight: 1.65, color: 'var(--color-text-secondary)', margin: '0 0 20px' }}>
            {blockNarrative(block) ?? blockShortSummary(block)}
          </p>

          <div style={{ display: 'grid', gap: 18 }}>
            {evidence.length > 0 && (
              <section>
                <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', color: 'var(--color-text-tertiary)', marginBottom: 10, textTransform: 'uppercase' }}>
                  What you were in
                </div>
                <div style={{ display: 'grid', gap: 10 }}>
                  {evidence.map((row) => renderEvidenceRow(row, false))}
                </div>
                {briefCount > 0 && (
                  // Sub-minute apps and pages folded into one quiet line instead
                  // of standing as their own 2-second rows (DEV-272).
                  <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 8 }}>
                    + {briefCount} brief {briefCount === 1 ? 'glimpse' : 'glimpses'} under a minute{briefSeconds >= 60 ? ` · ${formatDuration(briefSeconds)}` : ''}
                  </div>
                )}
              </section>
            )}

            {/* Where active time went elsewhere inside this window: the leisure
                detours you were actually in. Honest, not a grade. Idle/away time
                never appears here — it isn't a detour, it's blank space. */}
            {detours.length > 0 && (
              <section>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
                  <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', color: 'var(--color-text-tertiary)', textTransform: 'uppercase' }}>
                    Detours
                  </div>
                  {detourSeconds > 0 && (
                    <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
                      {formatDuration(detourSeconds)}
                    </div>
                  )}
                </div>
                <div style={{ display: 'grid', gap: 10 }}>
                  {detours.map((row) => renderEvidenceRow(row, true))}
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// A week-grid event popover (DEV-236): clicking a block in week view opens its
// details in place — anchored at the click, clamped to the viewport — instead
// of navigating away to the day. "Open in day view" is offered as an action,
// not forced. Matches the Google Calendar reference, small events included.
function WeekEventPopover({
  block,
  date,
  x,
  y,
  onOpenDay,
  onClose,
}: {
  block: WorkContextBlock
  date: string
  x: number
  y: number
  onOpenDay: () => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const accent = activityColorForCategory(block.dominantCategory)
  // Responsive: a comfortable card on a wide window, never wider than the
  // window allows. Positioned beside the click, clamped inside the viewport.
  const width = Math.min(340, window.innerWidth - 32)
  const left = Math.max(16, Math.min(x + 12, window.innerWidth - width - 16))
  const top = Math.max(16, Math.min(y - 12, window.innerHeight - 220))
  const summary = blockNarrative(block) ?? blockShortSummary(block)

  return (
    <div
      data-timeline-inspector="true"
      style={{ position: 'fixed', inset: 0, zIndex: 92 }}
      onClick={onClose}
      onContextMenu={(event) => { event.preventDefault(); onClose() }}
    >
      <div
        role="dialog"
        aria-label={`${userVisibleBlockLabel(block)} details`}
        onClick={(event) => event.stopPropagation()}
        style={{
          position: 'fixed',
          left,
          top,
          width,
          borderRadius: 10,
          border: '1px solid var(--color-border-ghost)',
          background: 'var(--color-surface)',
          boxShadow: '0 18px 48px rgba(0,0,0,0.28)',
          padding: '14px 16px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'start', gap: 8 }}>
          {/* The category reads as a small square chip, not a stripe that
              rounds into pill caps on the card's corners. */}
          <span aria-hidden style={{ flexShrink: 0, width: 10, height: 10, borderRadius: 3, background: accent, marginTop: 4 }} />
          <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 650, color: 'var(--color-text-primary)', lineHeight: 1.35 }}>
            {userVisibleBlockLabel(block)}
          </span>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{ border: 'none', background: 'transparent', color: 'var(--color-text-tertiary)', fontSize: 15, fontWeight: 700, cursor: 'pointer', padding: 0, lineHeight: 1, flexShrink: 0 }}
          >
            ×
          </button>
        </div>
        {/* One quiet metadata line: when, how long, what kind. */}
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 5, paddingLeft: 18, fontVariantNumeric: 'tabular-nums' }}>
          {formatFullDate(date)} · {formatClockTime(block.startTime)} – {formatClockTime(block.endTime)} · {formatDuration(blockDisplayedSpanSeconds(block))}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 2, paddingLeft: 18 }}>
          {activityCategoryLabel(block.dominantCategory)}
        </div>
        {summary && (
          <p style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--color-text-secondary)', margin: '10px 0 0', paddingLeft: 18, display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 3, overflow: 'hidden' }}>
            {summary}
          </p>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <button
            type="button"
            onClick={() => { onOpenDay(); onClose() }}
            style={{ border: 'none', background: 'transparent', color: 'var(--color-text-secondary)', fontSize: 12, fontWeight: 650, cursor: 'pointer', padding: '5px 8px', borderRadius: 7 }}
          >
            Open in day view
          </button>
        </div>
      </div>
    </div>
  )
}

// The week as a real calendar grid: seven day columns on a shared 24-hour
// track, Google-Calendar shape, Daylens data. The stats + week review card
// keeps living underneath, computed from the same blocks the grid draws so
// the totals cannot disagree with what's on screen.
function CalendarWeekView({
  selectedDate,
  onSelectDate,
  onOpenBlock,
  nowMs,
  hourHeight,
  scrollerRef,
}: {
  selectedDate: string
  onSelectDate: (date: string) => void
  onOpenBlock: (date: string, startTime: number) => void
  nowMs: number
  hourHeight: number
  scrollerRef: React.RefObject<HTMLDivElement | null>
}) {
  const weekStart = weekStartString(selectedDate)
  const today = todayString()
  const dates = useMemo(() => Array.from({ length: 7 }, (_, index) => shiftDateString(weekStart, index)), [weekStart])
  const includesToday = dates.includes(today)

  const weekResource = useProjectionResource<DayTimelinePayload[]>({
    scope: 'timeline',
    dependencies: [weekStart],
    intervalMs: includesToday ? 30_000 : 0,
    load: () => Promise.all(dates.map((date) => ipc.db.getTimelineDay(date))),
  })

  const expectedWeekReviewScopeKey = `week:${weekStart}`
  const weekReviewResource = useProjectionResource<AISurfaceSummary | null>({
    scope: 'timeline',
    dependencies: [weekStart],
    intervalMs: 0,
    load: () => ipc.ai.getWeekReview(weekStart),
  })
  const [generatingWeekReview, setGeneratingWeekReview] = useState(false)
  const [weekReviewError, setWeekReviewError] = useState<string | null>(null)
  // DEV-236: clicking a block in week view opens its details in place here,
  // instead of navigating to the day.
  const [eventPopover, setEventPopover] = useState<{ block: WorkContextBlock; date: string; x: number; y: number } | null>(null)

  const days = useMemo(() => weekResource.data ?? [], [weekResource.data])
  const byDate = useMemo(() => new Map(days.map((payload) => [payload.date, payload])), [days])
  const rawWeekReview = weekReviewResource.data ?? null
  const weekReview = rawWeekReview && rawWeekReview.scopeKey === expectedWeekReviewScopeKey
    ? rawWeekReview
    : null

  const handleGenerateWeekReview = useCallback(async () => {
    setGeneratingWeekReview(true)
    setWeekReviewError(null)
    try {
      await ipc.ai.getWeekReview(weekStart, true)
      await weekReviewResource.refresh()
    } catch (error) {
      setWeekReviewError(error instanceof Error ? error.message : String(error))
    } finally {
      setGeneratingWeekReview(false)
    }
  }, [weekStart, weekReviewResource])

  // Every number below comes from the same blocks the grid draws.
  const dayTotals = dates.map((date) => {
    const blocks = byDate.get(date)?.blocks ?? []
    return { date, seconds: blocks.reduce((sum, block) => sum + blockActiveSeconds(block), 0), blocks }
  })
  const activeDays = dayTotals.filter((day) => day.seconds > 0)
  const totalWeekSeconds = activeDays.reduce((sum, day) => sum + day.seconds, 0)
  const averageTrackedSeconds = activeDays.length > 0 ? Math.round(totalWeekSeconds / activeDays.length) : 0
  const mostActiveDay = activeDays.length > 0
    ? activeDays.reduce((best, day) => day.seconds > best.seconds ? day : best)
    : null
  const topWeekCategory = [...dayTotals
    .flatMap((day) => day.blocks)
    .reduce<Map<AppCategory, number>>((map, block) => {
      map.set(block.dominantCategory, (map.get(block.dominantCategory) ?? 0) + blockActiveSeconds(block))
      return map
    }, new Map())
    .entries()]
    .sort((left, right) => right[1] - left[1])[0] ?? null

  // The shared hour scale covers only the hours the week actually lived in
  // (first tracked event to last across all seven days), so there is no dead
  // space to scroll through — the grid starts where the week starts.
  const weekBounds = useMemo(
    () => trackBoundsFor(days.map((payload) => ({ date: payload.date, blocks: payload.blocks })), includesToday ? nowMs : null),
    [days, includesToday, nowMs],
  )
  useEffect(() => {
    const scroller = scrollerRef.current
    if (scroller) scroller.scrollTop = 0
  }, [weekStart, scrollerRef])

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      {/* The week grid sits directly on the page background — no wrapping card. */}
      <div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: `${TIME_GUTTER_WIDTH}px repeat(7, minmax(0, 1fr))`,
          borderBottom: '1px solid var(--color-border-ghost)',
        }}>
          <div />
          {dates.map((date) => {
            const [y, m, d] = date.split('-').map(Number)
            const isToday = date === today
            return (
              <button
                key={`head:${date}`}
                type="button"
                onClick={() => onSelectDate(date)}
                title={`Open ${formatFullDate(date)}`}
                style={{
                  border: 'none',
                  borderLeft: '1px solid var(--color-border-ghost)',
                  background: 'transparent',
                  cursor: 'pointer',
                  padding: '10px 4px 8px',
                  textAlign: 'center',
                  minWidth: 0,
                }}
              >
                <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)' }}>
                  {new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(y, m - 1, d))}
                </div>
                <div style={{
                  margin: '4px auto 0',
                  width: 26,
                  height: 26,
                  lineHeight: '26px',
                  borderRadius: '50%',
                  fontSize: 13,
                  fontWeight: 700,
                  color: isToday ? 'var(--color-primary-contrast)' : 'var(--color-text-primary)',
                  background: isToday ? 'var(--gradient-primary)' : 'transparent',
                }}>
                  {d}
                </div>
              </button>
            )
          })}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: `${TIME_GUTTER_WIDTH}px repeat(7, minmax(0, 1fr))` }}>
          <HourGutter hourHeight={hourHeight} bounds={weekBounds} />
          {dates.map((date) => (
            <div key={`col:${date}`} style={{ borderLeft: '1px solid var(--color-border-ghost)', minWidth: 0 }}>
              <CalendarDayTrack
                date={date}
                blocks={byDate.get(date)?.blocks ?? []}
                bounds={weekBounds}
                hourHeight={hourHeight}
                compact
                nowMs={date === today ? nowMs : null}
                onBlockClick={(block, event) => setEventPopover({ block, date, x: event.clientX, y: event.clientY })}
              />
            </div>
          ))}
        </div>
      </div>

      <div style={{
        borderRadius: 16,
        border: '1px solid var(--color-border-ghost)',
        background: 'var(--color-surface)',
        padding: '18px 20px',
        display: 'grid',
        gap: 14,
      }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 12,
        }}>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', color: 'var(--color-text-tertiary)', marginBottom: 6 }}>
              Week total
            </div>
            <div style={{ fontSize: 24, fontWeight: 780, color: 'var(--color-text-primary)' }}>
              {formatDuration(totalWeekSeconds)}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
              {activeDays.length > 0
                ? `${activeDays.length} tracked day${activeDays.length !== 1 ? 's' : ''}`
                : 'No tracked days'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', color: 'var(--color-text-tertiary)', marginBottom: 6 }}>
              Daily average
            </div>
            <div style={{ fontSize: 24, fontWeight: 780, color: 'var(--color-text-primary)' }}>
              {activeDays.length > 0 ? formatDuration(averageTrackedSeconds) : '0m'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', color: 'var(--color-text-tertiary)', marginBottom: 6 }}>
              Most active
            </div>
            <div style={{ fontSize: 24, fontWeight: 780, color: 'var(--color-text-primary)' }}>
              {mostActiveDay ? formatDuration(mostActiveDay.seconds) : '0m'}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
              {mostActiveDay ? formatFullDate(mostActiveDay.date) : 'No tracked days'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', color: 'var(--color-text-tertiary)', marginBottom: 6 }}>
              Main mode
            </div>
            <div style={{ fontSize: 16, fontWeight: 760, color: 'var(--color-text-primary)' }}>
              {topWeekCategory ? activityCategoryLabel(topWeekCategory[0]) : 'No data'}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
              {topWeekCategory ? formatDuration(topWeekCategory[1]) : 'Waiting for tracked time'}
            </div>
          </div>
        </div>

        <div style={{
          borderTop: '1px solid var(--color-border-ghost)',
          paddingTop: 14,
          display: 'grid',
          gap: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', color: 'var(--color-text-tertiary)' }}>
              Week review
            </div>
            <button
              type="button"
              onClick={() => void handleGenerateWeekReview()}
              disabled={generatingWeekReview || weekReviewResource.loading}
              style={{
                padding: '6px 10px',
                borderRadius: 8,
                border: '1px solid var(--color-border-ghost)',
                background: 'var(--color-surface-low)',
                color: 'var(--color-text-secondary)',
                fontSize: 11.5,
                fontWeight: 700,
                cursor: generatingWeekReview || weekReviewResource.loading ? 'default' : 'pointer',
                opacity: generatingWeekReview || weekReviewResource.loading ? 0.6 : 1,
              }}
            >
              {generatingWeekReview ? 'Generating…' : weekReview ? 'Refresh' : 'Generate'}
            </button>
          </div>
          <div style={{ fontSize: 13.5, lineHeight: 1.7, color: 'var(--color-text-secondary)' }}>
            {weekReviewError
              ? `Could not generate the week review: ${weekReviewError}`
              : weekReviewResource.error
                ? `Could not load the saved week review: ${weekReviewResource.error}`
                : generatingWeekReview
              ? 'Generating a grounded review for this week…'
              : weekReview
                ? weekReview.summary
                : weekReviewResource.loading
                  ? 'Checking for a saved review…'
                  : 'No saved review for this week yet. Click Generate to summarize what happened.'}
          </div>
        </div>
      </div>

      {eventPopover && (
        <WeekEventPopover
          block={eventPopover.block}
          date={eventPopover.date}
          x={eventPopover.x}
          y={eventPopover.y}
          onOpenDay={() => onOpenBlock(eventPopover.date, eventPopover.block.startTime)}
          onClose={() => setEventPopover(null)}
        />
      )}
    </div>
  )
}

// The month as a day-cell grid: full Monday-start weeks, each cell listing
// the day's first blocks plus its tracked total. Fed by the lightweight
// range-blocks read over the same persisted blocks the day view renders;
// today's cell comes from the live day payload so the two views agree.
function CalendarMonthView({
  selectedDate,
  onSelectDate,
}: {
  selectedDate: string
  onSelectDate: (date: string) => void
}) {
  const key = monthKey(selectedDate)
  const gridDates = useMemo(() => monthGridDates(selectedDate), [selectedDate])
  const today = todayString()
  const from = gridDates[0]
  const to = gridDates[gridDates.length - 1]
  const includesToday = from <= today && today <= to

  const monthResource = useProjectionResource<CalendarRangeDay[]>({
    scope: 'timeline',
    dependencies: [key],
    intervalMs: includesToday ? 60_000 : 0,
    load: async () => {
      const rangeDays = await ipc.db.getTimelineRangeBlocks(from, to)
      if (!includesToday) return rangeDays
      // Today is still live (not persisted) — read it from the same day
      // payload the day view renders so the month cell can't disagree.
      const todayPayload = await ipc.db.getTimelineDay(today)
      const todayBlocks: CalendarRangeBlock[] = todayPayload.blocks.map((block) => ({
        id: block.id,
        date: today,
        startTime: block.startTime,
        endTime: block.endTime,
        dominantCategory: block.dominantCategory,
        label: userVisibleBlockLabel(block),
        kind: effectiveBlockKind(block),
        activeSeconds: blockActiveSeconds(block),
      }))
      const rest = rangeDays.filter((day) => day.date !== today)
      if (todayBlocks.length === 0) return rest
      return [...rest, {
        date: today,
        blocks: todayBlocks,
        activeSeconds: todayBlocks.reduce((sum, block) => sum + block.activeSeconds, 0),
      }]
    },
  })

  const byDate = useMemo(
    () => new Map((monthResource.data ?? []).map((day) => [day.date, day])),
    [monthResource.data],
  )

  const weekdayNames = useMemo(() => gridDates.slice(0, 7).map((date) => {
    const [y, m, d] = date.split('-').map(Number)
    return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(y, m - 1, d))
  }), [gridDates])

  return (
    <div style={{
      borderRadius: 16,
      border: '1px solid var(--color-border-ghost)',
      background: 'var(--color-surface)',
      overflow: 'hidden',
    }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))' }}>
        {weekdayNames.map((name) => (
          <div key={`wd:${name}`} style={{
            padding: '10px 10px 8px',
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--color-text-tertiary)',
            textAlign: 'right',
            borderBottom: '1px solid var(--color-border-ghost)',
          }}>
            {name}
          </div>
        ))}
        {gridDates.map((date, index) => {
          const day = byDate.get(date)
          const blocks = day?.blocks ?? []
          const inMonth = monthKey(date) === key
          const isToday = date === today
          const isFuture = date > today
          const shown = blocks.slice(0, 3)
          const dayNumber = Number(date.split('-')[2])
          return (
            <button
              key={date}
              type="button"
              onClick={() => onSelectDate(date)}
              title={`Open ${formatFullDate(date)}`}
              style={{
                border: 'none',
                borderLeft: index % 7 === 0 ? 'none' : '1px solid var(--color-border-ghost)',
                borderTop: index < 7 ? 'none' : '1px solid var(--color-border-ghost)',
                background: 'transparent',
                cursor: 'pointer',
                textAlign: 'left',
                padding: '8px 8px 10px',
                minHeight: 118,
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                // Buttons don't stretch their flex children by default
                // (UA style), so without this a nowrap row keeps its content
                // width and bleeds across the neighbouring cells.
                alignItems: 'stretch',
                overflow: 'hidden',
                gap: 4,
                opacity: inMonth ? 1 : 0.4,
              }}
            >
              <div style={{ alignSelf: 'flex-end' }}>
                <span style={{
                  display: 'inline-block',
                  minWidth: 24,
                  height: 24,
                  lineHeight: '24px',
                  borderRadius: '50%',
                  textAlign: 'center',
                  fontSize: 12,
                  fontWeight: 700,
                  color: isToday ? 'var(--color-primary-contrast)' : isFuture ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)',
                  background: isToday ? 'var(--gradient-primary)' : 'transparent',
                }}>
                  {dayNumber}
                </span>
              </div>
              {shown.map((block) => (
                <div key={block.id} style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, opacity: block.kind !== 'work' ? 0.7 : 1 }}>
                  <span style={{
                    flexShrink: 0,
                    width: 7,
                    height: 7,
                    borderRadius: 2,
                    background: activityColorForCategory(block.dominantCategory),
                  }} />
                  <span style={{ flexShrink: 0, fontSize: 10.5, color: 'var(--color-text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
                    {formatClockTime(block.startTime)}
                  </span>
                  <span style={{
                    fontSize: 11,
                    color: 'var(--color-text-secondary)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    minWidth: 0,
                  }}>
                    {block.label}
                  </span>
                </div>
              ))}
              {blocks.length > shown.length && (
                <div style={{ fontSize: 10.5, color: 'var(--color-text-tertiary)' }}>
                  +{blocks.length - shown.length} more
                </div>
              )}
              {day && day.activeSeconds > 0 && (
                <div style={{ marginTop: 'auto', fontSize: 10.5, fontWeight: 650, color: 'var(--color-text-tertiary)' }}>
                  {formatDuration(day.activeSeconds)} tracked
                </div>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default function Timeline() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null)
  // The far end of a shift-selected merge span. Null means a plain single
  // selection; set means "select the whole run between the anchor and here".
  const [mergeRangeEndId, setMergeRangeEndId] = useState<string | null>(null)
  // A merge that failed before its preview dialog could open (e.g. the span
  // still holds a live episode). Surfaced as a small toast at the click instead
  // of failing silently — a merge that does nothing with no feedback is the
  // exact bug DEV-233 fixes.
  const [mergeError, setMergeError] = useState<string | null>(null)
  const isCompact = useCompactLayout()
  const [navState, setNavState] = useState<TimelineNavState>(() => timelineNavStateFromParams(searchParams))
  // Clock tick for the current-time line and the live block's growing bottom
  // edge — 30s keeps the active session visibly moving between data refreshes.
  const [nowMs, setNowMs] = useState(() => Date.now())
  // Day/week calendar density (DEV-235): each view keeps its own zoom,
  // persisted so it sticks across sessions. Changed only by shortcut/gesture.
  const [zoomByView, setZoomByView] = useState<Record<ZoomableView, number>>(loadTimelineZoom)
  // The transient zoom readout: shows the new percentage for a moment while
  // zooming, then fades — the only zoom UI on screen (DEV-235).
  const [zoomFlash, setZoomFlash] = useState<number | null>(null)
  const zoomFlashTimerRef = useRef<number | null>(null)
  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(TIMELINE_ZOOM_KEYS.day, String(zoomByView.day))
    localStorage.setItem(TIMELINE_ZOOM_KEYS.week, String(zoomByView.week))
  }, [zoomByView])
  useEffect(() => () => {
    if (zoomFlashTimerRef.current != null) window.clearTimeout(zoomFlashTimerRef.current)
  }, [])
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const lastTimelineOpenKeyRef = useRef<string | null>(null)
  const lastViewOpenedKeyRef = useRef<string | null>(null)
  const lastBlockOpenKeyRef = useRef<string | null>(null)
  // After a merge the old block ids vanish; we stash the merged span's start
  // time so the next payload can reselect the single block that now covers it.
  const pendingSelectAtRef = useRef<number | null>(null)

  const searchSignature = searchParams.toString()
  const view = navState.view
  const date = navState.date
  const isToday = date === todayString()

  const dayHourHeight = Math.round(DAY_HOUR_HEIGHT * zoomByView.day)
  const adjustZoom = useCallback((delta: number) => {
    if (view === 'month') return
    const target: ZoomableView = view === 'week' ? 'week' : 'day'
    setZoomByView((current) => {
      const next = Math.round(Math.min(TIMELINE_ZOOM_MAX, Math.max(TIMELINE_ZOOM_MIN, current[target] + delta)) * 100) / 100
      if (next === current[target]) return current
      setZoomFlash(next)
      if (zoomFlashTimerRef.current != null) window.clearTimeout(zoomFlashTimerRef.current)
      zoomFlashTimerRef.current = window.setTimeout(() => setZoomFlash(null), 900)
      return { ...current, [target]: next }
    })
  }, [view])

  // ⌘+ / ⌘− step the zoom; ⌘0 resets. Skipped while typing in a field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      if (event.key === '=' || event.key === '+') {
        event.preventDefault()
        adjustZoom(TIMELINE_ZOOM_STEP)
      } else if (event.key === '-') {
        event.preventDefault()
        adjustZoom(-TIMELINE_ZOOM_STEP)
      } else if (event.key === '0') {
        event.preventDefault()
        if (view === 'month') return
        const targetView: ZoomableView = view === 'week' ? 'week' : 'day'
        setZoomByView((current) => (current[targetView] === 1 ? current : { ...current, [targetView]: 1 }))
        setZoomFlash(1)
        if (zoomFlashTimerRef.current != null) window.clearTimeout(zoomFlashTimerRef.current)
        zoomFlashTimerRef.current = window.setTimeout(() => setZoomFlash(null), 900)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [adjustZoom, view])

  // Trackpad pinch (delivered as ctrl+wheel) and ⌘-scroll zoom the grid in
  // place. Non-passive so the page doesn't also scroll/zoom underneath.
  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    let accumulated = 0
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      accumulated += -event.deltaY
      // A pinch streams many small deltas; a step lands once enough gathers.
      if (Math.abs(accumulated) >= 24) {
        adjustZoom(accumulated > 0 ? TIMELINE_ZOOM_STEP : -TIMELINE_ZOOM_STEP)
        accumulated = 0
      }
    }
    scroller.addEventListener('wheel', onWheel, { passive: false })
    return () => scroller.removeEventListener('wheel', onWheel)
  }, [adjustZoom])
  // Dev preview (?panelVariants=1): render both height caps side by side to
  // compare the short vs. tall detail panel before settling on one.
  const panelVariantsPreview = searchParams.get('panelVariants') === '1'

  useEffect(() => {
    const next = timelineNavStateFromParams(searchParams)
    setNavState((current) => (
      current.view === next.view && current.date === next.date
        ? current
        : next
    ))
  }, [searchSignature])

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const timelineResource = useProjectionResource<DayTimelinePayload>({
    scope: 'timeline',
    enabled: view === 'day',
    dependencies: [date, view],
    intervalMs: isToday ? 30_000 : 0,
    // The day view shows the day's clarifying questions, and detecting them
    // needs exactly this payload. Asking here means one projection instead of
    // two: the separate fetch below rebuilt it from scratch to reach the same
    // answer (329-675ms on a real day).
    load: () => ipc.db.getTimelineDay(date, { withClarifications: true }),
  })

  const payload = timelineResource.data?.date === date ? timelineResource.data : null
  const error = timelineResource.error
  const loading = view === 'day' && (!payload || timelineResource.loading)

  // Analyze run-state lives here, above the summary/block-detail panel swap, so
  // its progress and outcome survive selecting a block mid-run (DEV-270).
  const dayAnalysis = useDayAnalysis(
    date,
    payload?.blocks.some((block) => block.provisional) ?? false,
    timelineResource.refresh,
  )

  const blockMap = useMemo(() => {
    const map = new Map<string, WorkContextBlock>()
    for (const block of payload?.blocks ?? []) {
      map.set(block.id, block)
    }
    return map
  }, [payload])

  // Blocks sorted by start — the order shift-selection ranges over.
  const sortedBlocks = useMemo(
    () => [...(payload?.blocks ?? [])].sort((a, b) => a.startTime - b.startTime),
    [payload],
  )

  // The contiguous span the user has shift-selected: just the anchor for a
  // plain click, or the inclusive run between the anchor and the shift-clicked
  // end. Everything in here renders highlighted and merges together.
  const mergeSelection = useMemo(
    () => mergeSelectionSpan(sortedBlocks, selectedBlockId, mergeRangeEndId),
    [sortedBlocks, selectedBlockId, mergeRangeEndId],
  )
  const selectedSpanIds = useMemo(
    () => new Set(mergeSelection.map((block) => block.id)),
    [mergeSelection],
  )
  const spanMerge = useMemo(() => spanMergeState(mergeSelection), [mergeSelection])

  // The day track runs from the first tracked event to the last (or "now" on
  // today) — hours with no activity are simply not part of the view.
  const dayBounds = useMemo(
    () => trackBoundsFor(payload ? [{ date: payload.date, blocks: sortedBlocks, scheduledMeetings: payload.scheduledMeetings }] : [], isToday ? nowMs : null),
    [payload, sortedBlocks, isToday, nowMs],
  )

  // The GCal-style right-click menu on a block: position + the block it's for.
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; blockId: string } | null>(null)
  // The block being edited in the editor modal (right-click → Edit). The
  // read-only detail panel never hosts edit controls.
  const [editBlockId, setEditBlockId] = useState<string | null>(null)
  const [menuBusy, setMenuBusy] = useState(false)
  // The block a split is being picked for (right-click → Split block…).
  const [splitBlockId, setSplitBlockId] = useState<string | null>(null)

  // The shared preview → apply → undo flow every non-destructive correction
  // runs through (DEV-172). Applying or undoing re-forms the day, so the
  // hook's callback owns the cache drop + refresh.
  const correction = useCorrectionFlow(async () => {
    daySummaryRecapCache.delete(date)
    await timelineResource.refresh()
  })

  // Filter the day by block type ("Focused work", "Meeting", "Leisure"…).
  // Filtering dims the other blocks in place — the day's shape stays honest.
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const dayTags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const block of sortedBlocks) {
      if (block.provisional) continue
      const tag = blockTypeTag(block)
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [sortedBlocks])

  useEffect(() => {
    if (!selectedBlockId) return
    if (blockMap.has(selectedBlockId)) return
    setSelectedBlockId(null)
  }, [payload, selectedBlockId, blockMap])

  // Drop a stale range end the moment its block leaves the day (e.g. after a
  // rebuild or merge) so the span collapses cleanly back to the anchor.
  useEffect(() => {
    if (mergeRangeEndId && !blockMap.has(mergeRangeEndId)) setMergeRangeEndId(null)
  }, [blockMap, mergeRangeEndId])

  useEffect(() => {
    setSelectedBlockId(null)
    setMergeRangeEndId(null)
    setTagFilter(null)
  }, [date])

  // Escape steps the selection down: first it drops a multi-block merge span,
  // then it deselects entirely. While the context menu or editor modal is open,
  // Escape belongs to that overlay — it must not also touch selection.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (contextMenu || editBlockId) return
      if (mergeRangeEndId) setMergeRangeEndId(null)
      else if (selectedBlockId) setSelectedBlockId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mergeRangeEndId, selectedBlockId, contextMenu, editBlockId])

  // Once the post-merge payload lands, reselect the single block now covering
  // the merged span and clear the pending marker.
  useEffect(() => {
    const at = pendingSelectAtRef.current
    if (at == null || !payload) return
    const hit = payload.blocks.find((candidate) => at >= candidate.startTime && at <= candidate.endTime)
      ?? payload.blocks.find((candidate) => candidate.startTime >= at)
    if (hit) {
      pendingSelectAtRef.current = null
      setSelectedBlockId(hit.id)
    }
  }, [payload])

  // Past days, week, and month open at the top (their tracks are clamped to
  // the tracked hours, so the top is the first tracked event). Today's day
  // view instead anchors on the live "Active now" block once the payload
  // lands — the user opens the timeline to see what is happening now, not the
  // empty morning above it. Anchor once per view/date so 30s refreshes never
  // fight the user's own scrolling.
  const anchoredKeyRef = useRef<string | null>(null)
  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    const key = `${view}:${date}`
    if (anchoredKeyRef.current === key) return
    if (view !== 'day' || !isToday) {
      anchoredKeyRef.current = key
      node.scrollTop = 0
      return
    }
    if (!payload) return // wait for the day to land, then anchor once
    anchoredKeyRef.current = key
    const liveBlock = payload.blocks.find((block) => block.isLive)
    const el = liveBlock
      ? node.querySelector<HTMLElement>(`[data-timeline-block-id="${liveBlock.id}"]`)
      : null
    if (el) el.scrollIntoView({ block: 'center' })
    else node.scrollTop = 0
  }, [view, date, isToday, payload])

  useEffect(() => {
    const openKey = view === 'week'
      ? `week:${date}`
      : view === 'month'
        ? `month:${monthKey(date)}`
        : payload
          ? `day:${payload.date}:${payload.blocks.length}:${payload.totalSeconds}`
          : null
    if (!openKey || lastTimelineOpenKeyRef.current === openKey) return
    lastTimelineOpenKeyRef.current = openKey
    track(ANALYTICS_EVENT.TIMELINE_OPENED, {
      block_count_bucket: blockCountBucket(payload?.blocks.length ?? 0),
      surface: 'timeline',
      tracked_time_bucket: trackedTimeBucket(payload?.totalSeconds ?? 0),
      trigger: 'navigation',
      view,
    })
  }, [date, payload, view])

  // view_opened for the timeline: once per navigation (view+date), with the
  // block count — unlike TIMELINE_OPENED above, it does not re-fire as live
  // tracking grows the same day's data. Non-timeline routes fire in App.tsx.
  useEffect(() => {
    if (!payload) return
    const key = `${view}:${date}`
    if (lastViewOpenedKeyRef.current === key) return
    lastViewOpenedKeyRef.current = key
    track(ANALYTICS_EVENT.VIEW_OPENED, {
      view_name: 'timeline',
      date_context: date === todayString() ? 'today' : 'past',
      block_count: payload.blocks.length,
    })
  }, [date, payload, view])

  const selectedBlock = selectedBlockId ? blockMap.get(selectedBlockId) ?? null : null

  // The day's typed gaps — each visible blank stretch with its reason
  // (Asleep / Away / Idle / Passive / Tracking paused / Untracked).
  const gapSegments = useMemo(
    () => (payload?.segments ?? []).filter((segment): segment is TimelineGapSegment => segment.kind !== 'work_block'),
    [payload],
  )

  // Right-click on a block (GCal-style) only opens the menu — it never
  // selects the block or swaps the right panel. Click = read, right-click =
  // edit (timeline.md §3.4 rule 5): panel-swap is left-click's job alone.
  // Provisional (not-yet-analyzed) blocks get the menu too — that's the
  // common case on a live day; the editor itself limits what a provisional
  // block can change.
  const openBlockContextMenu = (block: WorkContextBlock, event: ReactMouseEvent) => {
    event.preventDefault()
    setContextMenu({ x: event.clientX, y: event.clientY, blockId: block.id })
  }

  // DEV-189: the attended/skipped/moved/unrelated mark menu for a scheduled
  // event outline. Marks flow through the same correction pipeline as every
  // other correction — previewed, durable, undoable.
  const [meetingMenu, setMeetingMenu] = useState<{ x: number; y: number; meeting: TimelineScheduledMeeting } | null>(null)
  const [meetingMenuBusy, setMeetingMenuBusy] = useState(false)
  const openScheduledMeetingMenu = (meeting: TimelineScheduledMeeting, event: ReactMouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setMeetingMenu({ x: event.clientX, y: event.clientY, meeting })
  }
  const markScheduledMeeting = async (status: 'attended' | 'skipped' | 'moved' | 'unrelated' | null) => {
    if (!meetingMenu) return
    setMeetingMenuBusy(true)
    try {
      await correction.request({
        kind: 'mark-meeting',
        date,
        meeting: { title: meetingMenu.meeting.title, startMs: meetingMenu.meeting.startMs },
        status,
      })
      setMeetingMenu(null)
    } finally {
      setMeetingMenuBusy(false)
    }
  }

  // The menu's target block and its immediate neighbours, for "Merge with
  // above/below" — a single-neighbour merge, not the shift-click range merge
  // that used to live on the read-only panel (spec: no edit controls there).
  const menuBlock = contextMenu ? blockMap.get(contextMenu.blockId) ?? null : null
  const menuBlockIndex = menuBlock ? sortedBlocks.findIndex((candidate) => candidate.id === menuBlock.id) : -1
  const menuAboveBlock = menuBlockIndex > 0 ? sortedBlocks[menuBlockIndex - 1] : null
  const menuBelowBlock = menuBlockIndex >= 0 && menuBlockIndex < sortedBlocks.length - 1 ? sortedBlocks[menuBlockIndex + 1] : null
  // A provisional (live) block on either side of the pair can't be merged
  // yet — same rule the old panel control used (timeline.md §4).
  const menuMergeAboveDisabled = !!menuBlock?.provisional || !!menuAboveBlock?.provisional
  const menuMergeBelowDisabled = !!menuBlock?.provisional || !!menuBelowBlock?.provisional

  // When the right-clicked block is part of an active shift-selected span, the
  // menu offers "Merge N blocks" for the whole run instead of the single-
  // neighbour items — the second merge gesture, sharing the same menu.
  const menuMergeSpanActive = !!menuBlock && spanMerge.isSpan && selectedSpanIds.has(menuBlock.id)

  // Merges run through the shared preview flow: the menu closes, the preview
  // dialog opens, and selection collapses onto the merged span only after the
  // correction actually applied. A cancelled preview leaves the grid as-is.
  const runMerge = async (blockIds: string[], selectAt: number | null) => {
    setContextMenu(null)
    setMergeError(null)
    try {
      const applied = await correction.request({ kind: 'merge', date, blockIds })
      if (applied) {
        if (selectAt != null) pendingSelectAtRef.current = selectAt
        setMergeRangeEndId(null)
        setSelectedBlockId(null)
      }
    } catch (err) {
      // The merge couldn't even be previewed — say why at the click instead of
      // leaving the user staring at an unchanged grid (DEV-233).
      setMergeError(sanitizeIpcError(err, "Couldn't merge these blocks. Try again in a moment.").message)
    }
  }

  const menuMergeSpan = async () => {
    if (!contextMenu || menuBusy || !menuMergeSpanActive || !spanMerge.canMerge || !spanMerge.endpointIds) return
    const [startId] = spanMerge.endpointIds
    await runMerge(spanMerge.endpointIds, blockMap.get(startId)?.startTime ?? null)
  }

  const menuMergeAbove = async () => {
    if (!contextMenu || menuBusy || !menuBlock || !menuAboveBlock || menuMergeAboveDisabled) return
    await runMerge([menuAboveBlock.id, menuBlock.id], menuAboveBlock.startTime)
  }

  const menuMergeBelow = async () => {
    if (!contextMenu || menuBusy || !menuBlock || !menuBelowBlock || menuMergeBelowDisabled) return
    await runMerge([menuBlock.id, menuBelowBlock.id], menuBlock.startTime)
  }

  const menuRegenerate = async () => {
    if (!contextMenu || menuBusy) return
    setMenuBusy(true)
    try {
      await ipc.ai.regenerateBlockLabel(contextMenu.blockId)
      daySummaryRecapCache.delete(date)
      await timelineResource.refresh()
    } catch {
      // The inspector surfaces regenerate errors; the menu just closes.
    } finally {
      setMenuBusy(false)
      setContextMenu(null)
    }
  }

  // "Remove from day" hides the block from every corrected surface — an
  // undoable exclude-block correction, not a purge. Raw activity survives;
  // the permanent-erase path lives in the editor modal with its own confirm.
  const menuDelete = async () => {
    if (!contextMenu || menuBusy) return
    const blockId = contextMenu.blockId
    setContextMenu(null)
    try {
      const applied = await correction.request({ kind: 'exclude-block', date, blockId })
      if (applied) {
        setSelectedBlockId(null)
        setMergeRangeEndId(null)
      }
    } catch {
      // Preview failed — nothing changed on the grid.
    }
  }

  useEffect(() => {
    if (!selectedBlock) {
      lastBlockOpenKeyRef.current = null
      return
    }
    if (lastBlockOpenKeyRef.current === selectedBlock.id) return
    lastBlockOpenKeyRef.current = selectedBlock.id
    track(ANALYTICS_EVENT.TIMELINE_BLOCK_OPENED, {
      block_count_bucket: blockCountBucket(payload?.blocks.length ?? 0),
      surface: 'timeline',
      tracked_time_bucket: trackedTimeBucket(payload?.totalSeconds ?? 0),
      trigger: 'click',
      view,
    })
  }, [payload, selectedBlock, view])

  function updateNavState(nextState: TimelineNavState) {
    setNavState((current) => (
      current.view === nextState.view && current.date === nextState.date
        ? current
        : nextState
    ))
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      next.set('view', nextState.view)
      next.set('date', nextState.date)
      return next
    }, { replace: true })
  }

  function setView(nextView: TimelineNavState['view']) {
    updateNavState({ view: nextView, date })
  }

  function setDate(nextDate: string) {
    updateNavState({ view, date: nextDate })
  }

  const today = todayString()
  const onCurrentPeriod = view === 'day'
    ? isToday
    : view === 'week'
      ? weekStartString(date) === weekStartString(today)
      : monthKey(date) === monthKey(today)
  const forwardDisabled = onCurrentPeriod

  const headerLabel = view === 'week'
    ? weekRangeLabel(date)
    : view === 'month'
      ? monthLabel(date)
      : isToday ? 'Today' : formatFullDate(date)

  function stepDate(direction: -1 | 1) {
    if (view === 'week') {
      setDate(shiftDateString(weekStartString(date), direction * 7))
    } else if (view === 'month') {
      setDate(shiftMonth(date, direction))
    } else {
      setDate(shiftDateString(date, direction))
    }
  }

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}
      // Selection is deliberate two-state plumbing: clicking a block sets
      // selectedBlockId (the right panel renders that block's detail);
      // clicking anywhere that isn't a block, the inspector panel, or an
      // overlay (context menu / editor modal) clears it (the panel returns to
      // the day summary). Capture-phase on the view root so "anywhere
      // outside the block" means exactly that — header and empty space
      // included.
      onClickCapture={(event) => {
        const target = event.target as HTMLElement | null
        if (target?.closest('[data-timeline-inspector="true"]')) {
          return
        }
        const blockButton = target?.closest<HTMLElement>('[data-timeline-block-id]')
        const clickedId = blockButton?.dataset.timelineBlockId ?? null
        // Clicking empty space deselects everything.
        if (!clickedId) {
          setSelectedBlockId(null)
          setMergeRangeEndId(null)
          return
        }
        // Shift- (or Cmd-) click with something already selected extends the
        // selection into a merge span instead of replacing it — the second
        // merge gesture, alongside the right-click menu.
        if ((event.shiftKey || event.metaKey) && selectedBlockId && clickedId !== selectedBlockId) {
          setMergeRangeEndId(clickedId)
          return
        }
        setMergeRangeEndId(null)
        if (clickedId !== selectedBlockId) {
          setSelectedBlockId(clickedId)
        }
      }}
    >
      <div style={{
        position: 'sticky',
        top: 0,
        zIndex: 10,
        background: 'var(--color-bg)',
        borderBottom: '1px solid var(--color-border-ghost)',
        padding: '20px 32px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <PeriodNavigator
            label={headerLabel}
            value={view}
            options={[
              { value: 'day', label: 'Day' },
              { value: 'week', label: 'Week' },
              { value: 'month', label: 'Month' },
            ]}
            onChange={setView}
            onPrevious={() => stepDate(-1)}
            onNext={() => stepDate(1)}
            nextDisabled={forwardDisabled}
            onToday={onCurrentPeriod ? undefined : () => setDate(todayString())}
          />
        </div>
      </div>

      {/* Transient zoom readout (DEV-235): the only zoom UI — appears for a
          moment while ⌘+/⌘−/pinch changes density, then fades. */}
      {zoomFlash != null && view !== 'month' && (
        <div
          aria-live="polite"
          style={{ position: 'fixed', top: 84, left: '50%', transform: 'translateX(-50%)', zIndex: 60, pointerEvents: 'none', borderRadius: 999, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', boxShadow: '0 8px 24px rgba(0,0,0,0.18)', padding: '5px 14px', fontSize: 12, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'var(--color-text-secondary)' }}
        >
          {Math.round(zoomFlash * 100)}%
        </div>
      )}

      {/* The timeline scrolls without showing a scrollbar — the grid is the
          chrome; the hidden thumb lives in globals.css under .timeline-scroller. */}
      <div ref={scrollRef} className="timeline-scroller" style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
        {view === 'week' && (
          <div style={{ padding: '24px 32px 40px' }}>
            <CalendarWeekView
              selectedDate={date}
              nowMs={nowMs}
              hourHeight={Math.round(WEEK_HOUR_HEIGHT * zoomByView.week)}
              scrollerRef={scrollRef}
              onSelectDate={(nextDate) => {
                updateNavState({ view: 'day', date: nextDate })
              }}
              onOpenBlock={(nextDate, startTime) => {
                // Open the day with that block selected: the pending marker is
                // resolved against the day payload once it lands (same
                // mechanism a merge uses to reselect its fused block).
                pendingSelectAtRef.current = startTime
                updateNavState({ view: 'day', date: nextDate })
              }}
            />
          </div>
        )}

        {view === 'month' && (
          <div style={{ padding: '24px 32px 40px' }}>
            <CalendarMonthView
              selectedDate={date}
              onSelectDate={(nextDate) => {
                updateNavState({ view: 'day', date: nextDate })
              }}
            />
          </div>
        )}

        {view === 'day' && (
          <div style={{ padding: '24px 32px 40px' }}>
            {error && (
              <div style={{
                borderRadius: 16,
                border: '1px solid rgba(248, 113, 113, 0.28)',
                background: 'rgba(248, 113, 113, 0.08)',
                color: '#f87171',
                padding: '16px 18px',
                marginBottom: 18,
              }}>
                Could not load the timeline: {error}
              </div>
            )}

            {!error && loading && (
              <div style={{ display: 'grid', gap: 12 }}>
                {[0, 1, 2, 3].map((index) => (
                  <div key={index} style={{ display: 'grid', gridTemplateColumns: `${TIME_GUTTER_WIDTH}px minmax(0, 1fr)`, gap: 16 }}>
                    <div style={{ height: 20, borderRadius: 8, background: 'var(--color-surface-low)', opacity: 0.5 }} />
                    <div style={{ height: 110 - (index * 10), borderRadius: 16, background: 'var(--color-surface-low)', opacity: 0.5 }} />
                  </div>
                ))}
              </div>
            )}

            {!error && !loading && payload && (
              <>
                {/* Filter the day by block type. Dims the rest in place. */}
                {dayTags.length > 1 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 0 16px' }}>
                    {dayTags.map(([tag, count]) => {
                      const active = tagFilter === tag
                      return (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => setTagFilter(active ? null : tag)}
                          style={{
                            padding: '4px 11px',
                            borderRadius: 999,
                            fontSize: 11.5,
                            fontWeight: 650,
                            cursor: 'pointer',
                            border: '1px solid var(--color-border-ghost)',
                            background: active ? 'var(--gradient-primary)' : 'var(--color-surface)',
                            color: active ? 'var(--color-primary-contrast)' : 'var(--color-text-secondary)',
                          }}
                        >
                          {tag} · {count}
                        </button>
                      )
                    })}
                  </div>
                )}

                {payload.blocks.length === 0 && (
                  <div style={{
                    borderRadius: 18,
                    border: '1px solid var(--color-border-ghost)',
                    background: 'var(--color-surface)',
                    padding: '48px 24px',
                    textAlign: 'center',
                  }}>
                    <div style={{ fontSize: 18, fontWeight: 750, color: 'var(--color-text-primary)', marginBottom: 8 }}>
                      No tracked activity for this day
                    </div>
                    <div style={{ fontSize: 13.5, color: 'var(--color-text-tertiary)', maxWidth: 420, margin: '0 auto' }}>
                      Daylens rebuilds this view from persisted local activity. Once foreground activity exists for the day, blocks and gaps appear here automatically.
                    </div>
                  </div>
                )}

                {payload.blocks.length > 0 && (
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: isCompact ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) 360px',
                    gap: 24,
                    alignItems: 'start',
                  }}>
                    {/* Cards aren't text to select; killing user-select here keeps
                        shift-click from smearing a text highlight across the run. */}
                    {/* The grid renders directly on the page background — no card,
                        no border. Hour labels on the rail, blocks filling the rest. */}
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: `${TIME_GUTTER_WIDTH}px minmax(0, 1fr)`,
                        userSelect: 'none',
                      }}
                    >
                      <HourGutter hourHeight={dayHourHeight} bounds={dayBounds} />
                      <CalendarDayTrack
                        date={payload.date}
                        blocks={sortedBlocks}
                        bounds={dayBounds}
                        gapSegments={gapSegments}
                        scheduledMeetings={payload.scheduledMeetings}
                        onScheduledMeetingClick={openScheduledMeetingMenu}
                        hourHeight={dayHourHeight}
                        selectedBlockId={selectedBlockId}
                        selectedSpanIds={selectedSpanIds}
                        nowMs={isToday ? nowMs : null}
                        dimBlock={tagFilter ? (block) => blockTypeTag(block) !== tagFilter : undefined}
                        onBlockContextMenu={openBlockContextMenu}
                      />
                    </div>
                    {meetingMenu && (
                      <ScheduledMeetingMenu
                        x={meetingMenu.x}
                        y={meetingMenu.y}
                        meeting={meetingMenu.meeting}
                        busy={meetingMenuBusy}
                        onMark={(status) => { void markScheduledMeeting(status) }}
                        onClose={() => { if (!meetingMenuBusy) setMeetingMenu(null) }}
                      />
                    )}
                    {contextMenu && (
                      <BlockContextMenu
                        x={contextMenu.x}
                        y={contextMenu.y}
                        busy={menuBusy}
                        onEdit={() => {
                          setEditBlockId(contextMenu.blockId)
                          setContextMenu(null)
                        }}
                        onSplit={menuBlock && !menuBlock.provisional ? () => {
                          setSplitBlockId(contextMenu.blockId)
                          setContextMenu(null)
                        } : null}
                        mergeSpan={menuMergeSpanActive ? { count: spanMerge.count, disabled: !spanMerge.canMerge, onClick: () => { void menuMergeSpan() } } : null}
                        mergeAbove={menuAboveBlock ? { disabled: menuMergeAboveDisabled, onClick: () => { void menuMergeAbove() } } : null}
                        mergeBelow={menuBelowBlock ? { disabled: menuMergeBelowDisabled, onClick: () => { void menuMergeBelow() } } : null}
                        onRegenerate={() => { void menuRegenerate() }}
                        onDelete={() => { void menuDelete() }}
                        onClose={() => { if (!menuBusy) setContextMenu(null) }}
                      />
                    )}
                    {editBlockId && blockMap.get(editBlockId) && (
                      <BlockEditModal
                        block={blockMap.get(editBlockId)!}
                        payload={payload}
                        onClose={() => setEditBlockId(null)}
                        onDeleted={() => {
                          setSelectedBlockId(null)
                          setMergeRangeEndId(null)
                        }}
                        onRefresh={timelineResource.refresh}
                        onCorrection={correction.request}
                      />
                    )}
                    {splitBlockId && blockMap.get(splitBlockId) && (
                      <SplitBlockDialog
                        block={blockMap.get(splitBlockId)!}
                        onClose={() => setSplitBlockId(null)}
                        onSubmit={async (cutMs) => {
                          const applied = await correction.request({ kind: 'split', date, blockId: splitBlockId, cutMs })
                          if (applied) {
                            setSplitBlockId(null)
                            setSelectedBlockId(null)
                            setMergeRangeEndId(null)
                          }
                          return applied
                        }}
                      />
                    )}
                    {/* The right column is one panel with two mutually
                        exclusive states, keyed off selectedBlock: a selected
                        block shows its detail; no selection shows the day
                        summary. Nothing floats over the timeline. */}
                    {selectedBlock ? (
                      // One grid item: a fragment here would hand the grid two
                      // right-column children and wrap the detail panel to a
                      // full-width second row (DEV-283).
                      <div data-timeline-inspector="true" style={{ position: 'sticky', top: 24, alignSelf: 'start' }}>
                        {/* Analyze feedback follows you into a block's detail view
                            so the run never looks like it silently stopped (DEV-270). */}
                        {(dayAnalysis.analyzing || dayAnalysis.status) && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--color-text-secondary)', padding: '8px 12px', borderRadius: 10, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', marginBottom: 10 }}>
                            {dayAnalysis.analyzing && <span aria-hidden style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid var(--color-border-ghost)', borderTopColor: 'var(--color-text-secondary)', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />}
                            {dayAnalysis.analyzing
                              ? (dayAnalysis.progress ? analyzeProgressMessage(dayAnalysis.progress) : 'Analyzing day…')
                              : dayAnalysis.status}
                          </div>
                        )}
                        <BlockDetailInspector
                          block={selectedBlock}
                          payload={payload}
                          sticky={false}
                          onCorrection={correction.request}
                          onClose={() => {
                            setSelectedBlockId(null)
                            setMergeRangeEndId(null)
                          }}
                        />
                      </div>
                    ) : (
                      <DaySummaryInspector payload={payload} analysis={dayAnalysis} />
                    )}
                    {/* Dev preview only (?panelVariants=1): the two candidate
                        height caps side by side, to compare the short (320)
                        vs. tall (480) feel before settling on one. */}
                    {panelVariantsPreview && selectedBlock && (
                      <div
                        data-timeline-inspector="true"
                        style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 40, padding: 40 }}
                        onClick={() => { setSelectedBlockId(null); setMergeRangeEndId(null) }}
                      >
                        {([
                          { label: 'Variant A · 320px', cap: DETAIL_PANEL_MAX_HEIGHT_A },
                          { label: 'Variant B · 480px', cap: DETAIL_PANEL_MAX_HEIGHT_B },
                        ] as const).map(({ label, cap }) => (
                          <div key={label} style={{ width: 360, maxWidth: '40vw' }} onClick={(event) => event.stopPropagation()}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: '#fff', marginBottom: 8, textAlign: 'center', textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>
                              {label}
                            </div>
                            <BlockDetailInspector
                              block={selectedBlock}
                              payload={payload}
                              maxHeightPx={cap}
                              sticky={false}
                              onClose={() => { setSelectedBlockId(null); setMergeRangeEndId(null) }}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {/* The correction preview dialog + undo toast — outside the
                    blocks gate so the toast survives excluding the last block. */}
                {correction.overlay}
                {mergeError && (
                  <div
                    data-timeline-inspector="true"
                    role="alert"
                    style={{ position: 'fixed', left: '50%', bottom: 28, transform: 'translateX(-50%)', zIndex: 86, display: 'flex', alignItems: 'center', gap: 12, maxWidth: 'min(560px, calc(100vw - 48px))', borderRadius: 12, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', boxShadow: '0 12px 36px rgba(0,0,0,0.28)', padding: '10px 14px' }}
                  >
                    <span style={{ fontSize: 12.5, color: 'var(--color-text-primary)', fontWeight: 600, lineHeight: 1.4 }}>{mergeError}</span>
                    <button
                      type="button"
                      aria-label="Dismiss"
                      onClick={() => setMergeError(null)}
                      style={{ border: 'none', background: 'transparent', color: 'var(--color-text-tertiary)', fontSize: 14, fontWeight: 700, cursor: 'pointer', padding: 0, lineHeight: 1, flexShrink: 0 }}
                    >
                      ×
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
