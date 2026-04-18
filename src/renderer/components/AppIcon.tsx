import { useEffect, useState } from 'react'
import { appInitials } from '../lib/apps'
import { useResolvedIcon } from '../hooks/useResolvedIcon'

export default function AppIcon({
  appInstanceId,
  bundleId,
  canonicalAppId,
  appName,
  color = 'var(--color-primary)',
  size = 28,
  fontSize = 10,
  cornerRadius,
}: {
  appInstanceId?: string | null
  bundleId?: string | null
  canonicalAppId?: string | null
  appName: string
  color?: string
  size?: number
  fontSize?: number
  cornerRadius?: number
}) {
  const [didError, setDidError] = useState(false)
  const resolved = useResolvedIcon({
    kind: 'app',
    appInstanceId,
    bundleId,
    canonicalAppId,
    appName,
  })

  useEffect(() => {
    setDidError(false)
  }, [appInstanceId, appName, bundleId, canonicalAppId])

  const rounded = cornerRadius ?? Math.round(size * 0.26)
  const iconUrl = didError ? null : resolved?.dataUrl ?? null

  if (iconUrl) {
    return (
      <img
        src={iconUrl}
        alt={appName}
        width={size}
        height={size}
        style={{
          width: size,
          height: size,
          borderRadius: rounded,
          display: 'block',
          objectFit: 'contain',
          flexShrink: 0,
        }}
        onError={() => {
          console.warn('[icons] app icon failed to render', {
            appName,
            appInstanceId: appInstanceId ?? null,
            bundleId: bundleId ?? null,
            canonicalAppId: canonicalAppId ?? null,
            source: resolved?.source ?? 'miss',
            cacheKey: resolved?.cacheKey ?? null,
          })
          setDidError(true)
        }}
      />
    )
  }

  // Derive a subtle background from the category color if provided
  const fallbackBg = color && color !== 'var(--color-primary)'
    ? (() => {
        const hex = color.replace('#', '')
        if (!/^[0-9a-fA-F]{3,6}$/.test(hex)) return 'var(--color-pill-bg)'
        const expanded = hex.length === 3 ? hex.split('').map((c) => `${c}${c}`).join('') : hex
        const v = Number.parseInt(expanded, 16)
        return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, 0.14)`
      })()
    : 'var(--color-pill-bg)'

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: rounded,
        background: fallbackBg,
        color,
        fontSize,
        fontWeight: 700,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {appInitials(appName)}
    </div>
  )
}
