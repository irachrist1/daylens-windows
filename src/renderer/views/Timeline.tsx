import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ipc } from '../lib/ipc'
import { useKeyboardNav } from '../hooks/useKeyboardNav'
import { formatDuration, formatFullDate, todayString, percentOf } from '../lib/format'
import type {
  AppCategory,
  AppSession,
  DayTimelinePayload,
  TimelineSegment,
  WorkContextBlock,
  WorkContextInsight,
} from '@shared/types'
import { FOCUSED_CATEGORIES } from '@shared/types'
import AppIcon from '../components/AppIcon'

// ─── Insight cache (module-level, survives remounts) ──────────────────────────
const _insightCache: Record<string, WorkContextInsight> = {}
const _lastAnalyzedAt: Record<string, number> = {}

const BLOCK_INSIGHT_TIMEOUT_MS = 12_000
const REANALYZE_INTERVAL_MS = 30 * 60_000

// ─── Calendar grid constants ──────────────────────────────────────────────────
const PX_PER_MIN = 2.0   // 120px per hour — duration visually legible
const TIME_RAIL_W = 48   // px width of the time label column
const POPUP_W = 330

// ─── Category colors ──────────────────────────────────────────────────────────
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

const GENERIC_LABELS = new Set([
  'AI Tools', 'Browsing', 'Communication', 'Design', 'Development', 'Email',
  'Insufficient Data', 'Insufficient Data For Label', 'Mixed Work', 'Productivity',
  'Research', 'Research & AI Chat', 'System', 'Uncategorized', 'Web Session', 'Writing',
])

const DOMAIN_MAP: Record<string, string> = {
  'x.com': 'X.com', 'twitter.com': 'X.com', 'youtube.com': 'YouTube',
  'github.com': 'GitHub', 'mail.google.com': 'Gmail', 'gmail.com': 'Gmail',
  'docs.google.com': 'Google Docs', 'meet.google.com': 'Google Meet',
  'calendar.google.com': 'Google Calendar', 'drive.google.com': 'Google Drive',
  'reddit.com': 'Reddit', 'stackoverflow.com': 'Stack Overflow',
  'linkedin.com': 'LinkedIn', 'slack.com': 'Slack', 'figma.com': 'Figma',
  'chatgpt.com': 'ChatGPT', 'chat.openai.com': 'ChatGPT',
  'claude.ai': 'Claude', 'discord.com': 'Discord',
}

function shortDomain(domain: string): string {
  if (DOMAIN_MAP[domain]) return DOMAIN_MAP[domain]
  const suffix = Object.entries(DOMAIN_MAP).find(([k]) => domain.endsWith(`.${k}`))
  if (suffix) return suffix[1]
  const stripped = domain.startsWith('www.') ? domain.slice(4) : domain
  const base = stripped.split('.')[0] ?? stripped
  return base ? `${base[0].toUpperCase()}${base.slice(1)}` : domain
}

function categoryLabel(cat: AppCategory): string {
  if (cat === 'aiTools') return 'AI Tools'
  return cat.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (c) => c.toUpperCase())
}

function withAlpha(hex: string, alpha: number): string {
  const n = hex.replace('#', '')
  const expanded = n.length === 3 ? n.split('').map((p) => `${p}${p}`).join('') : n
  const v = Number.parseInt(expanded, 16)
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${alpha})`
}

function meaningfulApps(block: WorkContextBlock) {
  return block.topApps.filter((a) => !a.isBrowser && a.category !== 'system' && a.category !== 'uncategorized')
}

function blockLabel(block: WorkContextBlock, insight?: WorkContextInsight | null): string {
  const current = block.label.current?.trim()
  if (current && !GENERIC_LABELS.has(current)) return current
  const il = insight?.label?.trim()
  if (il && !GENERIC_LABELS.has(il)) return il
  const al = block.aiLabel?.trim()
  if (al && !GENERIC_LABELS.has(al)) return al
  const rl = block.ruleBasedLabel.trim()
  if (rl && !GENERIC_LABELS.has(rl)) return rl

  // Prefer well-known domains over raw app names
  const knownSites = block.websites
    .filter((s) => s.domain.includes('.'))
    .map((s) => DOMAIN_MAP[s.domain] ?? DOMAIN_MAP[s.domain.replace(/^www\./, '')] ?? null)
    .filter((v): v is string => v !== null)
    .filter((v, i, a) => a.indexOf(v) === i)
  if (knownSites.length >= 2) return `${knownSites[0]} & ${knownSites[1]}`
  if (knownSites.length === 1) return knownSites[0]

  // Unknown sites fallback — shortDomain is still readable
  const anySites = block.websites
    .filter((s) => s.domain.includes('.'))
    .map((s) => shortDomain(s.domain))
    .filter((v, i, a) => a.indexOf(v) === i)
  if (anySites.length >= 2) return `${anySites[0]} & ${anySites[1]}`
  if (anySites.length === 1) return anySites[0]

  const apps = meaningfulApps(block)
  if (apps.length >= 2) return `${apps[0].appName} & ${apps[1].appName}`
  if (apps.length === 1) return apps[0].appName
  return categoryLabel(block.dominantCategory)
}

const NOISY_PAGE_TITLES = new Set([
  'new tab', 'untitled', 'blank', 'loading...', 'loading', 'undefined', 'null',
  'sign in', 'login', 'home', '404', 'page not found', '403', '502', '503',
])

function isUsefulKeyPage(title: string): boolean {
  const t = title.trim()
  if (t.length < 5) return false
  if (/^https?:\/\//.test(t)) return false  // raw URL
  if (NOISY_PAGE_TITLES.has(t.toLowerCase())) return false
  return true
}

function blockNarrative(block: WorkContextBlock): string {
  const labelNarrative = block.label.narrative?.trim()
  if (labelNarrative) return labelNarrative

  const dur = formatDuration(Math.round((block.endTime - block.startTime) / 1000))
  const apps = meaningfulApps(block).slice(0, 3).map((a) => a.appName)
  const knownSites = block.websites
    .map((s) => DOMAIN_MAP[s.domain] ?? DOMAIN_MAP[s.domain.replace(/^www\./, '')] ?? null)
    .filter((v): v is string => v !== null)
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 2)
  const keyPage = block.keyPages.find((t) => isUsefulKeyPage(t))

  // Compose: prefer known sites over raw app names where relevant
  const siteStr = knownSites.filter((s) => !apps.some((a) => a.toLowerCase().includes(s.toLowerCase())))
  const tools = [...apps, ...siteStr].slice(0, 3)
  const toolStr = tools.length > 0 ? ` in ${tools.join(', ')}` : ''
  const pageStr = keyPage ? `. Working on: ${keyPage}` : ''
  return `${dur}${toolStr}${pageStr}.`
}

function formatClockTime(ts: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(ts)
}

function blockDuration(block: WorkContextBlock): string {
  return formatDuration(Math.round((block.endTime - block.startTime) / 1000))
}

function shiftDate(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d + days)
  return [
    dt.getFullYear(),
    String(dt.getMonth() + 1).padStart(2, '0'),
    String(dt.getDate()).padStart(2, '0'),
  ].join('-')
}

function getWeekStart(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  const day = dt.getDay()
  const diff = day === 0 ? -6 : 1 - day
  dt.setDate(dt.getDate() + diff)
  return [
    dt.getFullYear(),
    String(dt.getMonth() + 1).padStart(2, '0'),
    String(dt.getDate()).padStart(2, '0'),
  ].join('-')
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms)
    promise
      .then((v) => { clearTimeout(t); resolve(v) })
      .catch(() => { clearTimeout(t); resolve(fallback) })
  })
}

function weekRangeLabel(dateStr: string): string {
  const start = getWeekStart(dateStr)
  const end = shiftDate(start, 6)
  const [sy, sm, sd] = start.split('-').map(Number)
  const [ey, em, ed] = end.split('-').map(Number)
  const startFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(sy, sm - 1, sd))
  const endFmt = sm === em
    ? String(ed)
    : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(ey, em - 1, ed))
  return `${startFmt}–${endFmt}`
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function IconChevronLeft() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="m10 3.5-4.5 4.5 4.5 4.5" />
    </svg>
  )
}

function IconChevronRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  )
}

// ─── Week view ────────────────────────────────────────────────────────────────

function isPresentationNoise(s: AppSession): boolean {
  return (s.category === 'system' || s.category === 'uncategorized') && s.durationSeconds < 120
}

interface WeekDayData {
  label: string
  shortLabel: string
  dateStr: string
  totalSeconds: number
  focusPct: number
  topCategory: AppCategory | null
  catBreakdown: Array<{ cat: AppCategory; seconds: number }>
}

function WeekView({ selectedDate, onSelectDay }: { selectedDate: string; onSelectDay: (d: string) => void }) {
  const [weekData, setWeekData] = useState<WeekDayData[]>([])
  const [loading, setLoading] = useState(true)
  const [hoveredDay, setHoveredDay] = useState<string | null>(null)
  const weekStartStr = getWeekStart(selectedDate)
  const today = todayString()

  useEffect(() => {
    setLoading(true)
    const [y, m, d] = weekStartStr.split('-').map(Number)
    const days = Array.from({ length: 7 }, (_, i) => {
      const dt = new Date(y, m - 1, d + i)
      return [
        dt.getFullYear(),
        String(dt.getMonth() + 1).padStart(2, '0'),
        String(dt.getDate()).padStart(2, '0'),
      ].join('-')
    })
    const DAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    const SHORT_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

    void Promise.all(days.map((ds) => ipc.db.getHistory(ds))).then((results) => {
      const data: WeekDayData[] = days.map((ds, i) => {
        const sessions = (results[i] as AppSession[]).filter((s) => !isPresentationNoise(s))
        let total = 0
        let focus = 0
        const catTotals = new Map<AppCategory, number>()
        for (const s of sessions) {
          total += s.durationSeconds
          if (FOCUSED_CATEGORIES.includes(s.category)) focus += s.durationSeconds
          catTotals.set(s.category, (catTotals.get(s.category) ?? 0) + s.durationSeconds)
        }
        const sorted = [...catTotals.entries()].sort((a, b) => b[1] - a[1])
        return {
          label: DAY_LABELS[i],
          shortLabel: SHORT_LABELS[i],
          dateStr: ds,
          totalSeconds: total,
          focusPct: percentOf(focus, total),
          topCategory: sorted[0]?.[0] ?? null,
          catBreakdown: sorted.slice(0, 5).map(([cat, seconds]) => ({ cat, seconds })),
        }
      })
      setWeekData(data)
      setLoading(false)
    })
  }, [weekStartStr])

  if (loading) {
    return (
      <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ fontSize: 12, color: 'var(--color-text-tertiary)', margin: 0 }}>Loading week…</p>
      </div>
    )
  }

  const activeDays = weekData.filter((d) => d.totalSeconds > 0)
  const maxSec = activeDays.length > 0 ? Math.max(...activeDays.map((d) => d.totalSeconds)) : 0
  const mostActiveDay = activeDays.length > 0
    ? activeDays.reduce((a, b) => a.totalSeconds > b.totalSeconds ? a : b)
    : null
  const bestFocusDay = activeDays.filter((d) => d.focusPct > 0).length > 0
    ? activeDays.filter((d) => d.focusPct > 0).reduce((a, b) => a.focusPct > b.focusPct ? a : b)
    : null

  // Collect all categories that appear this week for the legend
  const weekCategories = new Map<AppCategory, number>()
  for (const day of weekData) {
    for (const { cat, seconds } of day.catBreakdown) {
      weekCategories.set(cat, (weekCategories.get(cat) ?? 0) + seconds)
    }
  }
  const legendCategories = [...weekCategories.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)

  // Hovered day detail tooltip content
  const hoveredDayData = hoveredDay ? weekData.find((d) => d.dateStr === hoveredDay) : null

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
        {weekData.map((day) => {
          const barH = maxSec > 0 ? Math.max(4, (day.totalSeconds / maxSec) * 128) : 0
          const isDayToday = day.dateStr === today
          const isSelected = day.dateStr === selectedDate
          const isHovered = day.dateStr === hoveredDay
          const [, , dayNum] = day.dateStr.split('-').map(Number)
          return (
            <button
              key={day.dateStr}
              onClick={() => onSelectDay(day.dateStr)}
              onMouseEnter={() => setHoveredDay(day.dateStr)}
              onMouseLeave={() => setHoveredDay(null)}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                background: isDayToday
                  ? 'var(--color-surface-low)'
                  : isSelected || isHovered
                    ? 'var(--color-surface-container)'
                    : 'transparent',
                border: isDayToday || isSelected ? '1px solid var(--color-border-ghost)' : '1px solid transparent',
                cursor: 'pointer', padding: '10px 4px 8px', borderRadius: 10,
                transition: 'background 100ms',
              }}
            >
              <span style={{
                fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
                color: isDayToday || isSelected ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
              }}>
                {day.shortLabel}
              </span>
              <span style={{ fontSize: 12, fontWeight: 600, color: isSelected ? 'var(--color-text-primary)' : 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                {dayNum}
              </span>

              {/* Stacked category bar */}
              <div style={{ width: '64%', height: 128, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                {day.totalSeconds > 0 ? (
                  <div style={{
                    width: '100%', height: barH, borderRadius: 5, overflow: 'hidden',
                    display: 'flex', flexDirection: 'column',
                  }}>
                    {day.catBreakdown.map(({ cat, seconds }, idx) => (
                      <div
                        key={cat}
                        title={`${categoryLabel(cat)}: ${formatDuration(seconds)}`}
                        style={{
                          flexGrow: seconds,
                          flexBasis: 0,
                          background: CATEGORY_COLORS[cat] ?? '#94a3b8',
                          opacity: idx === 0 ? 0.85 : 0.6,
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <div style={{ width: '100%', height: 3, borderRadius: 999, background: 'var(--color-surface-high)' }} />
                )}
              </div>

              {day.totalSeconds > 0 ? (
                <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
                  {formatDuration(day.totalSeconds)}
                </span>
              ) : (
                <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', opacity: 0.35 }}>—</span>
              )}
            </button>
          )
        })}
      </div>

      {/* Category legend — explains what the color bands mean */}
      {legendCategories.length > 0 && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: '6px 14px', marginTop: 14,
          padding: '0 4px',
        }}>
          {legendCategories.map(([cat, secs]) => (
            <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{
                width: 8, height: 8, borderRadius: 2,
                background: CATEGORY_COLORS[cat] ?? '#94a3b8', opacity: 0.85,
              }} />
              <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                {categoryLabel(cat)} <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatDuration(secs)}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Hover detail — shows category breakdown for hovered day */}
      {hoveredDayData && hoveredDayData.totalSeconds > 0 && (
        <div style={{
          marginTop: 12, padding: '12px 16px', borderRadius: 10,
          background: 'var(--color-surface-low)', border: '1px solid var(--color-border-ghost)',
          transition: 'opacity 120ms',
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)' }}>
              {hoveredDayData.label}
            </span>
            <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
              {formatDuration(hoveredDayData.totalSeconds)} tracked
              {hoveredDayData.focusPct > 0 ? ` · ${hoveredDayData.focusPct}% focused` : ''}
            </span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
            {hoveredDayData.catBreakdown.map(({ cat, seconds }) => (
              <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <div style={{ width: 6, height: 6, borderRadius: 2, background: CATEGORY_COLORS[cat] ?? '#94a3b8' }} />
                <span style={{ fontSize: 11.5, color: 'var(--color-text-secondary)' }}>
                  {categoryLabel(cat)}: {formatDuration(seconds)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Week summary */}
      {activeDays.length > 0 && !hoveredDay && (() => {
        const weekTotal = activeDays.reduce((s, d) => s + d.totalSeconds, 0)
        const avgPerActiveDay = Math.round(weekTotal / activeDays.length)
        const weekFocusSec = activeDays.reduce((s, d) => s + Math.round(d.totalSeconds * d.focusPct / 100), 0)
        const weekFocusPct = percentOf(weekFocusSec, weekTotal)
        const workdayCount = activeDays.filter((d) => {
          const day = new Date(d.dateStr + 'T12:00').getDay()
          return day >= 1 && day <= 5
        }).length
        return (
          <div style={{
            marginTop: 12, padding: '14px 18px', borderRadius: 12,
            background: 'var(--color-surface-container)', border: '1px solid var(--color-border-ghost)',
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
              <span style={{ fontSize: 20, fontWeight: 800, color: 'var(--color-text-primary)', letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>
                {formatDuration(weekTotal)}
              </span>
              <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                across {activeDays.length} day{activeDays.length !== 1 ? 's' : ''}
                {workdayCount > 0 ? ` (${workdayCount} workday${workdayCount !== 1 ? 's' : ''})` : ''}
                {activeDays.length > 1 ? ` · avg ${formatDuration(avgPerActiveDay)}/day` : ''}
              </span>
            </div>
            <div style={{ display: 'grid', gap: 6, fontSize: 13, color: 'var(--color-text-secondary)' }}>
              {weekFocusPct > 0 && (
                <div>
                  <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>{weekFocusPct}%</span>{' '}
                  focused time ({formatDuration(weekFocusSec)})
                </div>
              )}
              {mostActiveDay && (
                <div>
                  <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>Busiest:</span>{' '}
                  {mostActiveDay.label} — {formatDuration(mostActiveDay.totalSeconds)}
                  {mostActiveDay.topCategory ? `, mostly ${categoryLabel(mostActiveDay.topCategory).toLowerCase()}` : ''}
                </div>
              )}
              {bestFocusDay && bestFocusDay.focusPct > 0 && bestFocusDay.dateStr !== mostActiveDay?.dateStr && (
                <div>
                  <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>Best focus:</span>{' '}
                  {bestFocusDay.label} — {bestFocusDay.focusPct}%
                </div>
              )}
            </div>
          </div>
        )
      })()}

      {activeDays.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <p style={{ fontSize: 13, color: 'var(--color-text-tertiary)', margin: 0 }}>
            No activity tracked this week.
          </p>
        </div>
      )}
    </div>
  )
}

// ─── Calendar block (absolutely positioned in time grid) ──────────────────────

const MIN_BLOCK_HEIGHT = 24

function CalendarBlock({
  block,
  insight,
  topPx,
  heightPx,
  boundaryOffsetsPx,
  showLiveIndicator,
  showLiveBadge,
  currentTimeTopPx,
  groupBlockIds,
  isSelected,
  isHighlighted,
  onSelect,
}: {
  block: WorkContextBlock
  insight: WorkContextInsight | null | undefined
  topPx: number
  heightPx: number
  boundaryOffsetsPx?: number[]
  showLiveIndicator?: boolean
  showLiveBadge?: boolean
  currentTimeTopPx?: number | null
  groupBlockIds?: string[]
  isSelected: boolean
  isHighlighted?: boolean
  onSelect: (rect: DOMRect) => void
}) {
  const divRef = useRef<HTMLDivElement>(null)
  const color = CATEGORY_COLORS[block.dominantCategory] ?? CATEGORY_COLORS.uncategorized
  const label = blockLabel(block, insight)
  const apps = meaningfulApps(block).slice(0, 3)

  // Size tiers — at 2.0px/min:
  //   isNano:    < 32px  → < 16min: label only, ultra-compact
  //   isShort:   32–54px → 16–27min: label + duration (no icons)
  //   isMedium:  54–100px → 27–50min: label + icons row + duration
  //   isFull:    100px+  → 50min+: label + time range + icons + duration
  const isNano   = heightPx < 32
  const isMedium = heightPx >= 54 && heightPx < 100
  const isFull   = heightPx >= 100

  return (
    <div
      ref={divRef}
      data-block-id={block.id}
      data-group-block-ids={groupBlockIds?.join(' ')}
      onClick={() => { if (divRef.current) onSelect(divRef.current.getBoundingClientRect()) }}
      style={{
        position: 'absolute',
        top: topPx,
        left: 4,
        right: 4,
        height: heightPx,
        borderRadius: 6,
        background: isSelected ? withAlpha(color, 0.22) : isHighlighted ? withAlpha(color, 0.15) : withAlpha(color, 0.1),
        borderLeft: `3px solid ${color}`,
        outline: (isSelected || isHighlighted) ? `1px solid ${withAlpha(color, 0.45)}` : '1px solid transparent',
        outlineOffset: -1,
        padding: isNano ? '3px 7px 2px 8px' : '5px 8px 4px 9px',
        cursor: 'pointer',
        overflow: 'hidden',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        zIndex: isSelected ? 3 : 1,
        transition: 'background 100ms',
      }}
      onMouseEnter={(e) => {
        if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = withAlpha(color, 0.17)
      }}
      onMouseLeave={(e) => {
        if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = withAlpha(color, 0.1)
      }}
    >
      {boundaryOffsetsPx?.map((dividerTop, index) => (
        <div
          key={index}
          style={{
            position: 'absolute',
            top: dividerTop,
            left: 9,
            right: 8,
            height: 0,
            borderTop: `1px dashed ${withAlpha(color, 0.35)}`,
            pointerEvents: 'none',
          }}
        />
      ))}
      {showLiveIndicator && currentTimeTopPx !== null && currentTimeTopPx !== undefined && currentTimeTopPx >= 0 && currentTimeTopPx <= heightPx && (
        <>
          <div
            style={{
              position: 'absolute',
              top: currentTimeTopPx - 4,
              left: -8,
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: '#ef4444',
              zIndex: 5,
              pointerEvents: 'none',
            }}
          />
          <div
            style={{
              position: 'absolute',
              top: currentTimeTopPx,
              left: 0,
              right: 0,
              height: 1,
              background: '#ef4444',
              opacity: 0.8,
              zIndex: 5,
              pointerEvents: 'none',
            }}
          />
        </>
      )}
      {/* Top area: label + live badge */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, overflow: 'hidden' }}>
        <div style={{
          fontSize: isNano ? 10.5 : 12,
          fontWeight: 700,
          color: 'var(--color-text-primary)',
          lineHeight: 1.25,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
          minWidth: 0,
        }}>
          {label}
        </div>
        {(showLiveBadge || block.isLive) && (
          <span style={{ fontSize: 8.5, fontWeight: 700, color: '#34d399', letterSpacing: '0.06em', flexShrink: 0 }}>
            live
          </span>
        )}
      </div>

      {/* Middle: time range for full-height blocks */}
      {isFull && (
        <div style={{
          fontSize: 10.5,
          color: withAlpha(color, 0.75),
          fontVariantNumeric: 'tabular-nums',
          marginTop: 2,
          lineHeight: 1,
        }}>
          {formatClockTime(block.startTime)} – {formatClockTime(block.endTime)}
        </div>
      )}

      {/* Bottom: app icons (left) + duration (right) */}
      {!isNano && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {(isMedium || isFull) && apps.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              {apps.map((a) => (
                <AppIcon
                  key={a.bundleId}
                  bundleId={a.bundleId}
                  appName={a.appName}
                  color={color}
                  size={13}
                  fontSize={5.5}
                  cornerRadius={3}
                />
              ))}
            </div>
          )}
          <span style={{
            marginLeft: 'auto',
            fontSize: 10,
            color: withAlpha(color, 0.65),
            fontVariantNumeric: 'tabular-nums',
            flexShrink: 0,
          }}>
            {blockDuration(block)}
          </span>
        </div>
      )}
    </div>
  )
}

// ─── Block detail pop-up ──────────────────────────────────────────────────────

function BlockPopup({
  block,
  insight,
  isLoadingInsight,
  anchorRect,
  onClose,
  onReanalyze,
}: {
  block: WorkContextBlock
  insight: WorkContextInsight | null | undefined
  isLoadingInsight: boolean
  anchorRect: DOMRect
  onClose: () => void
  onReanalyze: () => void
}) {
  const popupRef = useRef<HTMLDivElement>(null)
  const color = CATEGORY_COLORS[block.dominantCategory] ?? CATEGORY_COLORS.uncategorized
  const label = blockLabel(block, insight)
  const narrative = block.label.narrative || insight?.narrative || blockNarrative(block)
  const apps = meaningfulApps(block).slice(0, 5)
  const pageRefs = block.pageRefs.slice(0, 4)
  const artifactRefs = block.topArtifacts.filter((artifact) => artifact.artifactType !== 'page').slice(0, 4)
  const workflowRefs = block.workflowRefs.slice(0, 2)

  // Click outside to close
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [onClose])

  // Position: prefer right of block, fall back to left
  const MARGIN = 10
  const winW = window.innerWidth
  const winH = window.innerHeight
  const maxH = Math.min(winH * 0.68, 520)
  let left = anchorRect.right + MARGIN
  if (left + POPUP_W > winW - 8) left = Math.max(8, anchorRect.left - POPUP_W - MARGIN)
  let top = anchorRect.top
  if (top + maxH > winH - 8) top = Math.max(8, winH - maxH - 8)

  return (
    <div
      ref={popupRef}
      style={{
        position: 'fixed',
        top,
        left,
        width: POPUP_W,
        maxHeight: maxH,
        overflowY: 'auto',
        borderRadius: 12,
        background: 'var(--color-surface-card)',
        border: '1px solid var(--color-border-ghost)',
        boxShadow: '0 12px 36px rgba(0,0,0,0.45)',
        zIndex: 300,
        padding: '16px 18px',
        fontFamily: 'var(--font-sans)',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--color-text-primary)', lineHeight: 1.3, marginBottom: 6 }}>
            {label}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{
              fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
              color, background: withAlpha(color, 0.14), borderRadius: 999, padding: '2px 7px',
            }}>
              {categoryLabel(block.dominantCategory)}
            </span>
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              {formatClockTime(block.startTime)} – {formatClockTime(block.endTime)}
            </span>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
              {blockDuration(block)}
            </span>
          </div>
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--color-text-tertiary)', fontSize: 18, lineHeight: 1,
            padding: '0 2px', flexShrink: 0, marginTop: -2,
          }}
        >
          ×
        </button>
      </div>

      {/* Narrative */}
      <p style={{
        fontSize: 12.5, lineHeight: 1.65, color: 'var(--color-text-secondary)',
        margin: '0 0 14px',
        fontStyle: isLoadingInsight && !insight ? 'italic' : 'normal',
      }}>
        {isLoadingInsight && !insight ? 'Analyzing…' : narrative}
      </p>

      <div style={{ display: 'grid', gap: 14 }}>
        {/* Sites */}
        {block.websites.length > 0 && (
          <section>
            <div style={{ fontSize: 9.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--color-text-tertiary)', marginBottom: 7 }}>
              Sites
            </div>
            <div style={{ display: 'grid', gap: 3 }}>
              {block.websites.slice(0, 5).map((site) => {
                const isLinkable = site.domain.includes('.')
                return (
                  <div
                    key={site.domain}
                    onClick={isLinkable ? () => void (window as any).daylens?.shell?.openExternal(`https://${site.domain}`) : undefined}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '5px 6px', borderRadius: 6,
                      cursor: isLinkable ? 'pointer' : 'default',
                      transition: 'background 80ms',
                    }}
                    onMouseEnter={(e) => { if (isLinkable) (e.currentTarget as HTMLDivElement).style.background = 'var(--color-surface-low)' }}
                    onMouseLeave={(e) => { if (isLinkable) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 12, fontWeight: 600,
                        color: isLinkable ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {shortDomain(site.domain)}
                      </div>
                      {site.topTitle && isUsefulKeyPage(site.topTitle) && (
                        <div style={{ fontSize: 10.5, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {site.topTitle}
                        </div>
                      )}
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>
                      {formatDuration(site.totalSeconds)}
                    </span>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* Apps */}
        {apps.length > 0 && (
          <section>
            <div style={{ fontSize: 9.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--color-text-tertiary)', marginBottom: 7 }}>
              Apps
            </div>
            <div style={{ display: 'grid', gap: 5 }}>
              {apps.map((app) => (
                <div key={app.bundleId} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <AppIcon bundleId={app.bundleId} appName={app.appName} color={color} size={16} fontSize={7} cornerRadius={4} />
                  <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                    {app.appName}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>
                    {formatDuration(app.totalSeconds)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Key pages */}
        {pageRefs.length > 0 && (
          <section>
            <div style={{ fontSize: 9.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--color-text-tertiary)', marginBottom: 7 }}>
              Key Pages
            </div>
            <div style={{ display: 'grid', gap: 5 }}>
              {pageRefs.map((page) => (
                <div
                  key={page.id}
                  onClick={() => {
                    const url = page.openTarget.value ?? page.url
                    if (url) window.daylens.shell.openExternal(url)
                  }}
                  style={{
                    fontSize: 11.5, color: 'var(--color-text-secondary)',
                    paddingLeft: 9, borderLeft: `2px solid ${withAlpha(color, 0.35)}`,
                    lineHeight: 1.45,
                    cursor: page.openTarget.kind === 'external_url' ? 'pointer' : 'default',
                  }}
                  title={page.url ?? page.displayTitle}
                >
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{page.displayTitle}</div>
                  {page.host && (
                    <div style={{ fontSize: 10.5, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {page.host}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {artifactRefs.length > 0 && (
          <section>
            <div style={{ fontSize: 9.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--color-text-tertiary)', marginBottom: 7 }}>
              Artifacts
            </div>
            <div style={{ display: 'grid', gap: 5 }}>
              {artifactRefs.map((artifact) => (
                <div key={artifact.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11.5, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {artifact.displayTitle}
                    </div>
                    {(artifact.subtitle || artifact.path || artifact.host) && (
                      <div style={{ fontSize: 10.5, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {artifact.subtitle ?? artifact.path ?? artifact.host}
                      </div>
                    )}
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>
                    {formatDuration(artifact.totalSeconds)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {workflowRefs.length > 0 && (
          <section>
            <div style={{ fontSize: 9.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--color-text-tertiary)', marginBottom: 7 }}>
              Workflows
            </div>
            <div style={{ display: 'grid', gap: 5 }}>
              {workflowRefs.map((workflow) => (
                <div key={workflow.id} style={{ fontSize: 11.5, color: 'var(--color-text-secondary)' }}>
                  {workflow.label}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      {/* Re-analyze footer */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--color-border-ghost)' }}>
        <button
          onClick={(e) => { e.stopPropagation(); onReanalyze() }}
          style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            fontSize: 11.5, fontWeight: 600, color: 'var(--color-text-secondary)',
            display: 'flex', alignItems: 'center', gap: 4,
          }}
        >
          <span aria-hidden="true">↻</span>
          {isLoadingInsight ? 'Analyzing…' : 'Re-analyze'}
        </button>
      </div>
    </div>
  )
}

// ─── Status strip ─────────────────────────────────────────────────────────────

function StatusStrip({ payload, isToday }: { payload: DayTimelinePayload; isToday: boolean }) {
  const liveBlock = payload.blocks.find((b) => b.isLive)
  const liveApp = liveBlock?.topApps[0]?.appName
  const blockCount = payload.blocks.length

  return (
    <div style={{
      display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '5px 12px',
      padding: '12px 0 14px',
      fontSize: 12.5, color: 'var(--color-text-tertiary)',
      borderBottom: '1px solid var(--color-border-ghost)',
    }}>
      <span style={{ fontWeight: 600, color: 'var(--color-text-secondary)' }}>
        {formatDuration(payload.totalSeconds)}
      </span>
      {blockCount > 0 && (
        <>
          <span>·</span>
          <span>{blockCount} block{blockCount !== 1 ? 's' : ''}</span>
        </>
      )}
      {payload.siteCount > 0 && (
        <>
          <span>·</span>
          <span>{payload.siteCount} site{payload.siteCount !== 1 ? 's' : ''}</span>
        </>
      )}
      {isToday && liveApp && (
        <>
          <span>·</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#4ade80', fontWeight: 600 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#4ade80', display: 'inline-block' }} />
            {liveApp}
          </span>
        </>
      )}
    </div>
  )
}

const GAP_LINE_THRESHOLD_MS = 5 * 60_000
const GAP_BAND_THRESHOLD_MS = 15 * 60_000
const GAP_EXPANDABLE_THRESHOLD_MS = 60 * 60_000
const GAP_LARGE_THRESHOLD_MS = 3 * 60 * 60_000

interface PositionedSegment {
  segment: TimelineSegment
  topPx: number
  heightPx: number
}

function segmentKey(segment: TimelineSegment): string {
  if (segment.kind === 'work_block') return `work:${segment.blockId}`
  return `${segment.kind}:${segment.startTime}:${segment.endTime}`
}

function gapHeightPx(segment: Exclude<TimelineSegment, { kind: 'work_block' }>, expanded: boolean): number {
  const durationMs = segment.endTime - segment.startTime
  if (durationMs < GAP_LINE_THRESHOLD_MS) return 0
  if (expanded) return Math.max(16, durationMs / 60_000 * PX_PER_MIN)
  if (durationMs < GAP_BAND_THRESHOLD_MS) return 12
  if (durationMs < GAP_EXPANDABLE_THRESHOLD_MS) return 8
  return 16
}

function gapLabel(segment: Exclude<TimelineSegment, { kind: 'work_block' }>): string {
  const duration = formatDuration(Math.round((segment.endTime - segment.startTime) / 1000))
  if (segment.kind === 'machine_off') return `${duration} machine off`
  if (segment.kind === 'away') return `${duration} away`
  if ((segment.endTime - segment.startTime) >= GAP_LARGE_THRESHOLD_MS) return `${duration} no activity`
  return `${duration} idle`
}

// ─── Filter pills ─────────────────────────────────────────────────────────────

const FILTER_PILLS = [
  { key: 'all',           label: 'All' },
  { key: 'development',   label: 'Development' },
  { key: 'browsing',      label: 'Browsing' },
  { key: 'communication', label: 'Communication' },
  { key: 'writing',       label: 'Writing' },
  { key: 'meetings',      label: 'Meetings' },
] as const

type FilterKey = typeof FILTER_PILLS[number]['key']

// ─── Timeline ─────────────────────────────────────────────────────────────────

export default function Timeline() {
  const [searchParams, setSearchParams] = useSearchParams()
  const viewMode: 'day' | 'week' = searchParams.get('view') === 'week' ? 'week' : 'day'
  const date = searchParams.get('date') ?? todayString()
  const blockParam = searchParams.get('block')

  function setViewMode(mode: 'day' | 'week') {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('view', mode)
      next.delete('block')
      return next
    }, { replace: true })
  }

  function setDate(newDate: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('date', newDate)
      next.delete('block')
      return next
    }, { replace: true })
  }
  const [payload, setPayload] = useState<DayTimelinePayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeFilter, setActiveFilter] = useState<FilterKey>('all')
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null)
  const [selectedBlockRect, setSelectedBlockRect] = useState<DOMRect | null>(null)
  const [insights, setInsights] = useState<Record<string, WorkContextInsight | null>>(
    () => ({ ..._insightCache }),
  )
  const [loadingInsightFor, setLoadingInsightFor] = useState<string | null>(null)
  const [currentTimeMs, setCurrentTimeMs] = useState(Date.now())
  const scrollRef = useRef<HTMLDivElement>(null)

  const isToday = date === todayString()

  // Tick current time every minute
  useEffect(() => {
    if (!isToday) return
    const timer = setInterval(() => setCurrentTimeMs(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [isToday])

  // Stable payload setter — only updates state when block structure actually changed.
  // This prevents cascading re-renders from the 3s poll when nothing meaningful changed.
  const prevBlockKeyRef = useRef('')
  const stableSetPayload = useCallback((data: DayTimelinePayload, isInitial: boolean) => {
    const newKey = data.blocks.map((b) => `${b.id}:${b.isLive ? b.endTime : 's'}`).join(',')
    if (!isInitial && newKey === prevBlockKeyRef.current) return // nothing changed
    prevBlockKeyRef.current = newKey
    setPayload(data)
  }, [])

  // Load day payload
  useEffect(() => {
    if (viewMode === 'week') return
    let cancelled = false

    const loadDay = (showSpinner: boolean) => {
      if (showSpinner) setLoading(true)
      setError(null)
      void ipc.db.getTimelineDay(date)
        .then((data) => { if (!cancelled) stableSetPayload(data, showSpinner) })
        .catch((err) => {
          if (!cancelled) { setPayload(null); setError(err instanceof Error ? err.message : String(err)) }
        })
        .finally(() => { if (!cancelled && showSpinner) setLoading(false) })
    }

    loadDay(true)
    if (isToday) {
      const timer = window.setInterval(() => loadDay(false), 30_000)
      return () => { cancelled = true; window.clearInterval(timer) }
    }
    return () => { cancelled = true }
  }, [date, viewMode, isToday, stableSetPayload])

  // Clear selection on context change
  useEffect(() => {
    setSelectedBlockId(null)
    setSelectedBlockRect(null)
  }, [date, activeFilter, viewMode])

  useEffect(() => {
    setExpandedGapKeys(new Set())
  }, [date, activeFilter, viewMode])

  useEffect(() => {
    if (!payload || !blockParam) return
    const target = payload.blocks.find((block) => block.id === blockParam)
    if (!target) return

    const selectTarget = () => {
      const element = (
        document.querySelector(`[data-block-id="${target.id}"]`)
        ?? document.querySelector(`[data-group-block-ids~="${target.id}"]`)
      ) as HTMLElement | null
      if (!element) return
      setSelectedBlockId(target.id)
      setSelectedBlockRect(element.getBoundingClientRect())
      element.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }

    const timer = window.setTimeout(selectTarget, 0)
    return () => window.clearTimeout(timer)
  }, [payload, blockParam])

  // Stable key: only changes when the set of completed (non-live) blocks changes.
  // This prevents re-triggering analysis every 3s when today's payload refreshes.
  const completedBlockKey = useMemo(
    () => payload?.blocks.filter((b) => !b.isLive).map((b) => b.id).sort().join(',') ?? '',
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [payload?.blocks],
  )
  const payloadRef = useRef(payload)
  payloadRef.current = payload

  // Background block analysis — only re-runs when new completed blocks appear.
  // Batches insight updates to avoid per-block re-renders that cause visual jumps.
  useEffect(() => {
    const p = payloadRef.current
    if (!p) return
    let cancelled = false
    const toAnalyze = p.blocks.filter((b) => {
      if (b.isLive) return false
      const last = _lastAnalyzedAt[b.id] ?? 0
      return _insightCache[b.id] === undefined || (Date.now() - last) > REANALYZE_INTERVAL_MS
    })
    if (toAnalyze.length === 0) return

    async function analyzeAll() {
      const batch: Record<string, WorkContextInsight> = {}
      let batchFlushTimer: ReturnType<typeof setTimeout> | null = null

      const flushBatch = () => {
        if (cancelled || Object.keys(batch).length === 0) return
        const snapshot = { ...batch }
        for (const k of Object.keys(snapshot)) delete batch[k]
        setInsights((cur) => ({ ...cur, ...snapshot }))
      }

      for (const block of toAnalyze) {
        if (cancelled) break
        const fallback: WorkContextInsight = { label: blockLabel(block), narrative: blockNarrative(block) }
        const insight = await withTimeout(ipc.ai.generateBlockInsight(block), BLOCK_INSIGHT_TIMEOUT_MS, fallback)
        if (cancelled) break
        _insightCache[block.id] = insight
        _lastAnalyzedAt[block.id] = Date.now()
        batch[block.id] = insight
        // Debounce: flush after 300ms of no new insights, or immediately on last block
        if (batchFlushTimer) clearTimeout(batchFlushTimer)
        batchFlushTimer = setTimeout(flushBatch, 300)
      }
      // Final flush
      if (batchFlushTimer) clearTimeout(batchFlushTimer)
      flushBatch()
    }
    void analyzeAll()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completedBlockKey])

  // Load insight when block is selected
  const selectedBlock = payload?.blocks.find((b) => b.id === selectedBlockId) ?? null

  useEffect(() => {
    if (!selectedBlock || selectedBlock.isLive || insights[selectedBlock.id] !== undefined || loadingInsightFor === selectedBlock.id) return
    let cancelled = false
    setLoadingInsightFor(selectedBlock.id)
    const fallback: WorkContextInsight = { label: blockLabel(selectedBlock), narrative: blockNarrative(selectedBlock) }
    void withTimeout(ipc.ai.generateBlockInsight(selectedBlock), BLOCK_INSIGHT_TIMEOUT_MS, fallback)
      .then((insight) => {
        if (cancelled) return
        _insightCache[selectedBlock.id] = insight
        _lastAnalyzedAt[selectedBlock.id] = Date.now()
        setInsights((cur) => ({ ...cur, [selectedBlock.id]: insight }))
      })
      .finally(() => { if (!cancelled) setLoadingInsightFor((cur) => cur === selectedBlock.id ? null : cur) })
    return () => { cancelled = true }
  }, [insights, loadingInsightFor, selectedBlock])

  // Clear cache on AI settings change
  useEffect(() => {
    const handler = () => {
      for (const k of Object.keys(_insightCache)) delete _insightCache[k]
      for (const k of Object.keys(_lastAnalyzedAt)) delete _lastAnalyzedAt[k]
      setInsights({})
      setSelectedBlockId(null)
      setSelectedBlockRect(null)
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.delete('block')
        return next
      }, { replace: true })
    }
    window.addEventListener('daylens:ai-settings-changed', handler)
    return () => window.removeEventListener('daylens:ai-settings-changed', handler)
  }, [setSearchParams])

  // Filtered + sorted blocks
  const filteredBlocks = useMemo(() => {
    if (!payload) return []
    const sorted = [...payload.blocks].sort((a, b) => a.startTime - b.startTime)
    if (activeFilter === 'all') return sorted
    return sorted.filter((b) => b.dominantCategory === activeFilter)
  }, [payload, activeFilter])

  // Merge adjacent blocks with same label and <5min gap (Section 3.7)
  const mergedBlocks = useMemo(() => {
    if (filteredBlocks.length === 0) return []
    const MAX_GAP_MS = 5 * 60_000
    const groups: { blocks: WorkContextBlock[]; mergedStart: number; mergedEnd: number }[] = []
    let current = { blocks: [filteredBlocks[0]], mergedStart: filteredBlocks[0].startTime, mergedEnd: filteredBlocks[0].endTime }

    for (let i = 1; i < filteredBlocks.length; i++) {
      const prev = filteredBlocks[i - 1]
      const curr = filteredBlocks[i]
      const gap = curr.startTime - prev.endTime
      const prevLabel = blockLabel(prev, insights[prev.id])
      const currLabel = blockLabel(curr, insights[curr.id])
      if (gap >= 0 && gap < MAX_GAP_MS && prevLabel === currLabel) {
        current.blocks.push(curr)
        current.mergedEnd = curr.endTime
      } else {
        groups.push(current)
        current = { blocks: [curr], mergedStart: curr.startTime, mergedEnd: curr.endTime }
      }
    }
    groups.push(current)
    return groups
  }, [filteredBlocks, insights])
  const [expandedGapKeys, setExpandedGapKeys] = useState<Set<string>>(new Set())

  const rawDisplaySegments = useMemo(() => {
    if (!payload) return []

    if (activeFilter === 'all') {
      return [...payload.segments].sort((left, right) => left.startTime - right.startTime)
    }

    const segments: TimelineSegment[] = []
    for (let index = 0; index < filteredBlocks.length; index++) {
      const block = filteredBlocks[index]
      if (index > 0 && block.startTime > filteredBlocks[index - 1].endTime) {
        segments.push({
          kind: 'idle_gap',
          startTime: filteredBlocks[index - 1].endTime,
          endTime: block.startTime,
          label: 'Idle gap',
          source: 'derived_gap',
        })
      }
      segments.push({
        kind: 'work_block',
        startTime: block.startTime,
        endTime: block.endTime,
        blockId: block.id,
      })
    }
    return segments
  }, [payload, activeFilter, filteredBlocks])

  const positionedSegments = useMemo<PositionedSegment[]>(() => {
    let topPx = 0
    return rawDisplaySegments.map((segment) => {
      const heightPx = segment.kind === 'work_block'
        ? Math.max(MIN_BLOCK_HEIGHT, ((segment.endTime - segment.startTime) / 60_000) * PX_PER_MIN)
        : gapHeightPx(segment, expandedGapKeys.has(segmentKey(segment)))
      const positioned = {
        segment,
        topPx,
        heightPx,
      }
      topPx += heightPx
      return positioned
    })
  }, [rawDisplaySegments, expandedGapKeys])

  const gridHeight = positionedSegments.length > 0
    ? positionedSegments[positionedSegments.length - 1].topPx + positionedSegments[positionedSegments.length - 1].heightPx
    : 0

  const compressedYForTime = useCallback((targetTime: number, preferEnd = false) => {
    if (positionedSegments.length === 0) return 0

    for (const entry of positionedSegments) {
      if (targetTime < entry.segment.startTime) return entry.topPx
      if (targetTime <= entry.segment.endTime) {
        if (
          entry.segment.kind === 'work_block'
          || (expandedGapKeys.has(segmentKey(entry.segment)) && entry.segment.endTime > entry.segment.startTime)
        ) {
          const ratio = (targetTime - entry.segment.startTime) / Math.max(1, entry.segment.endTime - entry.segment.startTime)
          return entry.topPx + entry.heightPx * ratio
        }
        return preferEnd ? entry.topPx + entry.heightPx : entry.topPx
      }
    }

    const last = positionedSegments[positionedSegments.length - 1]
    return last.topPx + last.heightPx
  }, [positionedSegments, expandedGapKeys])

  const currentTimeTop = isToday ? compressedYForTime(currentTimeMs, true) : null

  const timeMarkers = useMemo(() => {
    const markers: Array<{ topPx: number; label: string }> = []
    const MIN_LABEL_GAP = 28 // px — prevent label crowding

    for (const group of mergedBlocks) {
      const topPx = compressedYForTime(group.mergedStart)
      const label = formatClockTime(group.mergedStart)
      const previous = markers[markers.length - 1]
      if (!previous || Math.abs(previous.topPx - topPx) > MIN_LABEL_GAP) {
        markers.push({ topPx, label })
      }
    }

    // Only add gap segment markers for large gaps (>= 30 min) and only if not too close
    for (const entry of positionedSegments) {
      if (entry.segment.kind === 'work_block' || entry.heightPx < 24) continue
      const durationMs = entry.segment.endTime - entry.segment.startTime
      if (durationMs < 30 * 60_000) continue // skip small gaps
      const label = formatClockTime(entry.segment.startTime)
      const previous = markers[markers.length - 1]
      if (!previous || Math.abs(previous.topPx - entry.topPx) > MIN_LABEL_GAP) {
        markers.push({ topPx: entry.topPx, label })
      }
    }

    // End time marker: only add if it won't crowd the last marker
    if (positionedSegments.length > 0) {
      const last = positionedSegments[positionedSegments.length - 1]
      const endTop = last.topPx + last.heightPx - 10
      const previous = markers[markers.length - 1]
      if (!previous || Math.abs(previous.topPx - endTop) > MIN_LABEL_GAP) {
        markers.push({ topPx: endTop, label: formatClockTime(last.segment.endTime) })
      }
    }

    return markers
  }, [mergedBlocks, positionedSegments, compressedYForTime])

  // Scroll to current time or first block on day change
  useEffect(() => {
    if (!scrollRef.current || viewMode !== 'day' || loading) return
    const targetPx = currentTimeTop !== null
      ? Math.max(0, currentTimeTop - 120)
      : filteredBlocks.length > 0
        ? Math.max(0, compressedYForTime(filteredBlocks[0].startTime) - 40)
        : 0
    scrollRef.current.scrollTop = targetPx
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, viewMode, loading])

  function handleBlockClick(block: WorkContextBlock, rect: DOMRect) {
    if (selectedBlockId === block.id) {
      setSelectedBlockId(null)
      setSelectedBlockRect(null)
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.delete('block')
        return next
      }, { replace: true })
    } else {
      setSelectedBlockId(block.id)
      setSelectedBlockRect(rect)
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.set('block', block.id)
        return next
      }, { replace: true })
    }
  }

  function handleReanalyze(block: WorkContextBlock) {
    setLoadingInsightFor(block.id)
    setInsights((cur) => { const next = { ...cur }; delete next[block.id]; return next })
    const fallback: WorkContextInsight = { label: blockLabel(block), narrative: blockNarrative(block) }
    void withTimeout(ipc.ai.generateBlockInsight(block), BLOCK_INSIGHT_TIMEOUT_MS, fallback)
      .then((insight) => {
        _insightCache[block.id] = insight; _lastAnalyzedAt[block.id] = Date.now()
        setInsights((cur) => ({ ...cur, [block.id]: insight }))
      })
      .finally(() => setLoadingInsightFor((cur) => cur === block.id ? null : cur))
  }

  // ── Keyboard navigation ──────────────────────────────────────────────────

  // Track highlighted block index for up/down navigation
  const [highlightedIdx, setHighlightedIdx] = useState<number | null>(null)

  // Reset highlighted index on context changes
  useEffect(() => { setHighlightedIdx(null) }, [date, activeFilter, viewMode])

  const selectHighlightedBlock = useCallback(() => {
    if (highlightedIdx === null || !filteredBlocks[highlightedIdx]) return
    const block = filteredBlocks[highlightedIdx]
    const el = (
      document.querySelector(`[data-block-id="${block.id}"]`)
      ?? document.querySelector(`[data-group-block-ids~="${block.id}"]`)
    ) as HTMLElement | null
    if (el) handleBlockClick(block, el.getBoundingClientRect())
  }, [highlightedIdx, filteredBlocks])

  useKeyboardNav([
    // Escape: close popover
    {
      key: 'Escape',
      action: () => {
        setSelectedBlockId(null)
        setSelectedBlockRect(null)
        setHighlightedIdx(null)
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev)
          next.delete('block')
          return next
        }, { replace: true })
      },
      global: true,
    },
    // T: jump to today
    { key: 't', action: () => setDate(todayString()) },
    // Left/Right: navigate days or weeks
    {
      key: 'ArrowLeft',
      action: () => setDate(viewMode === 'week' ? shiftDate(getWeekStart(date), -7) : shiftDate(date, -1)),
    },
    {
      key: 'ArrowRight',
      action: () => {
        const today = todayString()
        if (viewMode === 'day' && date >= today) return
        if (viewMode === 'week' && getWeekStart(date) >= getWeekStart(today)) return
        setDate(viewMode === 'week' ? shiftDate(getWeekStart(date), 7) : shiftDate(date, 1))
      },
    },
    // Up/Down: select blocks in day view
    {
      key: 'ArrowUp',
      action: () => {
        if (viewMode !== 'day' || filteredBlocks.length === 0) return
        setHighlightedIdx((cur) => cur === null || cur <= 0 ? filteredBlocks.length - 1 : cur - 1)
      },
    },
    {
      key: 'ArrowDown',
      action: () => {
        if (viewMode !== 'day' || filteredBlocks.length === 0) return
        setHighlightedIdx((cur) => cur === null ? 0 : cur >= filteredBlocks.length - 1 ? 0 : cur + 1)
      },
    },
    // Enter/Space: open popover for highlighted block
    { key: 'Enter', action: selectHighlightedBlock },
    { key: ' ', action: selectHighlightedBlock },
  ], [viewMode, date, filteredBlocks, highlightedIdx, selectHighlightedBlock])

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* ── Sticky header ── */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 10,
        background: 'var(--color-bg)',
        padding: '20px 36px 14px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: '1px solid rgba(66,71,84,0.18)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            onClick={() => setDate(
              viewMode === 'week'
                ? shiftDate(getWeekStart(date), -7)
                : shiftDate(date, -1)
            )}
            style={{
              width: 32, height: 32, borderRadius: 999, border: 'none',
              background: 'transparent', cursor: 'pointer', color: 'var(--color-text-secondary)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <IconChevronLeft />
          </button>
          <div style={{
            padding: '8px 18px', borderRadius: 999, minWidth: 148, textAlign: 'center',
            background: 'var(--color-surface-container)', border: '1px solid var(--color-border-ghost)',
            fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)',
          }}>
            {viewMode === 'week' ? weekRangeLabel(date) : isToday ? 'Today' : formatFullDate(date)}
          </div>
          {(() => {
            const isCurrentWeek = viewMode === 'week' && getWeekStart(date) === getWeekStart(todayString())
            const disabledFwd = viewMode === 'day' ? isToday : isCurrentWeek
            return (
              <button
                onClick={() => {
                if (!disabledFwd) setDate(
                  viewMode === 'week'
                    ? shiftDate(getWeekStart(date), 7)
                    : shiftDate(date, 1)
                )
              }}
                disabled={disabledFwd}
                style={{
                  width: 32, height: 32, borderRadius: 999, border: 'none',
                  background: 'transparent',
                  cursor: disabledFwd ? 'default' : 'pointer',
                  color: 'var(--color-text-secondary)',
                  opacity: disabledFwd ? 0.28 : 1,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <IconChevronRight />
              </button>
            )
          })()}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {(viewMode === 'day' ? !isToday : getWeekStart(date) !== getWeekStart(todayString())) && (
            <button
              onClick={() => setDate(todayString())}
              style={{
                padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                border: '1px solid var(--color-border-ghost)', cursor: 'pointer',
                background: 'var(--color-surface-container)', color: 'var(--color-text-secondary)',
              }}
            >
              Today
            </button>
          )}
          <div style={{
            display: 'flex', gap: 3, padding: 3,
            borderRadius: 9, background: 'var(--color-surface-high)', border: '1px solid var(--color-border-ghost)',
          }}>
            {(['day', 'week'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                style={{
                  padding: '4px 13px', borderRadius: 7, fontSize: 12, fontWeight: 700,
                  border: 'none', cursor: 'pointer',
                  background: viewMode === mode ? 'var(--gradient-primary)' : 'transparent',
                  color: viewMode === mode ? 'var(--color-primary-contrast)' : 'var(--color-text-secondary)',
                  transition: 'all 120ms',
                }}
              >
                {mode === 'day' ? 'Day' : 'Week'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Scrollable content ── */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '0 0 64px' }}>

        {/* Week mode */}
        {viewMode === 'week' && (
          <div style={{ padding: '28px 36px 0' }}>
            <WeekView selectedDate={date} onSelectDay={(d) => {
            setSearchParams({ view: 'day', date: d }, { replace: true })
          }} />
          </div>
        )}

        {/* Day mode */}
        {viewMode === 'day' && (
          <div>
            {error && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '64px 0', gap: 12 }}>
                <p style={{ fontSize: 13, color: '#f87171', margin: 0 }}>Could not load timeline: {error}</p>
                <button
                  onClick={() => { setError(null); setLoading(true) }}
                  style={{
                    padding: '6px 16px', borderRadius: 999, border: 'none', cursor: 'pointer',
                    background: 'var(--color-primary)', color: 'var(--color-primary-contrast)', fontSize: 13, fontWeight: 700,
                  }}
                >
                  Retry
                </button>
              </div>
            )}

            {!error && loading && (
              <div style={{ padding: '20px 36px', display: 'grid', gap: 10 }}>
                <div style={{ height: 36, borderRadius: 999, width: '60%', background: 'var(--color-surface-low)', opacity: 0.55 }} />
                {[72, 56, 88, 64].map((h, i) => (
                  <div key={i} style={{ height: h, borderRadius: 12, background: 'var(--color-surface-low)', opacity: 0.45 }} />
                ))}
              </div>
            )}

            {!error && !loading && payload && (
              <>
                {/* Status strip */}
                {payload.totalSeconds > 0 && (
                  <div style={{ padding: '0 36px 4px' }}>
                    <StatusStrip payload={payload} isToday={isToday} />
                  </div>
                )}

                {/* Filter pills */}
                {payload.blocks.length > 0 && (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', padding: '12px 36px 8px' }}>
                    {FILTER_PILLS.map((pill) => {
                      const active = activeFilter === pill.key
                      return (
                        <button
                          key={pill.key}
                          onClick={() => setActiveFilter(pill.key)}
                          style={{
                            borderRadius: 999, padding: '3px 10px',
                            fontSize: 11, fontWeight: 600, cursor: 'pointer',
                            border: '1px solid transparent',
                            background: active ? 'var(--color-surface-low)' : 'transparent',
                            color: active ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
                            outline: active ? '1px solid var(--color-border-ghost)' : 'none',
                            outlineOffset: -1,
                            transition: 'all 100ms',
                          }}
                        >
                          {pill.label}
                        </button>
                      )
                    })}
                  </div>
                )}

                {/* Empty states */}
                {filteredBlocks.length === 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '80px 36px', gap: 10, textAlign: 'center' }}>
                    {isToday ? (
                      <>
                        <div style={{ fontSize: 28, letterSpacing: '0.2em', opacity: 0.3, marginBottom: 4 }}>· · ·</div>
                        <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)', margin: 0 }}>
                          Nothing tracked yet today
                        </p>
                        <p style={{ fontSize: 13, color: 'var(--color-text-tertiary)', margin: 0, maxWidth: 300, lineHeight: 1.6 }}>
                          Timeline updates as you work. Activity appears once enough data has accumulated.
                        </p>
                      </>
                    ) : activeFilter !== 'all' ? (
                      <>
                        <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)', margin: 0 }}>
                          No {activeFilter} blocks this day
                        </p>
                        <button
                          onClick={() => setActiveFilter('all')}
                          style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', background: 'transparent', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
                        >
                          Show all blocks
                        </button>
                      </>
                    ) : (
                      <>
                        <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)', margin: 0 }}>
                          No timeline for this day
                        </p>
                        <p style={{ fontSize: 13, color: 'var(--color-text-tertiary)', margin: 0 }}>
                          No activity was recorded.
                        </p>
                      </>
                    )}
                  </div>
                )}

                {/* ── Calendar time grid ── */}
                {filteredBlocks.length > 0 && (
                  <div style={{ display: 'flex', paddingTop: 16, paddingBottom: 40 }}>

                    {/* Time rail */}
                    <div style={{
                      width: TIME_RAIL_W + 36,
                      flexShrink: 0,
                      position: 'relative',
                      height: gridHeight,
                    }}>
                      {timeMarkers.map((marker) => (
                        <div
                          key={`${marker.label}:${marker.topPx}`}
                          style={{
                            position: 'absolute',
                            top: marker.topPx - 7,
                            left: 0,
                            right: 0,
                            fontSize: 10.5,
                            fontWeight: 500,
                            color: 'var(--color-text-tertiary)',
                            textAlign: 'right',
                            paddingRight: 10,
                            pointerEvents: 'none',
                            userSelect: 'none',
                          }}
                        >
                          {marker.label}
                        </div>
                      ))}
                    </div>

                    {/* Block grid — flex row for future calendar lane */}
                    <div
                      style={{
                        flex: 1,
                        display: 'flex',
                        height: gridHeight,
                        paddingRight: 36,
                      }}
                    >
                      {/* Activity lane — holds all tracked blocks */}
                      <div className="activity-lane" style={{ flex: 1, position: 'relative' }}>
                        {positionedSegments.map((entry) => {
                          if (entry.segment.kind === 'work_block' || entry.heightPx <= 0) return null

                          const durationMs = entry.segment.endTime - entry.segment.startTime
                          const key = segmentKey(entry.segment)
                          const isExpanded = expandedGapKeys.has(key)
                          const expandable = durationMs >= GAP_EXPANDABLE_THRESHOLD_MS
                          const isDashed = durationMs >= GAP_LINE_THRESHOLD_MS && durationMs < GAP_BAND_THRESHOLD_MS
                          const label = durationMs >= GAP_BAND_THRESHOLD_MS ? gapLabel(entry.segment) : null

                          if (isDashed) {
                            // Small gaps: just a faint horizontal rule — no box, no pattern
                            return (
                              <div
                                key={key}
                                style={{
                                  position: 'absolute',
                                  top: entry.topPx + entry.heightPx / 2,
                                  left: 12,
                                  right: 12,
                                  borderTop: '1px solid var(--color-border-ghost)',
                                  opacity: 0.4,
                                  pointerEvents: 'none',
                                }}
                              />
                            )
                          }

                          return (
                            <button
                              key={key}
                              onClick={() => {
                                if (!expandable) return
                                setExpandedGapKeys((current) => {
                                  const next = new Set(current)
                                  if (next.has(key)) next.delete(key)
                                  else next.add(key)
                                  return next
                                })
                              }}
                              style={{
                                position: 'absolute',
                                top: entry.topPx,
                                left: 4,
                                right: 4,
                                height: entry.heightPx,
                                borderRadius: 6,
                                border: 'none',
                                borderTop: '1px solid var(--color-border-ghost)',
                                borderBottom: '1px solid var(--color-border-ghost)',
                                background: 'transparent',
                                color: 'var(--color-text-tertiary)',
                                fontSize: 11,
                                opacity: 0.7,
                                cursor: expandable ? 'pointer' : 'default',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                padding: 0,
                                overflow: 'hidden',
                              }}
                              title={expandable ? (isExpanded ? 'Collapse gap' : 'Expand gap') : undefined}
                            >
                              <span style={{ pointerEvents: 'none', whiteSpace: 'nowrap', letterSpacing: '0.01em' }}>
                                {label}
                              </span>
                            </button>
                          )
                        })}

                        {/* Blocks (with merged groups) */}
                        {mergedBlocks.map((group) => {
                          const primary = group.blocks[0]
                          const anySelected = group.blocks.some((b) => b.id === selectedBlockId)
                          const topPx = compressedYForTime(group.mergedStart)
                          const heightPx = Math.max(MIN_BLOCK_HEIGHT, compressedYForTime(group.mergedEnd, true) - topPx)
                          const boundaryOffsetsPx = group.blocks.slice(1).map((sub) => compressedYForTime(sub.startTime) - topPx)
                          const hasLiveBlock = group.blocks.some((block) => block.isLive)
                          const currentBlockTimeTop = hasLiveBlock && currentTimeTop !== null ? currentTimeTop - topPx : null

                          return (
                            <CalendarBlock
                              key={group.blocks.map((b) => b.id).join('-')}
                              block={primary}
                              insight={insights[primary.id]}
                              topPx={topPx}
                              heightPx={heightPx}
                              boundaryOffsetsPx={boundaryOffsetsPx}
                              showLiveIndicator={hasLiveBlock}
                              showLiveBadge={hasLiveBlock}
                              currentTimeTopPx={currentBlockTimeTop}
                              groupBlockIds={group.blocks.map((block) => block.id)}
                              isSelected={anySelected}
                              isHighlighted={highlightedIdx !== null && group.blocks.some((b) => b.id === filteredBlocks[highlightedIdx]?.id)}
                              onSelect={(rect) => handleBlockClick(primary, rect)}
                            />
                          )
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Block detail pop-up */}
      {selectedBlock && selectedBlockRect && (
        <BlockPopup
          block={selectedBlock}
          insight={insights[selectedBlock.id]}
          isLoadingInsight={loadingInsightFor === selectedBlock.id}
          anchorRect={selectedBlockRect}
          onClose={() => {
            setSelectedBlockId(null)
            setSelectedBlockRect(null)
            setSearchParams((prev) => {
              const next = new URLSearchParams(prev)
              next.delete('block')
              return next
            }, { replace: true })
          }}
          onReanalyze={() => handleReanalyze(selectedBlock)}
        />
      )}
    </div>
  )
}
