import { useEffect, useState } from 'react'
import { ipc } from '../lib/ipc'
import { formatDuration, percentOf } from '../lib/format'
import type { AppUsageSummary } from '@shared/types'

export default function Today() {
  const [summaries, setSummaries] = useState<AppUsageSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ipc.db.getToday().then((data) => {
      setSummaries(data as AppUsageSummary[])
      setLoading(false)
    })
  }, [])

  const totalSec = summaries.reduce((s, a) => s + a.totalSeconds, 0)
  const focusSec = summaries.filter((a) => a.isFocused).reduce((s, a) => s + a.totalSeconds, 0)
  const focusPct = percentOf(focusSec, totalSec)

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-lg font-semibold text-[var(--color-text-primary)] mb-6">Today</h1>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3 mb-8">
        <StatCard label="Screen time" value={loading ? '—' : formatDuration(totalSec)} />
        <StatCard label="Focus time" value={loading ? '—' : formatDuration(focusSec)} />
        <StatCard label="Focus score" value={loading ? '—' : `${focusPct}%`} />
      </div>

      {/* App list */}
      <section>
        <h2 className="text-[11px] font-semibold uppercase tracking-widest text-[var(--color-text-secondary)] mb-3">
          Apps
        </h2>
        {loading ? (
          <p className="text-[var(--color-text-secondary)] text-sm">Loading…</p>
        ) : summaries.length === 0 ? (
          <p className="text-[var(--color-text-secondary)] text-sm">No activity recorded yet today.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {summaries.map((app) => (
              <AppRow key={app.bundleId} app={app} totalSec={totalSec} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-4 py-3">
      <p className="text-[11px] text-[var(--color-text-secondary)] mb-1">{label}</p>
      <p className="text-xl font-semibold text-[var(--color-text-primary)]">{value}</p>
    </div>
  )
}

function AppRow({ app, totalSec }: { app: AppUsageSummary; totalSec: number }) {
  const pct = percentOf(app.totalSeconds, totalSec)
  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-[var(--color-surface-raised)] group">
      <div className="w-7 h-7 rounded-md bg-[var(--color-surface-overlay)] flex items-center justify-center text-xs font-semibold text-[var(--color-text-secondary)]">
        {app.appName.slice(0, 2)}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] text-[var(--color-text-primary)] truncate">{app.appName}</p>
        <div className="mt-1 h-1 rounded-full bg-[var(--color-surface-overlay)] overflow-hidden">
          <div
            className="h-full rounded-full bg-[var(--color-accent)]"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <span className="text-[12px] text-[var(--color-text-secondary)] shrink-0">
        {formatDuration(app.totalSeconds)}
      </span>
    </div>
  )
}
