import { useEffect, useState } from 'react'
import { ipc } from '../lib/ipc'
import { formatDuration, percentOf } from '../lib/format'
import type { AppUsageSummary } from '@shared/types'

// Category → accent color (subset matching macOS system)
const CATEGORY_COLOR: Record<string, string> = {
  development:   '#b4c5ff',
  research:      '#c084fc',
  writing:       '#93c5fd',
  aiTools:       '#e879f9',
  design:        '#f472b6',
  productivity:  '#6ee7b7',
  communication: '#4fdbc8',
  email:         '#67e8f9',
  browsing:      '#fb923c',
  meetings:      '#ffb95f',
  entertainment: '#f87171',
  social:        '#a78bfa',
  system:        '#94a3b8',
  uncategorized: '#475569',
}

function categoryColor(cat: string) {
  return CATEGORY_COLOR[cat] ?? '#94a3b8'
}

// Greeting based on time of day
function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

export default function Today() {
  const [summaries, setSummaries] = useState<AppUsageSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ipc.db.getToday().then((data) => {
      setSummaries(data as AppUsageSummary[])
      setLoading(false)
    })
  }, [])

  const totalSec  = summaries.reduce((s, a) => s + a.totalSeconds, 0)
  const focusSec  = summaries.filter((a) => a.isFocused).reduce((s, a) => s + a.totalSeconds, 0)
  const focusPct  = percentOf(focusSec, totalSec)
  const appCount  = summaries.length

  return (
    <div className="p-7 max-w-3xl mx-auto">

      {/* Hero header */}
      <div className="mb-7">
        <p className="text-[13px] text-[var(--color-text-secondary)] mb-1">{greeting()}</p>
        <h1 className="text-2xl font-semibold text-[var(--color-text-primary)] tracking-tight">
          {loading ? '—' : formatDuration(totalSec)}
          <span className="text-[var(--color-text-secondary)] font-normal text-base ml-2">tracked today</span>
        </h1>
      </div>

      {/* Stat cards row */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <StatCard
          label="Screen time"
          value={loading ? '—' : formatDuration(totalSec)}
          sub={loading ? '' : `${appCount} apps`}
        />
        <StatCard
          label="Focus time"
          value={loading ? '—' : formatDuration(focusSec)}
          sub={loading ? '' : `${focusPct}% of day`}
          accent
        />
        <StatCard
          label="Focus score"
          value={loading ? '—' : `${focusPct}%`}
          sub={focusPct >= 60 ? 'Strong' : focusPct >= 40 ? 'Moderate' : 'Low'}
        />
      </div>

      {/* Time allocation bar */}
      {!loading && summaries.length > 0 && (
        <div className="mb-6">
          <p className="section-label mb-2">Time allocation</p>
          <div className="flex h-2 rounded-full overflow-hidden gap-px">
            {summaries.slice(0, 8).map((app) => (
              <div
                key={app.bundleId}
                title={`${app.appName} · ${formatDuration(app.totalSeconds)}`}
                style={{
                  width: `${percentOf(app.totalSeconds, totalSec)}%`,
                  background: categoryColor(app.category),
                  minWidth: 2,
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* App list */}
      <div>
        <p className="section-label mb-3">Apps</p>
        {loading ? (
          <div className="flex flex-col gap-1">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-11 rounded-lg bg-[var(--color-surface-card)] animate-pulse" />
            ))}
          </div>
        ) : summaries.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="card p-0 overflow-hidden">
            {summaries.map((app, i) => (
              <AppRow
                key={app.bundleId}
                app={app}
                totalSec={totalSec}
                isLast={i === summaries.length - 1}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function StatCard({ label, value, sub, accent }: {
  label: string
  value: string
  sub?: string
  accent?: boolean
}) {
  return (
    <div className="card flex flex-col gap-1">
      <p className="section-label">{label}</p>
      <p
        className="text-[22px] font-semibold leading-tight tracking-tight"
        style={{ color: accent ? 'var(--color-accent)' : 'var(--color-text-primary)' }}
      >
        {value}
      </p>
      {sub && (
        <p className="text-[12px] text-[var(--color-text-secondary)]">{sub}</p>
      )}
    </div>
  )
}

function AppRow({ app, totalSec, isLast }: {
  app: AppUsageSummary
  totalSec: number
  isLast: boolean
}) {
  const pct   = percentOf(app.totalSeconds, totalSec)
  const color = categoryColor(app.category)
  const initials = app.appName.slice(0, 2).toUpperCase()

  return (
    <div className={[
      'flex items-center gap-3 px-4 py-3 hover:bg-[var(--color-surface-high)] transition-colors',
      !isLast ? 'border-b border-[var(--color-border)]' : '',
    ].join(' ')}>
      {/* App icon placeholder */}
      <div
        className="w-8 h-8 rounded-lg flex items-center justify-center text-[11px] font-bold shrink-0"
        style={{ background: color + '22', color }}
      >
        {initials}
      </div>

      {/* Name + bar */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-[13px] text-[var(--color-text-primary)] truncate leading-none">
            {app.appName}
          </p>
          <span className="text-[12px] text-[var(--color-text-secondary)] ml-3 shrink-0 tabular-nums">
            {formatDuration(app.totalSeconds)}
          </span>
        </div>
        <div className="h-[3px] rounded-full bg-[var(--color-surface-high)] overflow-hidden">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${pct}%`, background: color }}
          />
        </div>
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="card flex flex-col items-center justify-center py-12 text-center">
      <div className="text-3xl mb-3 opacity-30">◎</div>
      <p className="text-[14px] font-medium text-[var(--color-text-primary)] mb-1">No activity yet</p>
      <p className="text-[13px] text-[var(--color-text-secondary)]">
        Daylens will start recording as you work.
      </p>
    </div>
  )
}
