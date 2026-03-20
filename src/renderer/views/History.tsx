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
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">History</h1>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="px-3 py-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[13px] text-[var(--color-text-primary)] outline-none"
        />
      </div>

      {loading ? (
        <p className="text-[var(--color-text-secondary)] text-sm">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="text-[var(--color-text-secondary)] text-sm">No sessions recorded for this date.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {sessions.map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-[var(--color-surface-raised)]"
            >
              <span className="text-[11px] text-[var(--color-text-secondary)] w-20 shrink-0">
                {formatTime(s.startTime)}
              </span>
              <div className="w-7 h-7 rounded-md bg-[var(--color-surface-overlay)] flex items-center justify-center text-xs font-semibold text-[var(--color-text-secondary)]">
                {s.appName.slice(0, 2)}
              </div>
              <p className="flex-1 text-[13px] text-[var(--color-text-primary)] truncate">{s.appName}</p>
              <span className="text-[12px] text-[var(--color-text-secondary)] shrink-0">
                {formatDuration(s.durationSeconds)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
