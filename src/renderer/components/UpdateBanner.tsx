import { useEffect, useState } from 'react'
import { ipc } from '../lib/ipc'
import type { UpdaterStatusInfo } from '../../preload/index'
import { extractReleaseHighlights } from '../lib/releaseNotes'

export default function UpdateBanner() {
  const [update, setUpdate] = useState<UpdaterStatusInfo | null>(null)

  useEffect(() => {
    void ipc.updater.getStatus().then((info) => setUpdate(info))
    const cleanup = ipc.updater.onStatus((info) => setUpdate(info))
    return cleanup
  }, [])

  if (!update) return null

  const highlights = extractReleaseHighlights(update.releaseNotesText, 2)

  if (update.status === 'checking' || update.status === 'not-available' || update.status === 'idle') {
    return null
  }

  if (update.status === 'downloading') {
    return (
      <div
        style={{
          padding: '10px 18px',
          background: 'linear-gradient(180deg, rgba(173,198,255,0.14), rgba(173,198,255,0.06))',
          borderBottom: '1px solid rgba(173,198,255,0.18)',
          color: 'var(--color-text-primary)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          flexWrap: 'wrap',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        <span
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: 'var(--color-primary)',
            boxShadow: '0 0 0 6px rgba(173,198,255,0.12)',
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '-0.01em' }}>
          Downloading Daylens {update.version ?? ''}
        </span>
        <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
          {typeof update.progressPct === 'number'
            ? `${update.progressPct}% complete. You can keep using the app while it downloads.`
            : 'You can keep using the app while it downloads.'}
        </span>
        {highlights[0] && (
          <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
            Includes: {highlights[0]}
          </span>
        )}
      </div>
    )
  }

  if (update.status === 'error') {
    return (
      <div
        style={{
          padding: '10px 18px',
          background: 'linear-gradient(180deg, rgba(248,113,113,0.12), rgba(248,113,113,0.05))',
          borderBottom: '1px solid rgba(248,113,113,0.18)',
          color: 'var(--color-text-primary)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          flexWrap: 'wrap',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '-0.01em' }}>
          Update failed
        </span>
        <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
          {update.errorMessage ?? 'Daylens could not finish the update download.'}
        </span>
      </div>
    )
  }

  if (update.status === 'installing') {
    return (
      <div
        style={{
          padding: '10px 18px',
          background: 'linear-gradient(180deg, rgba(79,219,200,0.14), rgba(79,219,200,0.06))',
          borderBottom: '1px solid rgba(79,219,200,0.18)',
          color: 'var(--color-text-primary)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '-0.01em' }}>
          Installing Daylens {update.version ?? ''}
        </span>
        <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
          The app will close and finish the update automatically.
        </span>
      </div>
    )
  }

  return (
    <div
      style={{
        padding: '10px 18px',
        background: 'linear-gradient(180deg, rgba(173,198,255,0.16), rgba(173,198,255,0.08))',
        borderBottom: '1px solid rgba(173,198,255,0.24)',
        color: 'var(--color-text-primary)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        flexWrap: 'wrap',
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: 'var(--color-tertiary)',
          boxShadow: '0 0 0 6px rgba(79,219,200,0.10)',
          flexShrink: 0,
        }}
      />
      <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '-0.01em' }}>
        Daylens {update.version ?? ''} is ready
      </span>
      <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
        Restart once to finish installing the update.
      </span>
      {highlights[0] && (
        <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
          Includes: {highlights[0]}
        </span>
      )}
      <button
        onClick={() => void ipc.updater.install()}
        style={{
          padding: '6px 12px',
          borderRadius: 999,
          border: 'none',
          background: 'var(--gradient-primary)',
          color: 'var(--color-primary-contrast)',
          fontSize: 12,
          fontWeight: 700,
          cursor: 'pointer',
          fontFamily: 'inherit',
          letterSpacing: '-0.01em',
          boxShadow: '0 10px 22px rgba(15,99,219,0.18)',
        }}
      >
        Restart to update
      </button>
    </div>
  )
}
