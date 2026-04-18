import { useEffect, useState } from 'react'
import type { IconRequest, ResolvedIconPayload } from '@shared/types'
import { ipc } from '../lib/ipc'

const iconCache = new Map<string, ResolvedIconPayload>()

function normalizeRequest(request: IconRequest): IconRequest {
  if (request.kind === 'app') {
    return {
      kind: 'app',
      appInstanceId: request.appInstanceId?.trim() || null,
      bundleId: request.bundleId?.trim() || null,
      appName: request.appName?.trim() || null,
      canonicalAppId: request.canonicalAppId?.trim() || null,
    }
  }

  if (request.kind === 'site') {
    return {
      kind: 'site',
      domain: request.domain?.trim().toLowerCase() || null,
      pageUrl: request.pageUrl?.trim() || null,
    }
  }

  return {
    kind: 'artifact',
    artifactType: request.artifactType,
    canonicalAppId: request.canonicalAppId?.trim() || null,
    ownerBundleId: request.ownerBundleId?.trim() || null,
    ownerAppName: request.ownerAppName?.trim() || null,
    ownerAppInstanceId: request.ownerAppInstanceId?.trim() || null,
    path: request.path?.trim() || null,
    url: request.url?.trim() || null,
    host: request.host?.trim().toLowerCase() || null,
    title: request.title?.trim() || null,
  }
}

export function useResolvedIcon(request: IconRequest | null | undefined): ResolvedIconPayload | undefined {
  const serialized = request ? JSON.stringify(normalizeRequest(request)) : ''

  const [resolved, setResolved] = useState<ResolvedIconPayload | undefined>(
    serialized && iconCache.has(serialized) ? iconCache.get(serialized) : undefined,
  )

  useEffect(() => {
    if (!serialized) {
      setResolved(undefined)
      return
    }

    const cached = iconCache.get(serialized)
    if (cached) {
      setResolved(cached)
      return
    }

    let cancelled = false
    const payload = JSON.parse(serialized) as IconRequest

    void ipc.icons.resolve(payload)
      .then((response) => {
        iconCache.set(serialized, response)
        iconCache.set(response.cacheKey, response)
        if (!response.dataUrl) {
          console.warn('[icons] renderer icon miss', {
            request: payload,
            source: response.source,
            cacheKey: response.cacheKey,
          })
        }
        if (!cancelled) setResolved(response)
      })
      .catch((error) => {
        console.warn('[icons] renderer icon resolve failed', {
          request: payload,
          error: error instanceof Error ? error.message : String(error),
        })
        const miss: ResolvedIconPayload = {
          cacheKey: serialized,
          dataUrl: null,
          source: 'miss',
        }
        iconCache.set(serialized, miss)
        if (!cancelled) setResolved(miss)
      })

    return () => {
      cancelled = true
    }
  }, [serialized])

  return resolved
}
