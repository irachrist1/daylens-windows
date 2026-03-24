import { useEffect, useState } from 'react'
import { ipc } from '../lib/ipc'

interface UpdateInfo {
  status: 'available' | 'downloaded'
  version: string
}

export default function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null)

  useEffect(() => {
    const cleanup = ipc.updater.onStatus((info) => setUpdate(info))
    return cleanup
  }, [])

  if (!update) return null

  if (update.status === 'available') {
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
          Downloading Daylens {update.version}
        </span>
        <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
          You can keep using the app while it downloads.
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
        Daylens {update.version} is ready
      </span>
      <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
        Restart once to finish installing the update.
      </span>
      <button
        onClick={() => ipc.updater.install()}
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
