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
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">Apps</h1>
        <div className="flex gap-1">
          {DAYS_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={[
                'px-3 py-1 rounded-md text-[12px] transition-colors',
                days === d
                  ? 'bg-[var(--color-accent-dim)] text-[var(--color-accent)]'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]',
              ].join(' ')}
            >
              {d === 1 ? 'Today' : `${d}d`}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="text-[var(--color-text-secondary)] text-sm">Loading…</p>
      ) : summaries.length === 0 ? (
        <p className="text-[var(--color-text-secondary)] text-sm">No data for this period.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {summaries.map((app) => {
            const pct = totalSec > 0 ? Math.round((app.totalSeconds / totalSec) * 100) : 0
            return (
              <div
                key={app.bundleId}
                className="flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-[var(--color-surface-raised)]"
              >
                <div className="w-7 h-7 rounded-md bg-[var(--color-surface-overlay)] flex items-center justify-center text-xs font-semibold text-[var(--color-text-secondary)]">
                  {app.appName.slice(0, 2)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-[13px] text-[var(--color-text-primary)] truncate">{app.appName}</p>
                    <span className="text-[12px] text-[var(--color-text-secondary)] ml-3 shrink-0">
                      {formatDuration(app.totalSeconds)}
                    </span>
                  </div>
                  <div className="h-1 rounded-full bg-[var(--color-surface-overlay)] overflow-hidden">
                    <div
                      className="h-full rounded-full bg-[var(--color-accent)]"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
                <span className="text-[11px] text-[var(--color-text-secondary)] w-8 text-right shrink-0">
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
