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
          padding: '6px 16px',
          background: 'rgba(104,174,255,0.08)',
          borderBottom: '1px solid rgba(104,174,255,0.15)',
          fontSize: 12,
          color: 'var(--color-text-secondary)',
          textAlign: 'center',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        A new version is downloading…
      </div>
    )
  }

  return (
    <div
      style={{
        padding: '6px 16px',
        background: 'rgba(104,174,255,0.1)',
        borderBottom: '1px solid rgba(104,174,255,0.2)',
        fontSize: 12,
        color: 'var(--color-text-primary)',
        textAlign: 'center',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}
    >
      <span>Daylens {update.version} is ready</span>
      <button
        onClick={() => ipc.updater.install()}
        style={{
          padding: '3px 10px',
          borderRadius: 6,
          border: 'none',
          background: 'var(--color-accent)',
          color: 'var(--color-surface)',
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        Restart to update
      </button>
    </div>
  )
}
