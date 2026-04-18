import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useResolvedIcon } from '../hooks/useResolvedIcon'

export default function SiteIcon({
  domain,
  pageUrl,
  size = 28,
  fallback,
}: {
  domain?: string | null
  pageUrl?: string | null
  size?: number
  fallback: ReactNode
}) {
  const [didError, setDidError] = useState(false)
  const resolved = useResolvedIcon({
    kind: 'site',
    domain,
    pageUrl,
  })

  useEffect(() => {
    setDidError(false)
  }, [domain, pageUrl])

  const iconUrl = didError ? null : resolved?.dataUrl ?? null
  if (!iconUrl) return <>{fallback}</>

  return (
    <img
      src={iconUrl}
      alt={domain ?? 'Website'}
      width={size}
      height={size}
      style={{
        width: size,
        height: size,
        display: 'block',
        objectFit: 'cover',
        borderRadius: Math.max(8, Math.round(size * 0.28)),
        flexShrink: 0,
      }}
      onError={() => {
        console.warn('[icons] site icon failed to render', {
          domain: domain ?? null,
          pageUrl: pageUrl ?? null,
          source: resolved?.source ?? 'miss',
          cacheKey: resolved?.cacheKey ?? null,
        })
        setDidError(true)
      }}
    />
  )
}
