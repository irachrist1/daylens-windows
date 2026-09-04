// Settings → Memory files. The surface that turns "your memory is local" from a
// claim into something a person can check: it names the folder, lists the days
// in it, and opens any of them in the file manager.
//
// The Codex export is a separate opt-in because it writes outside Daylens's own
// data directory, into a folder other agents read.
import { useCallback, useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { ipc } from '../../lib/ipc'

const MAX_VISIBLE_DAYS = 12

function formatDay(date: string): string {
  const parsed = new Date(`${date}T12:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return date
  return parsed.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export function MemoryFilesSection({
  settings,
  persist,
}: {
  settings: AppSettings
  persist: (partial: Partial<AppSettings>) => Promise<boolean>
}) {
  const [days, setDays] = useState<string[] | null>(null)
  const [root, setRoot] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const enabled = settings.memoryMirrorEnabled !== false

  const reload = useCallback(async () => {
    try {
      const [listed, rootPath] = await Promise.all([
        ipc.memoryMirror.list(),
        ipc.memoryMirror.root(),
      ])
      setDays(listed)
      setRoot(rootPath)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  async function reveal(date: string) {
    setError(null)
    const ok = await ipc.memoryMirror.reveal(date).catch(() => false)
    if (!ok) setError(`Could not open the file for ${date}. It may not have been written yet.`)
  }

  async function writeToday() {
    setBusy(true)
    setError(null)
    try {
      const today = new Date()
      const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      await ipc.memoryMirror.sync(iso)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const visible = expanded ? (days ?? []) : (days ?? []).slice(0, MAX_VISIBLE_DAYS)

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <Row
        title="Keep a readable copy of each day"
        detail="One Markdown file per finished day, in a folder you own. Open it, read it, edit it, delete it — it is a plain text file."
        checked={enabled}
        onChange={(value) => void persist({ memoryMirrorEnabled: value })}
      />

      <Row
        title="Let Codex and Claude Code read it"
        detail="Also writes the same files into the Codex memories folder, so agents can answer questions about your work without Daylens sending anything anywhere."
        checked={settings.memoryMirrorCodexExport === true}
        onChange={(value) => void persist({ memoryMirrorCodexExport: value })}
        disabled={!enabled}
      />

      {root && (
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', wordBreak: 'break-all' }}>
          {root}
        </div>
      )}

      <div style={{ display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>
            {days === null ? 'Days' : `${days.length} day${days.length === 1 ? '' : 's'} written`}
          </span>
          <button
            type="button"
            onClick={() => void writeToday()}
            disabled={busy || !enabled}
            style={{
              marginLeft: 'auto',
              fontSize: 12,
              padding: '4px 10px',
              borderRadius: 6,
              border: '1px solid var(--color-border-ghost)',
              background: 'transparent',
              color: 'var(--color-text-secondary)',
              cursor: busy || !enabled ? 'default' : 'pointer',
              opacity: busy || !enabled ? 0.5 : 1,
            }}
          >
            {busy ? 'Writing…' : 'Write today'}
          </button>
        </div>

        {days === null ? (
          <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>Loading…</div>
        ) : days.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
            No days yet. Daylens writes a day once it has finished — history fills in on its own in
            the background.
          </div>
        ) : (
          <div style={{ display: 'grid' }}>
            {visible.map((date) => (
              <div
                key={date}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 0',
                  fontSize: 12.5,
                  borderBottom: '1px solid var(--color-border-ghost, rgba(128,128,128,0.12))',
                }}
              >
                <span style={{ color: 'var(--color-text-primary)' }}>{formatDay(date)}</span>
                <button
                  type="button"
                  onClick={() => void reveal(date)}
                  style={{
                    marginLeft: 'auto',
                    fontSize: 12,
                    padding: '2px 8px',
                    borderRadius: 6,
                    border: '1px solid var(--color-border-ghost)',
                    background: 'transparent',
                    color: 'var(--color-text-secondary)',
                    cursor: 'pointer',
                  }}
                >
                  Show file
                </button>
              </div>
            ))}
            {days.length > MAX_VISIBLE_DAYS && (
              <button
                type="button"
                onClick={() => setExpanded((current) => !current)}
                style={{
                  marginTop: 8,
                  justifySelf: 'start',
                  fontSize: 12,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--color-primary-glow, #4a9eff)',
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                {expanded ? 'Show fewer' : `Show all ${days.length}`}
              </button>
            )}
          </div>
        )}
      </div>

      {error && (
        <div style={{ fontSize: 12.5, color: 'var(--color-danger, #d33)', lineHeight: 1.5 }}>{error}</div>
      )}
    </div>
  )
}

function Row({
  title,
  detail,
  checked,
  onChange,
  disabled,
}: {
  title: string
  detail: string
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}) {
  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', opacity: disabled ? 0.5 : 1 }}>
      <div style={{ flex: 1, display: 'grid', gap: 3 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>{title}</span>
        <span style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>{detail}</span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        style={{
          flexShrink: 0,
          width: 44,
          height: 26,
          borderRadius: 999,
          border: `1px solid ${checked ? 'var(--color-primary-glow)' : 'var(--color-border-ghost)'}`,
          background: checked ? 'var(--color-primary-glow)' : 'transparent',
          position: 'relative',
          cursor: disabled ? 'default' : 'pointer',
          transition: 'background 120ms ease, border-color 120ms ease',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: checked ? 20 : 2,
            width: 20,
            height: 20,
            borderRadius: 999,
            background: checked ? '#fff' : 'var(--color-text-tertiary)',
            transition: 'left 120ms ease',
          }}
        />
      </button>
    </div>
  )
}
