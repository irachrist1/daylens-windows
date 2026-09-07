// Settings → Memory → recorded sources (DEV-183): the browser over the
// recorded context-packet ledger. Every AI exchange that assembled context is
// listed — question, when, how much, where it went — and any row opens the
// same read-only inspector the chat answers use. Works with no model
// configured: the ledger is local and the view never calls a provider.
import { useEffect, useState } from 'react'
import type { ContextPacketListEntry } from '@shared/types'
import { ipc } from '../../lib/ipc'
import { ContextPacketInspector } from '../../components/ContextPacketInspector'

const KIND_SHORT_LABELS: Record<string, string> = {
  day_fact: 'timeline',
  corrected_fact: 'memory',
  entity: 'entities',
  search_exact: 'search',
  search_semantic: 'by meaning',
  file_excerpt: 'files',
}

function countsSummary(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${KIND_SHORT_LABELS[kind] ?? kind}`)
  return parts.join(' · ')
}

export function ContextPacketSection() {
  const [entries, setEntries] = useState<ContextPacketListEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openPacketId, setOpenPacketId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ipc.contextPackets.listEntries({ limit: 30 })
      .then((rows) => { if (!cancelled) setEntries(rows) })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError))
      })
    return () => { cancelled = true }
  }, [])

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <span style={{ fontSize: 13, fontWeight: 650, color: 'var(--color-text-primary)' }}>Recorded sources</span>
      <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)', lineHeight: 1.55 }}>
        Every AI answer starts from a recorded context packet — the exact facts, search hits, and file
        excerpts selected for that question, written down before anything leaves this device. Open any
        exchange to see what was sent, why each item was included, and what was held back.
      </span>
      {error && <div style={{ fontSize: 12.5, color: '#f87171' }}>{error}</div>}
      {entries === null ? (
        <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>Loading…</div>
      ) : entries.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.6 }}>
          Nothing recorded yet. The first time you ask the AI a question, the context it is shown
          lands here before the request is made.
        </div>
      ) : (
        entries.map((entry) => (
          <button
            key={entry.packetId}
            type="button"
            onClick={() => setOpenPacketId(entry.packetId)}
            title="Open this exchange's recorded context"
            style={{ display: 'grid', gap: 3, padding: '9px 11px', borderRadius: 10, border: '1px solid var(--color-border)', background: 'transparent', cursor: 'pointer', textAlign: 'left', width: '100%' }}
          >
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {entry.question || '(empty question)'}
            </span>
            <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
              <span>{new Date(entry.createdAt).toLocaleString()}</span>
              <span>{entry.itemCount} item{entry.itemCount === 1 ? '' : 's'}{entry.itemCount > 0 ? ` — ${countsSummary(entry.counts)}` : ''}</span>
              <span>→ {entry.destination}</span>
            </span>
          </button>
        ))
      )}
      {openPacketId && (
        <ContextPacketInspector packetId={openPacketId} onClose={() => setOpenPacketId(null)} />
      )}
    </div>
  )
}
