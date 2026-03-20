import { useEffect, useRef, useState } from 'react'
import { ipc } from '../lib/ipc'
import { formatDuration } from '../lib/format'
import type { FocusSession } from '@shared/types'

export default function Focus() {
  const [active, setActive] = useState<FocusSession | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [label, setLabel] = useState('')
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    ipc.focus.getActive().then((s) => {
      if (s) {
        setActive(s as FocusSession)
      }
    })
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  useEffect(() => {
    if (active) {
      timerRef.current = setInterval(() => {
        setElapsed(Math.round((Date.now() - active.startTime) / 1000))
      }, 1000)
    } else {
      if (timerRef.current) clearInterval(timerRef.current)
      setElapsed(0)
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [active])

  async function handleStart() {
    const id = (await ipc.focus.start(label || undefined)) as number
    const session: FocusSession = {
      id,
      startTime: Date.now(),
      endTime: null,
      durationSeconds: 0,
      label: label || null,
    }
    setActive(session)
    setLabel('')
  }

  async function handleStop() {
    if (!active) return
    await ipc.focus.stop(active.id)
    setActive(null)
  }

  return (
    <div className="p-6 max-w-xl mx-auto">
      <h1 className="text-lg font-semibold text-[var(--color-text-primary)] mb-8">Focus</h1>

      <div className="flex flex-col items-center gap-6">
        {/* Timer display */}
        <div className="text-5xl font-mono font-semibold text-[var(--color-text-primary)] tabular-nums">
          {formatDuration(elapsed)}
        </div>

        {active && (
          <p className="text-[13px] text-[var(--color-text-secondary)]">
            {active.label ?? 'Focus session in progress'}
          </p>
        )}

        {!active && (
          <input
            type="text"
            placeholder="What are you focusing on? (optional)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleStart()}
            className="w-full max-w-sm px-3 py-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[13px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-secondary)] outline-none focus:border-[var(--color-accent)]"
          />
        )}

        <button
          onClick={active ? handleStop : handleStart}
          className={[
            'px-8 py-2.5 rounded-md text-[13px] font-medium transition-colors',
            active
              ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
              : 'bg-[var(--color-accent)] text-white hover:opacity-90',
          ].join(' ')}
        >
          {active ? 'Stop session' : 'Start focus session'}
        </button>
      </div>
    </div>
  )
}
