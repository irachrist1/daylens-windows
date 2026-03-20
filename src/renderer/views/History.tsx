import { useEffect, useState } from 'react'
import { ipc } from '../lib/ipc'
import { formatDuration, formatTime, todayString } from '../lib/format'
import type { AppSession } from '@shared/types'

export default function History() {
  const [date, setDate] = useState(todayString())
  const [sessions, setSessions] = useState<AppSession[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    ipc.db.getHistory(date).then((data) => {
      setSessions(data as AppSession[])
      setLoading(false)
    })
  }, [date])

  return (
    <div className="p-7 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-7">
        <div>
          <p className="section-label mb-1">History</p>
          <h1 className="text-2xl font-semibold text-[var(--color-text-primary)] tracking-tight">
            {sessions.length > 0 ? `${sessions.length} sessions` : 'Browse past days'}
          </h1>
        </div>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-card)] text-[13px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)] transition-colors"
        />
      </div>

      {loading ? (
        <div className="flex flex-col gap-px overflow-hidden rounded-xl border border-[var(--color-border)]">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="h-12 bg-[var(--color-surface-card)] animate-pulse" />
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-12 text-center">
          <p className="text-[14px] font-medium text-[var(--color-text-primary)] mb-1">No sessions</p>
          <p className="text-[13px] text-[var(--color-text-secondary)]">No activity recorded for this date.</p>
        </div>
      ) : (
        <div className="card p-0 overflow-hidden">
          {sessions.map((s, i) => (
            <div
              key={s.id}
              className={[
                'flex items-center gap-3 px-4 py-3 hover:bg-[var(--color-surface-high)] transition-colors',
                i < sessions.length - 1 ? 'border-b border-[var(--color-border)]' : '',
              ].join(' ')}
            >
              <span className="text-[11px] text-[var(--color-text-tertiary)] w-[72px] shrink-0 tabular-nums">
                {formatTime(s.startTime)}
              </span>
              <div className="w-7 h-7 rounded-md bg-[var(--color-surface-high)] flex items-center justify-center text-[11px] font-semibold text-[var(--color-text-secondary)] shrink-0">
                {s.appName.slice(0, 2).toUpperCase()}
              </div>
              <p className="flex-1 text-[13px] text-[var(--color-text-primary)] truncate">{s.appName}</p>
              <span className="text-[12px] text-[var(--color-text-secondary)] shrink-0 tabular-nums">
                {formatDuration(s.durationSeconds)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
