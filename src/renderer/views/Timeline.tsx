import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ANALYTICS_EVENT, blockCountBucket, trackedTimeBucket } from '@shared/analytics'
import type { AIDaySummaryResult, AISurfaceSummary, AppCategory, DayTimelinePayload, TimelineGapSegment, TimelineSegment, WorkContextBlock } from '@shared/types'
import AppIcon from '../components/AppIcon'
import EntityIcon from '../components/EntityIcon'
import InlineRevealText from '../components/InlineRevealText'
import { useProjectionResource } from '../hooks/useProjectionResource'
import { track } from '../lib/analytics'
import { ipc } from '../lib/ipc'
import { formatDisplayAppName } from '../lib/apps'
import { formatDuration, formatFullDate, todayString } from '../lib/format'
import { openArtifact } from '../lib/openTarget'

const CATEGORY_COLORS: Record<AppCategory, string> = {
  development: '#5b8cff',
  communication: '#f97316',
  research: '#7c5cff',
  writing: '#a855f7',
  aiTools: '#c084fc',
  design: '#ec4899',
  browsing: '#fb923c',
  meetings: '#14b8a6',
  entertainment: '#f59e0b',
  email: '#38bdf8',
  productivity: '#6366f1',
  social: '#f43f5e',
  system: '#94a3b8',
  uncategorized: '#94a3b8',
}

function shiftDate(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const next = new Date(y, m - 1, d + days)
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`
}

function getWeekStart(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const next = new Date(y, m - 1, d)
  const day = next.getDay()
  const diff = day === 0 ? -6 : 1 - day
  next.setDate(next.getDate() + diff)
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`
}

function weekRangeLabel(dateStr: string): string {
  const start = getWeekStart(dateStr)
  const end = shiftDate(start, 6)
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

function blockDurationSeconds(block: WorkContextBlock): number {
  return Math.max(1, Math.round((block.endTime - block.startTime) / 1000))
}

function segmentDurationSeconds(segment: TimelineSegment): number {
  return Math.max(1, Math.round((segment.endTime - segment.startTime) / 1000))
}

function categoryLabel(category: AppCategory): string {
  if (category === 'aiTools') return 'AI tools'
  return category
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function shortDomainLabel(domain: string): string {
  return domain.replace(/^www\./i, '')
}

function artifactSubtitle(block: WorkContextBlock): string | null {
  const titles = block.topArtifacts
    .slice(0, 3)
    .map((artifact) => artifact.displayTitle.trim())
    .filter(Boolean)

  if (titles.length > 0) return titles.join(' • ')

  const domains = block.websites
    .slice(0, 3)
    .map((site) => shortDomainLabel(site.domain))
    .filter(Boolean)

  return domains.length > 0 ? domains.join(' • ') : null
}

function blockNarrative(block: WorkContextBlock): string | null {
  return block.label.narrative?.trim() || null
}

function gapKindLabel(kind: TimelineGapSegment['kind']): string {
  if (kind === 'machine_off') return 'Machine off'
  if (kind === 'away') return 'Away'
  return 'Untracked gap'
}

type DisplayTimelineSegment = TimelineSegment | {
  kind: 'gap_group'
  startTime: number
  endTime: number
  items: TimelineGapSegment[]
}

const LONG_GAP_ANCHOR_SECONDS = 75 * 60

function compressTimelineSegments(segments: TimelineSegment[]): DisplayTimelineSegment[] {
  const compressed: DisplayTimelineSegment[] = []
  let gapCluster: TimelineGapSegment[] = []

  const flushGapCluster = () => {
    if (gapCluster.length === 0) return

    if (gapCluster.length >= 2) {
      compressed.push({
        kind: 'gap_group',
        startTime: gapCluster[0].startTime,
        endTime: gapCluster[gapCluster.length - 1].endTime,
        items: gapCluster,
      })
    } else {
      compressed.push(...gapCluster)
    }

    gapCluster = []
  }

  for (const segment of segments) {
    if (segment.kind === 'work_block') {
      flushGapCluster()
      compressed.push(segment)
      continue
    }

    if (segmentDurationSeconds(segment) >= LONG_GAP_ANCHOR_SECONDS) {
      flushGapCluster()
      compressed.push(segment)
      continue
    }

    gapCluster.push(segment)
  }

  flushGapCluster()
  return compressed
}

interface TimelineNavState {
  view: 'day' | 'week'
  date: string
}

function timelineNavStateFromParams(searchParams: URLSearchParams): TimelineNavState {
  return {
    view: searchParams.get('view') === 'week' ? 'week' : 'day',
    date: searchParams.get('date') ?? todayString(),
  }
}

function currentLiveLabel(blocks: WorkContextBlock[]): string | null {
  const live = blocks.find((block) => block.isLive)
  return live ? live.label.current : null
}

function IconChevronLeft() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="m10 3.5-4.5 4.5 4.5 4.5" />
    </svg>
  )
}

function IconChevronRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  )
}

function SummaryStrip({ payload }: { payload: DayTimelinePayload }) {
  const liveLabel = currentLiveLabel(payload.blocks)

  return (
    <div style={{
      display: 'flex',
      flexWrap: 'wrap',
      gap: '6px 14px',
      padding: '0 0 18px',
      fontSize: 12.5,
      color: 'var(--color-text-tertiary)',
    }}>
      <span>
        <strong style={{ color: 'var(--color-text-primary)' }}>{formatDuration(payload.totalSeconds)}</strong> tracked
      </span>
      <span>
        <strong style={{ color: 'var(--color-text-primary)' }}>{formatDuration(payload.focusSeconds)}</strong> focused
      </span>
      <span>{payload.blocks.length} block{payload.blocks.length !== 1 ? 's' : ''}</span>
      <span>{payload.appCount} app{payload.appCount !== 1 ? 's' : ''}</span>
      <span>{payload.siteCount} site{payload.siteCount !== 1 ? 's' : ''}</span>
      {liveLabel && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#22c55e', fontWeight: 600 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
          Live now: {liveLabel}
        </span>
      )}
    </div>
  )
}

function TimelineRow({
  segment,
  block,
  isSelected,
  onSelect,
}: {
  segment: TimelineSegment
  block: WorkContextBlock | null
  isSelected: boolean
  onSelect: () => void
}) {
  const duration = formatDuration(segmentDurationSeconds(segment))

  if (!block) {
    const gapSegment = segment as TimelineGapSegment

    return (
      <div style={{ display: 'grid', gridTemplateColumns: '104px minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
        <div style={{ paddingTop: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)' }}>{formatClockTime(gapSegment.startTime)}</div>
          <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{duration}</div>
        </div>
        <div style={{
          borderTop: '1px solid var(--color-border-ghost)',
          paddingTop: 10,
          minHeight: 42,
          color: 'var(--color-text-tertiary)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}>
          <span style={{ fontSize: 12.5 }}>{gapKindLabel(gapSegment.kind)}</span>
          <span style={{ fontSize: 11 }}>{formatClockTime(gapSegment.endTime)}</span>
        </div>
      </div>
    )
  }

  const accent = CATEGORY_COLORS[block.dominantCategory] ?? CATEGORY_COLORS.uncategorized
  const artifactLine = artifactSubtitle(block)
  const appsLine = block.topApps
    .slice(0, 3)
    .map((app) => formatDisplayAppName(app.appName))
    .join(' • ')

  return (
    <button
      type="button"
      data-timeline-block-id={block.id}
      onClick={onSelect}
      style={{
        display: 'grid',
        gridTemplateColumns: '104px minmax(0, 1fr)',
        gap: 16,
        alignItems: 'start',
        width: '100%',
        border: 'none',
        background: 'transparent',
        padding: 0,
        textAlign: 'left',
        cursor: 'pointer',
      }}
    >
      <div style={{ paddingTop: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-primary)' }}>{formatClockTime(block.startTime)}</div>
        <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
          {duration}
        </div>
      </div>
      <div style={{
        position: 'relative',
        padding: '14px 16px 14px 18px',
        borderRadius: 16,
        border: isSelected ? `1px solid ${accent}55` : '1px solid var(--color-border-ghost)',
        background: isSelected ? 'var(--color-surface-low)' : 'var(--color-surface)',
        boxShadow: isSelected ? '0 10px 30px rgba(0,0,0,0.10)' : 'none',
        transition: 'border-color 120ms, background 120ms',
        overflow: 'hidden',
        minWidth: 0,
      }}>
        <div style={{
          position: 'absolute',
          left: 0,
          top: 12,
          bottom: 12,
          width: 3,
          borderRadius: 999,
          background: accent,
        }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, marginBottom: 6 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <InlineRevealText
              text={block.label.current}
              style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)', lineHeight: 1.25 }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <span style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: accent,
              background: `${accent}18`,
              borderRadius: 999,
              padding: '3px 7px',
            }}>
              {categoryLabel(block.dominantCategory)}
            </span>
            {block.isLive && (
              <span style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: '#22c55e',
              }}>
                Live
              </span>
            )}
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 8 }}>
          {formatClockTime(block.startTime)} – {formatClockTime(block.endTime)}
        </div>
        {blockNarrative(block) && (
          <p style={{ fontSize: 13.5, lineHeight: 1.6, color: 'var(--color-text-secondary)', margin: '0 0 10px', overflowWrap: 'break-word', minWidth: 0 }}>
            {blockNarrative(block)}
          </p>
        )}
        {artifactLine && (
          <InlineRevealText
            text={artifactLine}
            style={{ fontSize: 12.5, color: 'var(--color-text-primary)', marginBottom: appsLine ? 6 : 0 }}
          />
        )}
        {appsLine && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {block.topApps.slice(0, 2).map((app) => (
                <AppIcon
                  key={`${block.id}:${app.bundleId}`}
                  bundleId={app.bundleId}
                  appName={app.appName}
                  size={18}
                  fontSize={9}
                  color={accent}
                />
              ))}
            </div>
            <InlineRevealText
              text={appsLine}
              style={{ fontSize: 12, color: 'var(--color-text-tertiary)', flex: 1 }}
            />
          </div>
        )}
      </div>
    </button>
  )
}

function GapGroupRow({ segment }: { segment: Extract<DisplayTimelineSegment, { kind: 'gap_group' }> }) {
  const duration = formatDuration(Math.max(1, Math.round((segment.endTime - segment.startTime) / 1000)))
  const totals = segment.items.reduce<Map<TimelineGapSegment['kind'], number>>((map, item) => {
    map.set(item.kind, (map.get(item.kind) ?? 0) + segmentDurationSeconds(item))
    return map
  }, new Map())

  const chips = (['machine_off', 'away', 'idle_gap'] as const)
    .filter((kind) => totals.has(kind))
    .map((kind) => ({
      kind,
      label: gapKindLabel(kind),
      duration: formatDuration(totals.get(kind) ?? 0),
    }))

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '104px minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
      <div style={{ paddingTop: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)' }}>{formatClockTime(segment.startTime)}</div>
        <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{duration}</div>
      </div>
      <div style={{
        borderTop: '1px solid var(--color-border-ghost)',
        paddingTop: 10,
        minHeight: 48,
        display: 'grid',
        gap: 8,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
            Compressed low-activity gap
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
            {formatClockTime(segment.endTime)}
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {chips.map((chip) => (
            <span
              key={`${segment.startTime}:${chip.kind}`}
              style={{
                borderRadius: 999,
                padding: '4px 8px',
                background: 'var(--color-surface-low)',
                color: 'var(--color-text-secondary)',
                fontSize: 11.5,
              }}
            >
              {chip.label} {chip.duration}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

const daySummaryRecapCache = new Map<string, AIDaySummaryResult>()

function DaySummaryInspector({ payload }: { payload: DayTimelinePayload }) {
  const [recap, setRecap] = useState<AIDaySummaryResult | null>(null)
  const [recapLoading, setRecapLoading] = useState(false)

  useEffect(() => {
    if (payload.totalSeconds === 0) return
    const cached = daySummaryRecapCache.get(payload.date)
    if (cached) { setRecap(cached); return }
    setRecapLoading(true)
    ipc.ai.generateDaySummary(payload.date)
      .then((result) => {
        daySummaryRecapCache.set(payload.date, result)
        setRecap(result)
      })
      .catch(() => { /* silently skip on error */ })
      .finally(() => setRecapLoading(false))
  }, [payload.date, payload.totalSeconds])

  const topCategories = Array.from(payload.blocks.reduce<Map<AppCategory, number>>((map, block) => {
    map.set(block.dominantCategory, (map.get(block.dominantCategory) ?? 0) + blockDurationSeconds(block))
    return map
  }, new Map()).entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)

  const headlineBlocks = payload.blocks.slice(0, 3)

  return (
    <div style={{
      position: 'sticky',
      top: 24,
      maxHeight: 'calc(100vh - 140px)',
      overflowY: 'auto',
      borderRadius: 18,
      border: '1px solid var(--color-border-ghost)',
      background: 'var(--color-surface)',
      padding: 22,
      display: 'grid',
      gap: 18,
    }}>
      <div>
        <div style={{ fontSize: 18, fontWeight: 750, color: 'var(--color-text-primary)', marginBottom: 6 }}>
          Day summary
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>
          {formatFullDate(payload.date)}
        </div>
      </div>

      {recapLoading && (
        <div style={{
          borderRadius: 10,
          background: 'var(--color-surface-low)',
          padding: '14px 16px',
          display: 'grid',
          gap: 8,
        }}>
          {[100, 80, 60].map((w) => (
            <div
              key={w}
              style={{
                height: 11,
                borderRadius: 5,
                background: 'var(--color-surface-high)',
                width: `${w}%`,
                opacity: 0.6,
              }}
            />
          ))}
        </div>
      )}

      {recap && recap.summary && (
        <div style={{
          fontSize: 13,
          lineHeight: 1.7,
          color: 'var(--color-text-secondary)',
        }}>
          {recap.summary}
        </div>
      )}

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gap: 10,
      }}>
        <div style={{ borderRadius: 14, background: 'var(--color-surface-low)', padding: '12px 14px' }}>
          <div style={{ fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 6 }}>
            Tracked
          </div>
          <div style={{ fontSize: 19, fontWeight: 760, color: 'var(--color-text-primary)' }}>{formatDuration(payload.totalSeconds)}</div>
        </div>
        <div style={{ borderRadius: 14, background: 'var(--color-surface-low)', padding: '12px 14px' }}>
          <div style={{ fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 6 }}>
            Focus
          </div>
          <div style={{ fontSize: 19, fontWeight: 760, color: 'var(--color-text-primary)' }}>{payload.focusPct}%</div>
        </div>
      </div>

      {headlineBlocks.length > 0 && (
        <section>
          <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 10 }}>
            Main blocks
          </div>
          <div style={{ display: 'grid', gap: 10 }}>
            {headlineBlocks.map((block) => (
              <div key={block.id} style={{ display: 'flex', gap: 10, minWidth: 0 }}>
                <div
                  style={{
                    width: 3,
                    borderRadius: 999,
                    background: CATEGORY_COLORS[block.dominantCategory] ?? CATEGORY_COLORS.uncategorized,
                    flexShrink: 0,
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <InlineRevealText
                    text={block.label.current}
                    style={{ fontSize: 13.5, fontWeight: 620, color: 'var(--color-text-primary)' }}
                  />
                  <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                    {formatClockTime(block.startTime)} – {formatClockTime(block.endTime)} • {formatDuration(blockDurationSeconds(block))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {topCategories.length > 0 && (
        <section>
          <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 10 }}>
            Where the day went
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            {topCategories.map(([category, seconds]) => (
              <div key={category} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: CATEGORY_COLORS[category] ?? CATEGORY_COLORS.uncategorized,
                    flexShrink: 0,
                  }} />
                  <span style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>{categoryLabel(category)}</span>
                </div>
                <span style={{ fontSize: 12, color: 'var(--color-text-primary)', whiteSpace: 'nowrap' }}>{formatDuration(seconds)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function BlockInspector({ block, payload }: { block: WorkContextBlock | null; payload: DayTimelinePayload }) {
  const [overrideDraft, setOverrideDraft] = useState('')
  const [overrideSaving, setOverrideSaving] = useState(false)

  useEffect(() => {
    setOverrideDraft(block?.label.override ?? block?.label.current ?? '')
  }, [block?.id, block?.label.current, block?.label.override])

  if (!block) {
    return <DaySummaryInspector payload={payload} />
  }

  const accent = CATEGORY_COLORS[block.dominantCategory] ?? CATEGORY_COLORS.uncategorized
  const hasOverride = Boolean(block.label.override?.trim())

  return (
    <div data-timeline-inspector="true" style={{
      position: 'sticky',
      top: 24,
      maxHeight: 'calc(100vh - 140px)',
      overflowY: 'auto',
      borderRadius: 18,
      border: '1px solid var(--color-border-ghost)',
      background: 'var(--color-surface)',
      padding: 22,
    }}>
      <div style={{ marginBottom: 18 }}>
        <div
          title={block.label.current}
          style={{
            fontSize: 18,
            fontWeight: 750,
            color: 'var(--color-text-primary)',
            marginBottom: 6,
            lineHeight: 1.3,
            display: '-webkit-box',
            WebkitBoxOrient: 'vertical',
            WebkitLineClamp: 3,
            overflow: 'hidden',
            overflowWrap: 'break-word',
            wordBreak: 'break-word',
          }}
        >
          {block.label.current}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>
          {formatClockTime(block.startTime)} – {formatClockTime(block.endTime)} • {formatDuration(blockDurationSeconds(block))}
        </div>
      </div>

      {blockNarrative(block) && (
        <p style={{ fontSize: 13.5, lineHeight: 1.65, color: 'var(--color-text-secondary)', margin: '0 0 20px' }}>
          {blockNarrative(block)}
        </p>
      )}

      <div style={{ marginBottom: 20, display: 'grid', gap: 8 }}>
        <label htmlFor="timeline-block-label-override" style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 }}>
          Block label
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            id="timeline-block-label-override"
            type="text"
            value={overrideDraft}
            onChange={(event) => setOverrideDraft(event.target.value)}
            placeholder={block.label.current}
            style={{
              flex: 1,
              minWidth: 0,
              height: 34,
              borderRadius: 9,
              border: '1px solid var(--color-border-ghost)',
              background: 'var(--color-surface-high)',
              color: 'var(--color-text-primary)',
              padding: '0 12px',
              fontSize: 13,
              outline: 'none',
            }}
          />
          <button
            type="button"
            disabled={overrideSaving || !overrideDraft.trim() || overrideDraft.trim() === block.label.current}
            onClick={() => {
              const label = overrideDraft.trim()
              if (!label) return
              setOverrideSaving(true)
              void ipc.db.setBlockLabelOverride({
                blockId: block.id,
                label,
                narrative: block.label.narrative,
              }).finally(() => setOverrideSaving(false))
            }}
            style={{
              height: 34,
              padding: '0 14px',
              borderRadius: 9,
              border: 'none',
              background: 'var(--gradient-primary)',
              color: 'var(--color-primary-contrast)',
              fontSize: 12,
              fontWeight: 700,
              cursor: overrideSaving ? 'default' : 'pointer',
              opacity: overrideSaving || !overrideDraft.trim() || overrideDraft.trim() === block.label.current ? 0.6 : 1,
            }}
          >
            {overrideSaving ? 'Saving…' : 'Save'}
          </button>
          {hasOverride && (
            <button
              type="button"
              disabled={overrideSaving}
              onClick={() => {
                setOverrideSaving(true)
                void ipc.db.clearBlockLabelOverride(block.id)
                  .finally(() => setOverrideSaving(false))
              }}
              style={{
                height: 34,
                padding: '0 12px',
                borderRadius: 9,
                border: '1px solid var(--color-border-ghost)',
                background: 'var(--color-surface-high)',
                color: 'var(--color-text-secondary)',
                fontSize: 12,
                fontWeight: 700,
                cursor: overrideSaving ? 'default' : 'pointer',
                opacity: overrideSaving ? 0.6 : 1,
              }}
            >
              Reset
            </button>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gap: 18 }}>
        <section>
          <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 10 }}>
            Apps Used
          </div>
          <div style={{ display: 'grid', gap: 10 }}>
            {block.topApps.slice(0, 6).map((app) => (
              <div key={`${block.id}:${app.bundleId}`} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <AppIcon bundleId={app.bundleId} appName={app.appName} size={24} fontSize={10} color={accent} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <InlineRevealText
                    text={formatDisplayAppName(app.appName)}
                    style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}
                  />
                  <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>{categoryLabel(app.category)}</div>
                </div>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                  {formatDuration(app.totalSeconds)}
                </div>
              </div>
            ))}
          </div>
        </section>

        {block.topArtifacts.length > 0 && (
          <section>
            <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 10 }}>
              Key Artifacts
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              {block.topArtifacts.slice(0, 6).map((artifact) => (
                <button
                  key={artifact.id}
                  type="button"
                  onClick={() => void openArtifact(artifact)}
                  disabled={artifact.openTarget.kind === 'unsupported' || !artifact.openTarget.value}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'start',
                    justifyContent: 'space-between',
                    gap: 12,
                    padding: 0,
                    border: 'none',
                    background: 'transparent',
                    textAlign: 'left',
                    cursor: artifact.openTarget.kind === 'unsupported' || !artifact.openTarget.value ? 'default' : 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', gap: 10, minWidth: 0 }}>
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
                      size={28}
                    />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div
                        title={artifact.displayTitle}
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: 'var(--color-text-primary)',
                          lineHeight: 1.35,
                          display: '-webkit-box',
                          WebkitBoxOrient: 'vertical',
                          WebkitLineClamp: 2,
                          overflow: 'hidden',
                          overflowWrap: 'break-word',
                          wordBreak: 'break-word',
                        }}
                      >
                        {artifact.displayTitle}
                      </div>
                      {(artifact.subtitle || artifact.host || artifact.path) && (
                        <InlineRevealText
                          text={artifact.subtitle || artifact.host || artifact.path || ''}
                          style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 2 }}
                        />
                      )}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
                    {formatDuration(artifact.totalSeconds)}
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {block.websites.length > 0 && (
          <section>
            <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 10 }}>
              Websites
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {block.websites.slice(0, 6).map((site) => (
                <span
                  key={`${block.id}:${site.domain}`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    borderRadius: 999,
                    padding: '6px 10px',
                    background: 'var(--color-surface-low)',
                    color: 'var(--color-text-secondary)',
                    fontSize: 12,
                  }}
                >
                  <EntityIcon artifactType="page" domain={site.domain} title={site.domain} size={18} />
                  {shortDomainLabel(site.domain)} • {formatDuration(site.totalSeconds)}
                </span>
              ))}
            </div>
          </section>
        )}

        {block.workflowRefs.length > 0 && (
          <section>
            <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 10 }}>
              Workflow Clues
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {block.workflowRefs.slice(0, 4).map((workflow) => (
                <div key={workflow.id} style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
                  {workflow.label}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

interface WeekDaySummary {
  date: string
  totalSeconds: number
  focusSeconds: number
  focusPct: number
  categories: Array<{ category: AppCategory; seconds: number }>
  blockCount: number
  topLabels: string[]
}

function WeekView({
  selectedDate,
  onSelectDate,
}: {
  selectedDate: string
  onSelectDate: (date: string) => void
}) {
  const [hoveredDate, setHoveredDate] = useState<string | null>(null)
  const [hoveredStack, setHoveredStack] = useState<{ date: string; category: AppCategory; seconds: number } | null>(null)
  const weekStart = getWeekStart(selectedDate)
  const today = todayString()
  const includesToday = Array.from({ length: 7 }, (_, index) => shiftDate(weekStart, index)).includes(today)

  const weekResource = useProjectionResource<WeekDaySummary[]>({
    scope: 'timeline',
    dependencies: [weekStart],
    intervalMs: includesToday ? 30_000 : 0,
    load: async () => {
      const dates = Array.from({ length: 7 }, (_, index) => shiftDate(weekStart, index))
      const days = await Promise.all(dates.map((date) => ipc.db.getTimelineDay(date)))
      return days.map((payload) => {
        const categories = new Map<AppCategory, number>()
        for (const block of payload.blocks) {
          categories.set(block.dominantCategory, (categories.get(block.dominantCategory) ?? 0) + blockDurationSeconds(block))
        }
        return {
          date: payload.date,
          totalSeconds: payload.totalSeconds,
          focusSeconds: payload.focusSeconds,
          focusPct: payload.focusPct,
          categories: [...categories.entries()]
            .sort((left, right) => right[1] - left[1])
            .map(([category, seconds]) => ({ category, seconds })),
          blockCount: payload.blocks.length,
          topLabels: payload.blocks
            .slice(0, 3)
            .map((block) => block.label.current)
            .filter(Boolean),
        }
      })
    },
  })
  const weekReviewResource = useProjectionResource<AISurfaceSummary | null>({
    scope: 'timeline',
    dependencies: [weekStart],
    load: () => ipc.ai.getWeekReview(weekStart).catch(() => null),
  })

  const data = weekResource.data ?? []
  const weekReview = weekReviewResource.data ?? null
  const maxSeconds = data.length > 0 ? Math.max(...data.map((day) => day.totalSeconds), 1) : 1
  const activeDays = data.filter((day) => day.totalSeconds > 0)
  const totalWeekSeconds = activeDays.reduce((sum, day) => sum + day.totalSeconds, 0)
  const averageTrackedSeconds = activeDays.length > 0 ? Math.round(totalWeekSeconds / activeDays.length) : 0
  const bestDay = activeDays.length > 0
    ? activeDays.reduce((best, day) => day.focusPct > best.focusPct ? day : best)
    : null
  const topWeekCategory = Array.from(activeDays.reduce<Map<AppCategory, number>>((map, day) => {
    for (const category of day.categories) {
      map.set(category.category, (map.get(category.category) ?? 0) + category.seconds)
    }
    return map
  }, new Map()).entries())
    .sort((left, right) => right[1] - left[1])[0] ?? null
  const activeDay = data.find((day) => day.date === hoveredDate)
    ?? data.find((day) => day.date === selectedDate)
    ?? activeDays[0]
    ?? null

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 10 }}>
        {data.map((day) => {
          const [y, m, d] = day.date.split('-').map(Number)
          const isSelected = day.date === selectedDate
          const isToday = day.date === today
          const height = Math.max(14, (day.totalSeconds / maxSeconds) * 148)

          return (
            <button
              key={day.date}
              type="button"
              onClick={() => onSelectDate(day.date)}
              onMouseEnter={() => setHoveredDate(day.date)}
              style={{
                border: isSelected ? '1px solid var(--color-border-ghost)' : '1px solid transparent',
                background: isToday || isSelected ? 'var(--color-surface-low)' : 'transparent',
                borderRadius: 14,
                padding: '12px 8px 10px',
                cursor: 'pointer',
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)' }}>
                {new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(y, m - 1, d))}
              </div>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--color-text-primary)', marginTop: 2 }}>
                {d}
              </div>
              <div style={{
                height: 168,
                display: 'flex',
                alignItems: 'end',
                  justifyContent: 'center',
                  marginTop: 10,
                }}>
                <div style={{
                  width: 76,
                  height,
                  borderRadius: 12,
                  background: 'var(--color-surface)',
                  border: '1px solid var(--color-border-ghost)',
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'end',
                }}>
                  {day.categories.slice(0, 4).map((category, index, array) => {
                    const total = array.reduce((sum, item) => sum + item.seconds, 0) || 1
                    const segmentHeight = `${Math.max(8, (category.seconds / total) * 100)}%`
                    return (
                      <div
                        key={`${day.date}:${category.category}`}
                        onMouseEnter={(event) => {
                          event.stopPropagation()
                          setHoveredDate(day.date)
                          setHoveredStack({ date: day.date, category: category.category, seconds: category.seconds })
                        }}
                        onMouseLeave={() => setHoveredStack((current) => current?.date === day.date && current.category === category.category ? null : current)}
                        style={{
                          height: segmentHeight,
                          background: CATEGORY_COLORS[category.category],
                          opacity: 1 - (index * 0.08),
                        }}
                      />
                    )
                  })}
                </div>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--color-text-secondary)', marginTop: 8 }}>
                {day.totalSeconds > 0 ? formatDuration(day.totalSeconds) : 'No data'}
              </div>
            </button>
          )
        })}
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
            <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 6 }}>
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
            <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 6 }}>
              Average tracked day
            </div>
            <div style={{ fontSize: 24, fontWeight: 780, color: 'var(--color-text-primary)' }}>
              {activeDays.length > 0 ? formatDuration(averageTrackedSeconds) : '0m'}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
              Across tracked days only
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 6 }}>
              Best focus
            </div>
            <div style={{ fontSize: 24, fontWeight: 780, color: 'var(--color-text-primary)' }}>
              {bestDay ? `${bestDay.focusPct}%` : '0%'}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
              {bestDay ? formatFullDate(bestDay.date) : 'No focused blocks yet'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 6 }}>
              Main mode
            </div>
            <div style={{ fontSize: 16, fontWeight: 760, color: 'var(--color-text-primary)' }}>
              {topWeekCategory ? categoryLabel(topWeekCategory[0]) : 'No data'}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
              {topWeekCategory ? formatDuration(topWeekCategory[1]) : 'Waiting for tracked time'}
            </div>
          </div>
        </div>

        {(weekReviewResource.loading || weekReview) && (
          <div style={{
            borderTop: '1px solid var(--color-border-ghost)',
            paddingTop: 14,
            display: 'grid',
            gap: 8,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)' }}>
                Week Review
              </div>
              <button
                type="button"
                onClick={() => void weekReviewResource.refresh()}
                style={{
                  padding: '6px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--color-border-ghost)',
                  background: 'var(--color-surface-low)',
                  color: 'var(--color-text-secondary)',
                  fontSize: 11.5,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Refresh
              </button>
            </div>
            <div style={{ fontSize: 13.5, lineHeight: 1.7, color: 'var(--color-text-secondary)' }}>
              {weekReviewResource.loading && !weekReview
                ? 'Generating a grounded review for this week…'
                : weekReview?.summary}
            </div>
            {weekReview?.stale && (
              <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
                Showing the last saved review while newer activity catches up.
              </div>
            )}
          </div>
        )}

        {activeDay && (
          <div style={{
            borderTop: '1px solid var(--color-border-ghost)',
            paddingTop: 14,
            display: 'grid',
            gap: 10,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 730, color: 'var(--color-text-primary)' }}>
                  {formatFullDate(activeDay.date)}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
                  {formatDuration(activeDay.totalSeconds)} tracked • {formatDuration(activeDay.focusSeconds)} focused • {activeDay.blockCount} block{activeDay.blockCount !== 1 ? 's' : ''}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onSelectDate(activeDay.date)}
                style={{
                  padding: '7px 12px',
                  borderRadius: 8,
                  border: '1px solid var(--color-border-ghost)',
                  background: 'var(--color-surface-low)',
                  color: 'var(--color-text-primary)',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Open day
              </button>
            </div>

            {activeDay.topLabels.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {activeDay.topLabels.map((label, index) => (
                  <span
                    key={`${activeDay.date}:${index}:${label}`}
                    style={{
                      borderRadius: 999,
                      padding: '5px 9px',
                      background: 'var(--color-surface-low)',
                      color: 'var(--color-text-secondary)',
                      fontSize: 11.5,
                    }}
                  >
                    {label}
                  </span>
                ))}
              </div>
            )}

            {activeDay.categories.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {activeDay.categories.slice(0, 4).map((entry) => {
                  const highlighted = hoveredStack?.date === activeDay.date && hoveredStack.category === entry.category
                  return (
                    <span
                      key={`${activeDay.date}:${entry.category}`}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 7,
                        borderRadius: 999,
                        padding: '5px 10px',
                        background: highlighted ? `${CATEGORY_COLORS[entry.category]}20` : 'var(--color-surface-low)',
                        color: highlighted ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                        fontSize: 11.5,
                      }}
                    >
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: CATEGORY_COLORS[entry.category] }} />
                      {categoryLabel(entry.category)} {formatDuration(entry.seconds)}
                    </span>
                  )
                })}
              </div>
            )}

            {hoveredStack && hoveredStack.date === activeDay.date && (
              <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                Hovered segment: {categoryLabel(hoveredStack.category)} for {formatDuration(hoveredStack.seconds)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default function Timeline() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null)
  const [isCompact, setIsCompact] = useState(() => window.innerWidth < 1120)
  const [navState, setNavState] = useState<TimelineNavState>(() => timelineNavStateFromParams(searchParams))
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const lastTimelineOpenKeyRef = useRef<string | null>(null)
  const lastBlockOpenKeyRef = useRef<string | null>(null)

  const searchSignature = searchParams.toString()
  const view = navState.view
  const date = navState.date
  const isToday = date === todayString()

  useEffect(() => {
    const next = timelineNavStateFromParams(searchParams)
    setNavState((current) => (
      current.view === next.view && current.date === next.date
        ? current
        : next
    ))
  }, [searchSignature])

  useEffect(() => {
    const onResize = () => setIsCompact(window.innerWidth < 1120)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const timelineResource = useProjectionResource<DayTimelinePayload>({
    scope: 'timeline',
    enabled: view === 'day',
    dependencies: [date, view],
    intervalMs: isToday ? 30_000 : 0,
    load: () => ipc.db.getTimelineDay(date),
  })

  const payload = timelineResource.data?.date === date ? timelineResource.data : null
  const error = timelineResource.error
  const loading = view === 'day' && (!payload || timelineResource.loading)

  const blockMap = useMemo(() => {
    const map = new Map<string, WorkContextBlock>()
    for (const block of payload?.blocks ?? []) {
      map.set(block.id, block)
    }
    return map
  }, [payload])

  useEffect(() => {
    if (!selectedBlockId) return
    if (blockMap.has(selectedBlockId)) return
    setSelectedBlockId(null)
  }, [payload, selectedBlockId, blockMap])

  useEffect(() => {
    setSelectedBlockId(null)
  }, [date])

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    node.scrollTop = 0
  }, [view, date])

  useEffect(() => {
    const openKey = view === 'week'
      ? `week:${date}`
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

  const selectedBlock = selectedBlockId ? blockMap.get(selectedBlockId) ?? null : null
  const displaySegments = useMemo(
    () => compressTimelineSegments(payload?.segments ?? []),
    [payload],
  )

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

  function setView(nextView: 'day' | 'week') {
    updateNavState({ view: nextView, date })
  }

  function setDate(nextDate: string) {
    updateNavState({ view, date: nextDate })
  }

  const forwardDisabled = view === 'day'
    ? isToday
    : getWeekStart(date) === getWeekStart(todayString())

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{
        position: 'sticky',
        top: 0,
        zIndex: 10,
        background: 'var(--color-bg)',
        borderBottom: '1px solid var(--color-border-ghost)',
        padding: '20px 32px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            onClick={() => setDate(view === 'week' ? shiftDate(getWeekStart(date), -7) : shiftDate(date, -1))}
            style={{
              width: 32,
              height: 32,
              borderRadius: 999,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: 'var(--color-text-secondary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <IconChevronLeft />
          </button>
          <div style={{
            minWidth: 156,
            textAlign: 'center',
            padding: '8px 16px',
            borderRadius: 999,
            border: '1px solid var(--color-border-ghost)',
            background: 'var(--color-surface)',
            fontSize: 13,
            fontWeight: 700,
            color: 'var(--color-text-primary)',
          }}>
            {view === 'week' ? weekRangeLabel(date) : isToday ? 'Today' : formatFullDate(date)}
          </div>
          <button
            type="button"
            onClick={() => {
              if (!forwardDisabled) {
                setDate(view === 'week' ? shiftDate(getWeekStart(date), 7) : shiftDate(date, 1))
              }
            }}
            disabled={forwardDisabled}
            style={{
              width: 32,
              height: 32,
              borderRadius: 999,
              border: 'none',
              background: 'transparent',
              cursor: forwardDisabled ? 'default' : 'pointer',
              color: 'var(--color-text-secondary)',
              opacity: forwardDisabled ? 0.3 : 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <IconChevronRight />
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {(view === 'day' ? !isToday : getWeekStart(date) !== getWeekStart(todayString())) && (
            <button
              type="button"
              onClick={() => setDate(todayString())}
              style={{
                padding: '7px 12px',
                borderRadius: 8,
                border: '1px solid var(--color-border-ghost)',
                background: 'var(--color-surface)',
                color: 'var(--color-text-secondary)',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Today
            </button>
          )}
          <div style={{
            display: 'flex',
            gap: 3,
            padding: 3,
            borderRadius: 9,
            background: 'var(--color-surface-high)',
            border: '1px solid var(--color-border-ghost)',
          }}>
            {(['day', 'week'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setView(mode)}
                style={{
                  padding: '4px 12px',
                  borderRadius: 7,
                  border: 'none',
                  cursor: 'pointer',
                  background: view === mode ? 'var(--gradient-primary)' : 'transparent',
                  color: view === mode ? 'var(--color-primary-contrast)' : 'var(--color-text-secondary)',
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {mode === 'day' ? 'Day' : 'Week'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto' }}>
        {view === 'week' && (
          <div style={{ padding: '24px 32px 40px' }}>
            <WeekView
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
                  <div key={index} style={{ display: 'grid', gridTemplateColumns: '104px minmax(0, 1fr)', gap: 16 }}>
                    <div style={{ height: 20, borderRadius: 8, background: 'var(--color-surface-low)', opacity: 0.5 }} />
                    <div style={{ height: 110 - (index * 10), borderRadius: 16, background: 'var(--color-surface-low)', opacity: 0.5 }} />
                  </div>
                ))}
              </div>
            )}

            {!error && !loading && payload && (
              <>
                <SummaryStrip payload={payload} />

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
                }}
                  onClickCapture={(event) => {
                    const target = event.target as HTMLElement | null
                    if (target?.closest('[data-timeline-inspector="true"]')) {
                      return
                    }
                    const blockButton = target?.closest<HTMLElement>('[data-timeline-block-id]')
                    const nextSelectedId = blockButton?.dataset.timelineBlockId ?? null
                    if (nextSelectedId !== selectedBlockId) {
                      setSelectedBlockId(nextSelectedId)
                    }
                  }}>
                    <div style={{ display: 'grid', gap: 14 }}>
                      {displaySegments.map((segment) => (
                        segment.kind === 'gap_group' ? (
                          <GapGroupRow
                            key={`gap-group:${segment.startTime}:${segment.endTime}`}
                            segment={segment}
                          />
                        ) : (
                          <TimelineRow
                            key={segment.kind === 'work_block' ? segment.blockId : `${segment.kind}:${segment.startTime}:${segment.endTime}`}
                            segment={segment}
                            block={segment.kind === 'work_block' ? blockMap.get(segment.blockId) ?? null : null}
                            isSelected={segment.kind === 'work_block' && selectedBlockId === segment.blockId}
                            onSelect={() => {
                              if (segment.kind === 'work_block') {
                                setSelectedBlockId(segment.blockId)
                              }
                            }}
                          />
                        )
                      ))}
                    </div>
                    <BlockInspector block={selectedBlock} payload={payload} />
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
