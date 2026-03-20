import { useEffect, useState } from 'react'
import { ipc } from '../lib/ipc'
import { formatDuration } from '../lib/format'
import type { AppUsageSummary } from '@shared/types'

const DAYS_OPTIONS = [1, 7, 30] as const

export default function Apps() {
  const [days, setDays] = useState<(typeof DAYS_OPTIONS)[number]>(7)
  const [summaries, setSummaries] = useState<AppUsageSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    ipc.db.getAppSummaries(days).then((data) => {
      setSummaries(data as AppUsageSummary[])
      setLoading(false)
    })
  }, [days])

  const totalSec = summaries.reduce((s, a) => s + a.totalSeconds, 0)

  return (
    <div className="p-7 max-w-3xl mx-auto">
      <div className="flex items-end justify-between mb-7">
        <div>
          <p className="section-label mb-1">Apps</p>
          <h1 className="text-2xl font-semibold text-[var(--color-text-primary)] tracking-tight">
            Usage breakdown
          </h1>
        </div>
        <div className="flex gap-1 p-1 rounded-lg bg-[var(--color-surface-card)] border border-[var(--color-border)]">
          {DAYS_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={[
                'px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors',
                days === d
                  ? 'bg-[var(--color-surface-high)] text-[var(--color-text-primary)]'
                  : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
              ].join(' ')}
            >
              {d === 1 ? 'Today' : `${d}d`}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex flex-col gap-px overflow-hidden rounded-xl border border-[var(--color-border)]">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-14 bg-[var(--color-surface-card)] animate-pulse" />
          ))}
        </div>
      ) : summaries.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-12 text-center">
          <p className="text-[14px] font-medium text-[var(--color-text-primary)] mb-1">No data</p>
          <p className="text-[13px] text-[var(--color-text-secondary)]">No app usage recorded for this period.</p>
        </div>
      ) : (
        <div className="card p-0 overflow-hidden">
          {summaries.map((app, i) => {
            const pct = totalSec > 0 ? Math.round((app.totalSeconds / totalSec) * 100) : 0
            return (
              <div
                key={app.bundleId}
                className={[
                  'flex items-center gap-3 px-4 py-3.5 hover:bg-[var(--color-surface-high)] transition-colors',
                  i < summaries.length - 1 ? 'border-b border-[var(--color-border)]' : '',
                ].join(' ')}
              >
                <div className="w-8 h-8 rounded-lg bg-[var(--color-surface-high)] flex items-center justify-center text-[11px] font-bold text-[var(--color-text-secondary)] shrink-0">
                  {app.appName.slice(0, 2).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-1.5">
                    <p className="text-[13px] text-[var(--color-text-primary)] truncate">{app.appName}</p>
                    <span className="text-[12px] text-[var(--color-text-secondary)] ml-3 shrink-0 tabular-nums">
                      {formatDuration(app.totalSeconds)}
                    </span>
                  </div>
                  <div className="h-[3px] rounded-full bg-[var(--color-surface-high)] overflow-hidden">
                    <div
                      className="h-full rounded-full bg-[var(--color-accent)]"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
                <span className="text-[11px] text-[var(--color-text-tertiary)] w-9 text-right shrink-0 tabular-nums">
                  {pct}%
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
