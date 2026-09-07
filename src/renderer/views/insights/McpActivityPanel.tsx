import { useCallback, useEffect, useState } from 'react'
import { Activity, RefreshCw } from 'lucide-react'
import type { McpActivityEntry } from '@shared/types'
import { ipc } from '../../lib/ipc'

const POLL_MS = 2_000

function formatWhen(iso: string): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return iso || 'Unknown time'
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })
}

function formatArgs(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2)
  } catch {
    return String(value)
  }
}

export function McpActivityPanel() {
  const [entries, setEntries] = useState<McpActivityEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true)
    try {
      const result = await ipc.ai.getMcpActivity()
      setEntries([...result.entries].reverse())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (!silent) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { void load(true) }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [load])

  return (
    <aside
      style={{ flexShrink: 0, width: 280, display: 'flex', flexDirection: 'column', height: '100%', borderLeft: '1px solid var(--color-border-ghost)', background: 'var(--color-surface-low)' }}
      aria-label="External MCP activity"
    >
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '12px 12px 10px', borderBottom: '1px solid var(--color-border-ghost)' }}>
        <Activity size={14} strokeWidth={1.8} aria-hidden="true" style={{ color: 'var(--color-text-tertiary)' }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 680, color: 'var(--color-text-primary)' }}>MCP activity</div>
          <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 1 }}>External tool calls</div>
        </div>
        <button
          type="button"
          onClick={() => { void load() }}
          aria-label="Refresh MCP activity"
          title="Refresh"
          style={{ width: 26, height: 26, border: 'none', borderRadius: 6, background: 'transparent', color: 'var(--color-text-tertiary)', cursor: 'pointer', display: 'grid', placeItems: 'center' }}
        >
          <RefreshCw size={13} strokeWidth={1.9} style={{ opacity: refreshing ? 0.5 : 1 }} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 10px 14px' }}>
        {error ? (
          <div role="alert" style={{ padding: '10px 8px', fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
            Could not load MCP activity. {error}
            <button
              type="button"
              onClick={() => { void load() }}
              style={{ display: 'block', marginTop: 8, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', color: 'var(--color-text-primary)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}
            >
              Retry
            </button>
          </div>
        ) : entries == null ? (
          <div style={{ padding: '10px 8px', fontSize: 12, color: 'var(--color-text-tertiary)' }}>Loading…</div>
        ) : entries.length === 0 ? (
          <div style={{ padding: '10px 8px', fontSize: 12, color: 'var(--color-text-tertiary)', lineHeight: 1.55 }}>
            No external MCP calls yet. When Claude Code, Cursor, or Claude Desktop uses the Daylens server, those tool calls show up here.
          </div>
        ) : (
          entries.map((entry, index) => (
            <article
              key={`${entry.timestamp}:${entry.tool}:${index}`}
              style={{ padding: '8px 8px 10px', marginBottom: 4, borderRadius: 8, background: 'var(--color-surface)' }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <div style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--color-text-primary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {entry.tool}
                </div>
                <div style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 10.5, fontWeight: 650, color: entry.ok ? 'var(--color-text-tertiary)' : '#ef4444' }}>
                  {entry.ok ? 'ok' : 'error'}
                </div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                {formatWhen(entry.timestamp)}
              </div>
              {!entry.ok && entry.error && (
                <div style={{ fontSize: 11.5, color: '#ef4444', marginTop: 6, lineHeight: 1.45 }}>
                  {entry.error}
                </div>
              )}
              <pre style={{ margin: '7px 0 0', padding: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 10.5, lineHeight: 1.45, color: 'var(--color-text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {formatArgs(entry.arguments)}
              </pre>
            </article>
          ))
        )}
      </div>
    </aside>
  )
}
