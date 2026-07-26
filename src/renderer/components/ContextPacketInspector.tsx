// The shared-context inspector (DEV-183, agent-runtime-and-context.md
// §Context inspection): the read-only view of the recorded context packet
// behind one AI exchange. Everything shown is re-read from the local disclosure ledger —
// nothing here calls a model, and nothing here can be edited. The view is
// honest about absence (empty groups say plainly that nothing of that kind
// was sent) and about time (evidence deleted after the exchange stays in the
// record, labeled as no longer present).
import { useEffect, useState } from 'react'
import type {
  ContextPacketInspection,
  ContextPacketInspectionGroup,
  ContextPacketInspectionItem,
} from '@shared/types'
import { ipc } from '../lib/ipc'

export interface ContextPacketInspectorProps {
  /** Open by packet id when the exchange carried one… */
  packetId?: string | null
  /** …or by the persisted assistant message id as the fallback lookup. */
  messageId?: number | null
  onClose: () => void
}

// Honest empty lines per group — "nothing of this kind was sent" is a
// statement, not a blank.
const GROUP_EMPTY_TEXT: Record<string, string> = {
  day_fact: 'No timeline facts were sent.',
  corrected_fact: 'No memory facts about you were sent.',
  entity: 'The question named no known people, projects, or things.',
  search_exact: 'No exact search matches were sent.',
  search_semantic: 'No by-meaning matches were sent.',
  file_excerpt: 'No file contents were sent.',
}

const SOURCE_TYPE_LABELS: Record<string, string> = {
  observed: 'observed on this device',
  connected: 'from a connected source',
  supplied: 'you told Daylens',
  inferred: 'inferred from evidence',
}

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.07em',
  textTransform: 'uppercase',
  color: 'var(--color-text-tertiary)',
}

const quietTextStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-tertiary)',
  lineHeight: 1.55,
}

const badgeStyle: React.CSSProperties = {
  fontSize: 10.5,
  padding: '1px 7px',
  borderRadius: 999,
  border: '1px solid var(--color-border-ghost)',
  color: 'var(--color-text-tertiary)',
  whiteSpace: 'nowrap',
}

function PacketItemRow({ item }: { item: ContextPacketInspectionItem }) {
  const gone = item.evidenceState !== 'present'
  return (
    <div style={{ display: 'grid', gap: 4, padding: '8px 10px', borderRadius: 10, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface-low)' }}>
      <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--color-text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', ...(gone ? { opacity: 0.75 } : {}) }}>
        {item.statement}
      </div>
      <div style={{ ...quietTextStyle, fontSize: 11.5 }}>
        Why: {item.reason}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
        <span style={badgeStyle}>{SOURCE_TYPE_LABELS[item.sourceType] ?? item.sourceType}</span>
        {item.sensitivity !== 'standard' && (
          <span style={{ ...badgeStyle, borderColor: 'rgba(248, 113, 113, 0.4)', color: '#f87171' }}>
            {item.sensitivity === 'high' ? 'high-sensitivity' : item.sensitivity}
          </span>
        )}
        {item.date && <span style={badgeStyle}>{item.date}</span>}
        {item.version && (
          <span style={badgeStyle} title={item.version}>
            v {item.version.length > 18 ? `${item.version.slice(0, 18)}…` : item.version}
          </span>
        )}
        <span style={{ ...badgeStyle, fontFamily: 'var(--font-mono, monospace)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }} title={item.identity}>
          {item.identity}
        </span>
      </div>
      {gone && item.evidenceNote && (
        <div style={{ fontSize: 11.5, lineHeight: 1.5, color: '#f59e0b' }}>
          {item.evidenceNote}
        </div>
      )}
    </div>
  )
}

function PacketGroup({ group }: { group: ContextPacketInspectionGroup }) {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--color-text-primary)' }}>{group.label}</span>
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
          {group.items.length === 0 ? '' : group.items.length}
        </span>
      </div>
      {group.items.length === 0 ? (
        <div style={quietTextStyle}>{GROUP_EMPTY_TEXT[group.kind] ?? 'Nothing of this kind was sent.'}</div>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {group.items.map((item) => (
            <PacketItemRow key={`${group.kind}:${item.identity}:${item.statement.slice(0, 40)}`} item={item} />
          ))}
        </div>
      )}
    </div>
  )
}

export function ContextPacketInspector({ packetId, messageId, onClose }: ContextPacketInspectorProps) {
  const [inspection, setInspection] = useState<ContextPacketInspection | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    setInspection(null)
    ipc.contextPackets.inspect({ packetId: packetId ?? null, messageId: messageId ?? null })
      .then((result) => {
        if (cancelled) return
        setInspection(result)
        setLoaded(true)
      })
      .catch((loadError) => {
        if (cancelled) return
        setError(loadError instanceof Error ? loadError.message : String(loadError))
        setLoaded(true)
      })
    return () => { cancelled = true }
  }, [packetId, messageId])

  return (
    <div
      role="dialog"
      aria-label="Shared context"
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 24 }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div style={{ background: 'var(--color-surface-card, var(--color-surface))', border: '1px solid var(--color-border)', borderRadius: 16, width: 640, maxWidth: '100%', maxHeight: 'min(84vh, 900px)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '18px 20px 12px' }}>
          <div style={{ display: 'grid', gap: 3, flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 15.5, fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--color-text-primary)' }}>
              Shared context
            </span>
            <span style={{ ...quietTextStyle, fontSize: 11.5 }}>
              The exact context recorded for this exchange, before the request left this device. Read-only.
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ border: 'none', background: 'transparent', color: 'var(--color-text-tertiary)', fontSize: 18, lineHeight: 1, cursor: 'pointer', padding: 4 }}
          >
            ×
          </button>
        </div>

        <div style={{ overflowY: 'auto', padding: '4px 20px 20px', display: 'grid', gap: 18 }}>
          {!loaded ? (
            <div style={quietTextStyle}>Loading the recorded packet…</div>
          ) : error ? (
            <div style={{ fontSize: 12.5, color: '#f87171', lineHeight: 1.6 }}>{error}</div>
          ) : !inspection ? (
            // Honest absence: nothing was recorded for this exchange — either
            // it predates the packet ledger, or the whole record was since
            // deleted by a privacy purge. Say so; never reconstruct one.
            <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.65 }}>
              No context record exists for this answer. Either the answer predates
              context recording, or the record was removed by a deletion you made.
              Daylens will not reconstruct one after the fact.
            </div>
          ) : (
            <>
              <div style={{ display: 'grid', gap: 4 }}>
                <span style={sectionTitleStyle}>The question</span>
                <div style={{ fontSize: 13, color: 'var(--color-text-primary)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                  {inspection.question}
                </div>
                <div style={quietTextStyle}>
                  {new Date(inspection.createdAt).toLocaleString()}
                  {inspection.dates.length > 0 && ` · about ${inspection.dates.join(', ')}`}
                  {` · ${inspection.timezone}`}
                </div>
              </div>

              <div style={{ display: 'grid', gap: 6 }}>
                <span style={sectionTitleStyle}>What left this device</span>
                <div style={{ display: 'grid', gap: 3, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--color-border-ghost)', fontSize: 12, lineHeight: 1.6, color: 'var(--color-text-secondary)' }}>
                  <span>
                    {inspection.leftDevice
                      ? <>The {inspection.itemCount} item{inspection.itemCount === 1 ? '' : 's'} below were sent to <strong style={{ fontWeight: 650 }}>{inspection.destination}</strong>.</>
                      : <>{inspection.itemCount} item{inspection.itemCount === 1 ? '' : 's'} were assembled; nothing left this device.</>}
                  </span>
                  <span style={quietTextStyle}>
                    Recorded {new Date(inspection.createdAt).toLocaleString()}, before the request was made.
                  </span>
                  <span style={{ ...quietTextStyle, fontFamily: 'var(--font-mono, monospace)', fontSize: 10.5 }}>
                    policy v{inspection.policyVersion} · content fingerprint {inspection.contentFingerprint.slice(0, 16)}…
                  </span>
                </div>
              </div>

              {inspection.groups.map((group) => (
                <PacketGroup key={group.kind} group={group} />
              ))}

              <div style={{ display: 'grid', gap: 6 }}>
                <span style={sectionTitleStyle}>Tools consulted</span>
                {inspection.toolsConsulted === null ? (
                  <div style={quietTextStyle}>
                    No turn record is bound to this exchange, so the tools it called cannot be listed here.
                  </div>
                ) : inspection.toolsConsulted.length === 0 ? (
                  <div style={quietTextStyle}>The answer used no tools — it came from the context above.</div>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                    {inspection.toolsConsulted.map((consulted) => (
                      <span key={consulted.tool} style={badgeStyle} title={consulted.source === 'mcp' ? 'One of your own MCP servers' : 'Built-in Daylens tool'}>
                        {consulted.tool}
                        {consulted.calls > 1 ? ` ×${consulted.calls}` : ''}
                        {consulted.source === 'mcp' ? ' · your MCP server' : ''}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ display: 'grid', gap: 6 }}>
                <span style={sectionTitleStyle}>Considered and not sent</span>
                {inspection.omissions.length === 0 ? (
                  <div style={quietTextStyle}>Nothing that matched this question was held back.</div>
                ) : (
                  inspection.omissions.map((omission, index) => (
                    <div key={`${omission.kind}:${omission.reason}:${index}`} style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--color-text-secondary)' }}>
                      {omission.label}
                    </div>
                  ))
                )}
              </div>

              <div style={{ display: 'grid', gap: 6 }}>
                <span style={sectionTitleStyle}>Where the record disagreed with itself</span>
                {inspection.conflicts.length === 0 ? (
                  <div style={quietTextStyle}>No conflicts between sources were recorded for this exchange.</div>
                ) : (
                  inspection.conflicts.map((conflict) => (
                    <div key={conflict.identity + conflict.detail} style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--color-text-secondary)' }}>
                      {conflict.detail}
                      {conflict.resolvedBy === 'correction' && (
                        <span style={{ color: 'var(--color-text-tertiary)' }}> — your correction won</span>
                      )}
                    </div>
                  ))
                )}
              </div>

              <div style={{ display: 'grid', gap: 6 }}>
                <span style={sectionTitleStyle}>Gaps in the record</span>
                {inspection.gaps.length === 0 ? (
                  <div style={quietTextStyle}>No capture gaps were recorded for the requested day{inspection.dates.length === 1 ? '' : 's'}.</div>
                ) : (
                  inspection.gaps.map((gap, index) => (
                    <div key={`${gap.date}:${index}`} style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--color-text-secondary)' }}>
                      {gap.detail} ({gap.date})
                    </div>
                  ))
                )}
              </div>

              <div style={{ display: 'grid', gap: 6 }}>
                <span style={sectionTitleStyle}>Permissions consulted</span>
                {inspection.permissions.length === 0 ? (
                  <div style={quietTextStyle}>No file access was granted at the time — the AI could not read any file contents.</div>
                ) : (
                  inspection.permissions.map((permission) => (
                    <div key={`${permission.path}:${permission.state}`} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--color-text-secondary)' }}>
                      <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{permission.path}</span>
                      <span style={badgeStyle}>{permission.scopeKind}</span>
                      <span style={badgeStyle}>{permission.state === 'model_readable' ? 'model-readable' : 'indexed (local only)'}</span>
                      {permission.allowHighSensitivity && <span style={badgeStyle}>high-sensitivity allowed</span>}
                    </div>
                  ))
                )}
              </div>

              <div style={quietTextStyle}>
                This record never includes provider system prompts, hidden model reasoning, or credentials —
                only your own data that was selected for this question.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
