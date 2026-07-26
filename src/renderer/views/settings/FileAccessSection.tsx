// Settings → Agent file access: grants and disclosure log.
// Observed metadata is always on; Indexed and Model-readable need an explicit grant.
// Paths are chosen with the system file picker — nobody should type a path.
import { useCallback, useEffect, useState } from 'react'
import { ipc } from '../../lib/ipc'

interface Grant {
  id: string
  scope_kind: 'file' | 'folder'
  path: string
  state: 'indexed' | 'model_readable'
  allow_high_sensitivity: number
  source: 'settings' | 'chat'
  created_at: number
  revoked_at: number | null
}

interface Disclosure {
  id: string
  thread_id: number | null
  file_path: string
  display_name: string
  version_fingerprint: string
  excerpt_start: number
  excerpt_end: number
  reason: string
  destination: string
  disclosed_at: number
}

const buttonStyle: React.CSSProperties = {
  fontSize: 12.5,
  padding: '7px 14px',
  borderRadius: 9,
  border: '1px solid var(--color-border-ghost)',
  background: 'var(--color-surface-low)',
  color: 'var(--color-text-primary)',
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: 'var(--gradient-primary)',
  color: 'var(--color-primary-contrast)',
  border: 'none',
  fontWeight: 620,
}

function stateLabel(state: Grant['state']): string {
  return state === 'model_readable' ? 'Model-readable' : 'Indexed'
}

function friendlyError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (/No handler registered|invoking remote method/i.test(raw)) {
    return 'Daylens needs a restart before this works. Quit the app, open it again, then try once more.'
  }
  if (/cancel/i.test(raw)) return fallback
  // Never surface IPC/channel plumbing to the person using Settings.
  if (/file-access:|Error invoking|ENOENT|EACCES/i.test(raw)) return fallback
  if (raw.length > 160 || /at\s+\S+\s+\(/.test(raw)) return fallback
  return raw || fallback
}

export function FileAccessSection() {
  const [grants, setGrants] = useState<Grant[]>([])
  const [disclosures, setDisclosures] = useState<Disclosure[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [draftPath, setDraftPath] = useState('')
  const [draftScope, setDraftScope] = useState<'file' | 'folder'>('folder')
  const [draftState, setDraftState] = useState<'indexed' | 'model_readable'>('model_readable')
  const [draftHighSensitivity, setDraftHighSensitivity] = useState(false)
  const [picking, setPicking] = useState(false)

  const reload = useCallback(async () => {
    try {
      const [grantRows, disclosureRows] = await Promise.all([
        ipc.fileAccess.listGrants({}),
        ipc.fileAccess.listDisclosures({ limit: 30 }),
      ])
      setGrants(grantRows as Grant[])
      setDisclosures(disclosureRows as Disclosure[])
      setError(null)
    } catch (loadError) {
      setError(friendlyError(loadError, 'Couldn’t load file access right now. Try again in a moment.'))
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  async function choosePath(scopeKind: 'file' | 'folder') {
    setPicking(true)
    setError(null)
    try {
      const chosen = await ipc.fileAccess.pickPath({ scopeKind })
      if (!chosen) return
      setDraftPath(chosen.path)
      setDraftScope(chosen.scopeKind)
      setAdding(true)
    } catch (pickError) {
      setError(friendlyError(pickError, 'Couldn’t open the file picker. Try again, or restart Daylens if it keeps failing.'))
    } finally {
      setPicking(false)
    }
  }

  return (
    <div style={{ display: 'grid', gap: 22 }}>
      <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.55 }}>
        Indexed keeps contents on this device. Model-readable can send excerpts to your AI.
        Secrets, system paths, and hidden folders are always off limits.
      </div>

      {error && <div style={{ fontSize: 12.5, color: '#f87171' }}>{error}</div>}

      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13.5, fontWeight: 620, color: 'var(--color-text-primary)' }}>
            Granted paths
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={picking}
              onClick={() => void choosePath('folder')}
            >
              {picking ? 'Opening…' : 'Choose folder…'}
            </button>
            <button
              type="button"
              style={buttonStyle}
              disabled={picking}
              onClick={() => void choosePath('file')}
            >
              Choose file…
            </button>
          </div>
        </div>

        {adding && draftPath && (
          <div
            style={{
              display: 'grid',
              gap: 10,
              padding: '14px 16px',
              borderRadius: 14,
              border: '1px solid var(--color-border-ghost)',
              background: 'var(--color-surface-low)',
            }}
          >
            <div style={{ fontSize: 12.5, color: 'var(--color-text-primary)', wordBreak: 'break-all' }}>
              {draftPath}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <select
                value={draftState}
                onChange={(event) => setDraftState(event.target.value as 'indexed' | 'model_readable')}
                style={{
                  fontSize: 12.5,
                  padding: '7px 10px',
                  borderRadius: 9,
                  border: '1px solid var(--color-border-ghost)',
                  background: 'var(--color-surface-high)',
                  color: 'var(--color-text-primary)',
                  fontFamily: 'inherit',
                }}
              >
                <option value="model_readable">Model-readable</option>
                <option value="indexed">Indexed (local only)</option>
              </select>
              <label style={{ fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'center', color: 'var(--color-text-secondary)' }}>
                <input
                  type="checkbox"
                  checked={draftHighSensitivity}
                  onChange={(event) => setDraftHighSensitivity(event.target.checked)}
                />
                Allow high-sensitivity files
              </label>
              <button
                type="button"
                style={{ ...primaryButtonStyle, marginLeft: 'auto' }}
                onClick={async () => {
                  try {
                    await ipc.fileAccess.addGrant({
                      scopeKind: draftScope,
                      path: draftPath,
                      state: draftState,
                      allowHighSensitivity: draftHighSensitivity,
                    })
                    setDraftPath('')
                    setAdding(false)
                    await reload()
                  } catch (addError) {
                    setError(friendlyError(addError, 'Couldn’t grant access to that path. Check you still have it, then try again.'))
                  }
                }}
              >
                Grant access
              </button>
              <button
                type="button"
                style={buttonStyle}
                onClick={() => { setAdding(false); setDraftPath('') }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {!loaded ? (
          <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>Loading…</div>
        ) : grants.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.55 }}>
            No grants yet. Choose a folder above, or let the AI ask in chat when it needs one.
          </div>
        ) : (
          grants.map((grant) => (
            <div
              key={grant.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 14px',
                borderRadius: 12,
                border: '1px solid var(--color-border-ghost)',
                background: 'var(--color-surface-low)',
                fontSize: 12.5,
              }}
            >
              <div style={{ display: 'grid', gap: 3, minWidth: 0, flex: 1 }}>
                <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {grant.path}
                </span>
                <span style={{ color: 'var(--color-text-tertiary)' }}>
                  {stateLabel(grant.state)}
                  {grant.allow_high_sensitivity === 1 ? ' · high-sensitivity' : ''}
                  {' · '}
                  {new Date(grant.created_at).toLocaleDateString()}
                </span>
              </div>
              <button
                type="button"
                style={buttonStyle}
                onClick={async () => {
                  try {
                    await ipc.fileAccess.revokeGrant(grant.id)
                    await reload()
                  } catch (revokeError) {
                    setError(friendlyError(revokeError, 'Couldn’t revoke that grant. Try again in a moment.'))
                  }
                }}
              >
                Revoke
              </button>
            </div>
          ))
        )}
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        <span style={{ fontSize: 13.5, fontWeight: 620, color: 'var(--color-text-primary)' }}>
          Recent reads
        </span>
        {disclosures.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.55 }}>
            Nothing read yet. Every file the AI reads shows up here.
          </div>
        ) : (
          disclosures.map((disclosure) => (
            <div
              key={disclosure.id}
              style={{
                display: 'grid',
                gap: 3,
                padding: '12px 14px',
                borderRadius: 12,
                border: '1px solid var(--color-border-ghost)',
                background: 'var(--color-surface-low)',
                fontSize: 12.5,
              }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <span style={{ fontWeight: 620, color: 'var(--color-text-primary)' }}>{disclosure.display_name}</span>
                <span style={{ marginLeft: 'auto', color: 'var(--color-text-tertiary)', fontSize: 11.5 }}>
                  {new Date(disclosure.disclosed_at).toLocaleString()}
                </span>
              </div>
              <span style={{ color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {disclosure.file_path}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
