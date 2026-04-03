import { useEffect, useMemo, useRef, useState } from 'react'
import AppIcon from '../AppIcon'
import { ipc } from '../../lib/ipc'
import { formatDuration, todayString } from '../../lib/format'
import type {
  AppCategory,
  HistoryDayPayload,
  WorkContextBlock,
  WorkContextInsight,
} from '@shared/types'

const CALENDAR_HOUR_HEIGHT = 80
const TIME_AXIS_WIDTH = 56
const RANGE_PADDING_MS = 30 * 60_000
const BLOCK_INSIGHT_TIMEOUT_MS = 12_000
const REANALYZE_INTERVAL_MS = 30 * 60_000
const MIN_BLOCK_HEIGHT = 20
const DETAILS_PANEL_BREAKPOINT = 1260

// Module-level cache survives component remounts and day switches.
const _insightCache: Record<string, WorkContextInsight> = {}
const _lastAnalyzedAt: Record<string, number> = {}

const FILTER_PILLS = [
  { key: 'all', label: 'All' },
  { key: 'development', label: 'Focus Work' },
  { key: 'meetings', label: 'Meetings' },
  { key: 'communication', label: 'Communication' },
  { key: 'browsing', label: 'Browsing' },
] as const

const GENERIC_LABELS = new Set([
  'AI Tools',
  'Browsing',
  'Communication',
  'Design',
  'Development',
  'Email',
  'Insufficient Data',
  'Insufficient Data For Label',
  'Mixed Work',
  'Productivity',
  'Research',
  'Research & AI Chat',
  'System',
  'Uncategorized',
  'Web Session',
  'Writing',
])

const CATEGORY_COLORS: Record<AppCategory, string> = {
  development: '#6a91ff',
  communication: '#ff7a59',
  research: '#7e63ff',
  writing: '#c084fc',
  aiTools: '#d86cff',
  design: '#ff6bb0',
  browsing: '#f97316',
  meetings: '#14b8a6',
  entertainment: '#f59e0b',
  email: '#38bdf8',
  productivity: '#4f46e5',
  social: '#fb7185',
  system: '#94a3b8',
  uncategorized: '#94a3b8',
}

type FilterKey = typeof FILTER_PILLS[number]['key']

interface TimelineDayViewProps {
  payload: HistoryDayPayload
  date: string
  activeFilter: FilterKey
  onFilterChange: (filter: FilterKey) => void
}

function withAlpha(hex: string, alpha: number): string {
  const normalized = hex.replace('#', '')
  const expanded = normalized.length === 3
    ? normalized.split('').map((part) => `${part}${part}`).join('')
    : normalized
  const value = Number.parseInt(expanded, 16)
  const red = (value >> 16) & 255
  const green = (value >> 8) & 255
  const blue = value & 255
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

function shortDomainLabel(domain: string): string {
  const mapping: Record<string, string> = {
    'x.com': 'X.com',
    'twitter.com': 'X.com',
    'youtube.com': 'YouTube',
    'github.com': 'GitHub',
    'mail.google.com': 'Gmail',
    'gmail.com': 'Gmail',
    'docs.google.com': 'Google Docs',
    'meet.google.com': 'Google Meet',
    'calendar.google.com': 'Google Calendar',
    'drive.google.com': 'Google Drive',
    'reddit.com': 'Reddit',
    'stackoverflow.com': 'Stack Overflow',
    'linkedin.com': 'LinkedIn',
    'slack.com': 'Slack',
    'figma.com': 'Figma',
    'chatgpt.com': 'ChatGPT',
    'chat.openai.com': 'ChatGPT',
    'claude.ai': 'Claude',
    'discord.com': 'Discord',
  }

  if (mapping[domain]) return mapping[domain]
  const suffixMatch = Object.entries(mapping).find(([key]) => domain.endsWith(`.${key}`))
  if (suffixMatch) return suffixMatch[1]

  const stripped = domain.startsWith('www.') ? domain.slice(4) : domain
  const base = stripped.split('.')[0] ?? stripped
  return base ? `${base[0].toUpperCase()}${base.slice(1)}` : domain
}

function categoryLabel(category: AppCategory): string {
  if (category === 'aiTools') return 'AI Tools'
  return category
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (match) => match.toUpperCase())
}

function formatHourLabel(date: Date): string {
  const hour = date.getHours()
  if (hour === 0) return '12 AM'
  if (hour === 12) return '12 PM'
  if (hour < 12) return `${hour} AM`
  return `${hour - 12} PM`
}

function formatClockTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp)
}

function formatShortBlockDuration(block: WorkContextBlock): string {
  return formatDuration(Math.round((block.endTime - block.startTime) / 1000))
}

function formatBlockRange(block: WorkContextBlock): string {
  return `${formatClockTime(block.startTime)} - ${formatClockTime(block.endTime)}`
}

function blockHeightFor(block: WorkContextBlock, hourHeight: number): number {
  return Math.max(MIN_BLOCK_HEIGHT, ((block.endTime - block.startTime) / 3_600_000) * hourHeight - 2)
}

function meaningfulApps(block: WorkContextBlock) {
  return block.topApps.filter((app) => !app.isBrowser && app.category !== 'system' && app.category !== 'uncategorized')
}

function visibleLabel(block: WorkContextBlock, insight?: WorkContextInsight | null): string {
  const insightLabel = insight?.label?.trim()
  if (insightLabel && !GENERIC_LABELS.has(insightLabel)) return insightLabel

  const aiLabel = block.aiLabel?.trim()
  if (aiLabel && !GENERIC_LABELS.has(aiLabel)) return aiLabel

  const ruleLabel = block.ruleBasedLabel.trim()
  if (ruleLabel && !GENERIC_LABELS.has(ruleLabel)) return ruleLabel

  const websiteLabels = block.websites
    .map((site) => shortDomainLabel(site.domain))
    .filter((label, index, labels) => labels.indexOf(label) === index)
  if (websiteLabels.length >= 2) return `${websiteLabels[0]} + ${websiteLabels[1]}`
  if (websiteLabels.length === 1) return websiteLabels[0]

  const apps = meaningfulApps(block)
  if (apps.length >= 2) return `${apps[0].appName} + ${apps[1].appName}`
  if (apps.length === 1) return apps[0].appName

  return categoryLabel(block.dominantCategory)
}

function localNarrative(block: WorkContextBlock): string {
  const duration = formatShortBlockDuration(block)
  const appNames = meaningfulApps(block)
    .slice(0, 3)
    .map((app) => app.appName)
  const siteNames = block.websites
    .slice(0, 2)
    .map((site) => shortDomainLabel(site.domain))
  const keyPage = block.keyPages.find((title) => title.trim().length > 0)
  const evidenceParts: string[] = []

  if (appNames.length > 0) {
    evidenceParts.push(`supporting apps included ${appNames.join(', ')}`)
  }
  if (siteNames.length > 0) {
    evidenceParts.push(`top web activity was on ${siteNames.join(' and ')}`)
  }
  if (keyPage) {
    evidenceParts.push(`key window: ${keyPage}`)
  }

  if (evidenceParts.length === 0) {
    return `This block looks like ${visibleLabel(block).toLowerCase()} for ${duration}.`
  }

  return `This block looks like ${visibleLabel(block).toLowerCase()} for ${duration}. ${evidenceParts.join('. ')}.`
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallbackValue: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallbackValue), timeoutMs)
    void promise
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch(() => {
        clearTimeout(timer)
        resolve(fallbackValue)
      })
  })
}

export default function TimelineDayView({
  payload,
  date,
  activeFilter,
  onFilterChange,
}: TimelineDayViewProps) {
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null)
  const [insights, setInsights] = useState<Record<string, WorkContextInsight | null>>(
    () => ({ ..._insightCache }),
  )
  const [loadingInsightFor, setLoadingInsightFor] = useState<string | null>(null)
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const detailsPanelRef = useRef<HTMLDivElement | null>(null)

  const filteredBlocks = useMemo(() => {
    const sorted = [...payload.blocks].sort((a, b) => a.startTime - b.startTime)
    if (activeFilter === 'all') return sorted
    if (activeFilter === 'development') {
      return sorted.filter((block) => (
        Object.entries(block.categoryDistribution).some(([category, seconds]) => (
          ['development', 'research', 'writing', 'aiTools', 'design', 'productivity'].includes(category)
          && (seconds ?? 0) > 0
        ))
      ))
    }
    return sorted.filter((block) => block.dominantCategory === activeFilter)
  }, [activeFilter, payload.blocks])

  const rangeStart = useMemo(() => {
    if (filteredBlocks.length === 0) {
      const [year, month, day] = date.split('-').map(Number)
      return new Date(year, month - 1, day, 7, 0, 0, 0).getTime()
    }
    return Math.min(...filteredBlocks.map((block) => block.startTime)) - RANGE_PADDING_MS
  }, [date, filteredBlocks])

  const rangeEnd = useMemo(() => {
    if (filteredBlocks.length === 0) {
      return rangeStart + 10 * 60 * 60_000
    }
    const blockEnd = Math.max(...filteredBlocks.map((block) => block.endTime)) + RANGE_PADDING_MS
    if (date === todayString()) {
      return Math.max(blockEnd, Date.now() + RANGE_PADDING_MS)
    }
    return blockEnd
  }, [date, filteredBlocks, rangeStart])

  const rangeHours = Math.max(1, (rangeEnd - rangeStart) / 3_600_000)
  const hourHeight = CALENDAR_HOUR_HEIGHT
  const positionedBlocks = useMemo(() => filteredBlocks.map((block) => ({
    block,
    top: ((block.startTime - rangeStart) / 3_600_000) * hourHeight,
    height: blockHeightFor(block, hourHeight),
  })), [filteredBlocks, hourHeight, rangeStart])
  const totalHeight = Math.max(
    360,
    rangeHours * hourHeight,
    positionedBlocks.length > 0
      ? Math.max(...positionedBlocks.map(({ top, height }) => top + height)) + 32
      : 0,
  )
  const selectedBlock = filteredBlocks.find((block) => block.id === selectedBlockId) ?? null
  const showDesktopDetails = viewportWidth >= DETAILS_PANEL_BREAKPOINT

  async function requestInsight(block: WorkContextBlock): Promise<WorkContextInsight> {
    const fallback: WorkContextInsight = {
      label: visibleLabel(block),
      narrative: localNarrative(block),
    }

    return withTimeout(
      ipc.ai.generateBlockInsight(block),
      BLOCK_INSIGHT_TIMEOUT_MS,
      fallback,
    )
  }

  useEffect(() => {
    setSelectedBlockId(null)
  }, [activeFilter, date])

  useEffect(() => {
    if (selectedBlockId && !filteredBlocks.some((block) => block.id === selectedBlockId)) {
      setSelectedBlockId(null)
    }
  }, [filteredBlocks, selectedBlockId])

  useEffect(() => {
    if (!selectedBlock || selectedBlock.isLive || insights[selectedBlock.id] !== undefined || loadingInsightFor === selectedBlock.id) return
    let cancelled = false
    setLoadingInsightFor(selectedBlock.id)
    void requestInsight(selectedBlock)
      .then((insight) => {
        if (cancelled) return
        _insightCache[selectedBlock.id] = insight
        _lastAnalyzedAt[selectedBlock.id] = Date.now()
        setInsights((current) => ({ ...current, [selectedBlock.id]: insight }))
      })
      .finally(() => {
        if (!cancelled) setLoadingInsightFor((current) => (current === selectedBlock.id ? null : current))
      })
    return () => {
      cancelled = true
    }
  }, [insights, loadingInsightFor, selectedBlock])

  useEffect(() => {
    let cancelled = false
    const blocksToAnalyze = payload.blocks.filter((block) => {
      if (block.isLive) return false
      const lastAt = _lastAnalyzedAt[block.id] ?? 0
      return _insightCache[block.id] === undefined || (Date.now() - lastAt) > REANALYZE_INTERVAL_MS
    })

    async function analyzeAll() {
      for (const block of blocksToAnalyze) {
        if (cancelled) break
        const insight = await requestInsight(block)
        if (cancelled) break
        _insightCache[block.id] = insight
        _lastAnalyzedAt[block.id] = Date.now()
        setInsights((current) => ({ ...current, [block.id]: insight }))
      }
    }

    void analyzeAll()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload.blocks])

  useEffect(() => {
    const onResize = () => {
      setViewportWidth(window.innerWidth)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
    }
  }, [])

  useEffect(() => {
    const handleAISettingsChanged = () => {
      for (const key of Object.keys(_insightCache)) delete _insightCache[key]
      for (const key of Object.keys(_lastAnalyzedAt)) delete _lastAnalyzedAt[key]
      setInsights({})
      setSelectedBlockId(null)
    }

    window.addEventListener('daylens:ai-settings-changed', handleAISettingsChanged as EventListener)
    return () => {
      window.removeEventListener('daylens:ai-settings-changed', handleAISettingsChanged as EventListener)
    }
  }, [])

  useEffect(() => {
    if (!selectedBlock || showDesktopDetails) return
    detailsPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [selectedBlock, showDesktopDetails])

  const nowLineOffset = (() => {
    if (date !== todayString()) return null
    const currentY = ((Date.now() - rangeStart) / 3_600_000) * hourHeight
    return Math.max(0, Math.min(totalHeight, currentY))
  })()

  const hours: Date[] = []
  const cursor = new Date(rangeStart)
  cursor.setMinutes(0, 0, 0)
  if (cursor.getTime() < rangeStart) cursor.setHours(cursor.getHours() + 1)
  while (cursor.getTime() <= rangeEnd) {
    hours.push(new Date(cursor))
    cursor.setHours(cursor.getHours() + 1)
  }

  const renderDetailsPanel = () => (
    <div
      ref={detailsPanelRef}
      style={{
        background: 'var(--color-surface-card)',
        border: '1px solid var(--color-border-ghost)',
        borderRadius: 18,
        boxShadow: '0 18px 48px rgba(15, 23, 42, 0.12)',
        padding: 16,
      }}
    >
      {!selectedBlock && (
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--color-text-primary)' }}>
            Timeline details
          </div>
          <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--color-text-secondary)' }}>
            Select a block to inspect the exact time range, top apps, websites, and the AI summary for that segment.
          </div>
        </div>
      )}

      {selectedBlock && (
        <>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--color-text-primary)', lineHeight: 1.2 }}>
                {visibleLabel(selectedBlock, insights[selectedBlock.id])}
              </div>
              <div style={{ marginTop: 4, fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                {formatShortBlockDuration(selectedBlock)} · {formatBlockRange(selectedBlock)}
              </div>
            </div>
            <button
              onClick={() => setSelectedBlockId(null)}
              style={{
                border: 'none',
                borderRadius: 999,
                width: 28,
                height: 28,
                background: 'var(--color-surface-high)',
                color: 'var(--color-text-secondary)',
                cursor: 'pointer',
                fontSize: 14,
                lineHeight: 1,
                flexShrink: 0,
              }}
              aria-label="Close details"
            >
              ×
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <span
              style={{
                fontSize: 10,
                fontWeight: 800,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                borderRadius: 999,
                padding: '4px 8px',
                color: CATEGORY_COLORS[selectedBlock.dominantCategory],
                background: withAlpha(CATEGORY_COLORS[selectedBlock.dominantCategory], 0.12),
              }}
            >
              {categoryLabel(selectedBlock.dominantCategory)}
            </span>
            {selectedBlock.isLive && (
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-focus-green)' }}>
                Active now
              </span>
            )}
          </div>

          <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.65, marginBottom: 12 }}>
            {loadingInsightFor === selectedBlock.id && !insights[selectedBlock.id]
              ? 'Analyzing block...'
              : insights[selectedBlock.id]?.narrative || localNarrative(selectedBlock)}
          </div>

          <div style={{ borderTop: '1px solid var(--color-border-ghost)', paddingTop: 12, display: 'grid', gap: 14 }}>
            {selectedBlock.websites.length > 0 && (
              <section>
                <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--color-text-secondary)', marginBottom: 7 }}>
                  Websites
                </div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {selectedBlock.websites.slice(0, 4).map((site) => (
                    <div key={`${selectedBlock.id}-${site.domain}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                      <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>•</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--color-text-primary)' }}>
                          {shortDomainLabel(site.domain)}
                        </div>
                        {site.topTitle && (
                          <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {site.topTitle}
                          </div>
                        )}
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--color-text-secondary)', flexShrink: 0 }}>
                        {formatDuration(site.totalSeconds)}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {meaningfulApps(selectedBlock).length > 0 && (
              <section>
                <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--color-text-secondary)', marginBottom: 7 }}>
                  Apps
                </div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {meaningfulApps(selectedBlock).slice(0, 4).map((app) => (
                    <div key={`${selectedBlock.id}-${app.bundleId}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <AppIcon bundleId={app.bundleId} appName={app.appName} size={16} fontSize={8} cornerRadius={5} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--color-text-primary)' }}>
                          {app.appName}
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
                          {categoryLabel(app.category)}
                        </div>
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--color-text-secondary)' }}>
                        {formatDuration(app.totalSeconds)}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {selectedBlock.keyPages.length > 0 && (
              <section>
                <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--color-text-secondary)', marginBottom: 7 }}>
                  Key pages and windows
                </div>
                <div style={{ display: 'grid', gap: 6 }}>
                  {selectedBlock.keyPages.slice(0, 4).map((title) => (
                    <div key={`${selectedBlock.id}-${title}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                      <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>•</span>
                      <div style={{ fontSize: 11.5, color: 'var(--color-text-primary)' }}>
                        {title}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14, borderTop: '1px solid var(--color-border-ghost)', paddingTop: 12 }}>
            <button
              onClick={() => {
                setLoadingInsightFor(selectedBlock.id)
                setInsights((current) => {
                  const next = { ...current }
                  delete next[selectedBlock.id]
                  return next
                })
                void requestInsight(selectedBlock)
                  .then((insight) => {
                    _insightCache[selectedBlock.id] = insight
                    _lastAnalyzedAt[selectedBlock.id] = Date.now()
                    setInsights((current) => ({ ...current, [selectedBlock.id]: insight }))
                  })
                  .finally(() => {
                    setLoadingInsightFor((current) => (current === selectedBlock.id ? null : current))
                  })
              }}
              style={{
                border: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: 'transparent',
                color: 'var(--color-text-secondary)',
                fontSize: 11.5,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              <span aria-hidden="true">↻</span>
              {loadingInsightFor === selectedBlock.id ? 'Analyzing...' : 'Re-analyze'}
            </button>
          </div>
        </>
      )}
    </div>
  )

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-focus-green)' }}>
            {payload.focusPct}%
          </span>
          <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
            {payload.focusPct >= 60 ? 'Focus Work' : payload.focusPct >= 35 ? 'Mixed' : 'Light Focus'}
          </span>
        </div>
        <span style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>{payload.appCount} apps</span>
        <span style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>{payload.siteCount} sites</span>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
        {FILTER_PILLS.map((pill) => {
          const isActive = activeFilter === pill.key
          return (
            <button
              key={pill.key}
              onClick={() => onFilterChange(pill.key)}
              style={{
                border: '1px solid transparent',
                borderRadius: 999,
                padding: '7px 14px',
                background: isActive ? 'var(--gradient-primary)' : 'var(--color-surface-high)',
                color: isActive ? 'var(--color-primary-contrast)' : 'var(--color-text-secondary)',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              {pill.label}
            </button>
          )
        })}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: showDesktopDetails ? 'minmax(0, 1fr) 340px' : '1fr',
          gap: 22,
          alignItems: 'start',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ position: 'relative', borderTop: '1px solid var(--color-border-ghost)', paddingTop: 18 }}>
            <div
              style={{
                position: 'relative',
                minHeight: totalHeight + 24,
              }}
            >
              {hours.map((hour) => {
                const top = ((hour.getTime() - rangeStart) / 3_600_000) * hourHeight
                return (
                  <div key={hour.toISOString()} style={{ position: 'absolute', left: 0, right: 0, top }}>
                    <div
                      style={{
                        position: 'absolute',
                        left: 0,
                        top: -9,
                        width: TIME_AXIS_WIDTH - 6,
                        textAlign: 'right',
                        fontSize: 11,
                        fontWeight: 600,
                        color: 'var(--color-text-tertiary)',
                        whiteSpace: 'nowrap',
                        opacity: 0.72,
                      }}
                    >
                      {formatHourLabel(hour)}
                    </div>
                    <div
                      style={{
                        position: 'absolute',
                        left: TIME_AXIS_WIDTH,
                        right: 0,
                        height: 1,
                        background: 'var(--color-border-ghost)',
                      }}
                    />
                  </div>
                )
              })}

              {nowLineOffset !== null && (
                <div
                  style={{
                    position: 'absolute',
                    left: TIME_AXIS_WIDTH,
                    right: 0,
                    top: nowLineOffset,
                    height: 1.5,
                    background: withAlpha(CATEGORY_COLORS.development, 0.85),
                    zIndex: 1,
                  }}
                />
              )}

              {positionedBlocks.map(({ block, top, height }) => {
                const color = CATEGORY_COLORS[block.dominantCategory] ?? CATEGORY_COLORS.uncategorized
                const isSelected = block.id === selectedBlockId
                const insight = insights[block.id]
                const isTinyBlock = height < 30
                const isCompactBlock = height < 46
                const showDuration = height >= 38
                const iconCount = height >= 58 ? 3 : height >= 38 ? 2 : height >= 28 ? 1 : 0
                const visibleApps = block.topApps.slice(0, iconCount)

                return (
                  <button
                    key={block.id}
                    onClick={() => setSelectedBlockId((current) => current === block.id ? null : block.id)}
                    style={{
                      position: 'absolute',
                      left: TIME_AXIS_WIDTH + 6,
                      right: 0,
                      top,
                      height,
                      display: 'flex',
                      alignItems: 'stretch',
                      padding: 0,
                      border: 'none',
                      background: 'transparent',
                      textAlign: 'left',
                      cursor: 'pointer',
                      zIndex: isSelected ? 3 : block.isLive ? 2 : 1,
                    }}
                    aria-pressed={isSelected}
                  >
                    <div
                      style={{
                        width: 3,
                        flexShrink: 0,
                        borderRadius: 999,
                        background: color,
                        boxShadow: isSelected ? `0 0 0 1px ${withAlpha(color, 0.22)}` : 'none',
                      }}
                    />
                    <div
                      style={{
                        flex: 1,
                        minWidth: 0,
                        borderRadius: 12,
                        border: `1px solid ${withAlpha(color, isSelected ? 0.42 : 0.2)}`,
                        background: withAlpha(color, isSelected ? 0.18 : 0.1),
                        padding: isTinyBlock ? '4px 10px' : isCompactBlock ? '8px 12px' : '12px 14px',
                        display: 'flex',
                        alignItems: isCompactBlock ? 'center' : 'flex-start',
                        justifyContent: 'space-between',
                        gap: 12,
                        boxShadow: isSelected ? `0 18px 44px ${withAlpha(color, 0.12)}` : 'none',
                        overflow: 'hidden',
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: isTinyBlock ? 11.5 : isCompactBlock ? 12.5 : 14,
                            fontWeight: 800,
                            color: 'var(--color-text-primary)',
                            lineHeight: 1.16,
                            marginBottom: showDuration ? 2 : 0,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {visibleLabel(block, insight)}
                        </div>
                        {showDuration && (
                          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                            {formatShortBlockDuration(block)}
                          </div>
                        )}
                      </div>

                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                        {visibleApps.map((app) => (
                          <AppIcon
                            key={`${block.id}-${app.bundleId}`}
                            bundleId={app.bundleId}
                            appName={app.appName}
                            size={18}
                            fontSize={9}
                            cornerRadius={6}
                          />
                        ))}
                        {block.isLive && (
                          <div
                            title="Active now"
                            style={{
                              width: 7,
                              height: 7,
                              borderRadius: '50%',
                              background: color,
                              flexShrink: 0,
                              boxShadow: `0 0 0 2px ${withAlpha(color, 0.3)}`,
                            }}
                          />
                        )}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        {showDesktopDetails && (
          <div style={{ position: 'sticky', top: 18 }}>
            {renderDetailsPanel()}
          </div>
        )}
      </div>

      {!showDesktopDetails && (
        <div style={{ marginTop: 18 }}>
          {renderDetailsPanel()}
        </div>
      )}
    </div>
  )
}
