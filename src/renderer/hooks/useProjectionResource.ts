import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectionInvalidationEvent, ProjectionScope } from '@shared/core'
import { ipc } from '../lib/ipc'

interface UseProjectionResourceOptions<T> {
  scope: ProjectionScope
  load: () => Promise<T>
  enabled?: boolean
  intervalMs?: number
  pauseWhenHidden?: boolean
  shouldReload?: (event: ProjectionInvalidationEvent) => boolean
  dependencies?: ReadonlyArray<unknown>
}

interface UseProjectionResourceState<T> {
  data: T | null
  error: string | null
  loading: boolean
  reloading: boolean
  refresh: () => Promise<void>
}

export function useProjectionResource<T>({
  scope,
  load,
  enabled = true,
  intervalMs = 0,
  pauseWhenHidden = true,
  shouldReload,
  dependencies = [],
}: UseProjectionResourceOptions<T>): UseProjectionResourceState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloading, setReloading] = useState(false)
  const mountedRef = useRef(true)
  const requestIdRef = useRef(0)
  const dataRef = useRef<T | null>(null)
  const inFlightRef = useRef<Promise<void> | null>(null)
  const pendingRefreshRef = useRef(false)
  // Callers typically pass `load` as an inline function, so its identity changes
  // every render. Keep the latest in a ref so `refresh` stays stable — otherwise
  // the mount effect would re-fire every render, flooding IPC and leaking memory.
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    dataRef.current = data
  }, [data])

  const refresh = useCallback(async () => {
    if (!enabled) return
    if (pauseWhenHidden && document.hidden) return

    if (inFlightRef.current) {
      pendingRefreshRef.current = true
      return inFlightRef.current
    }

    const requestId = ++requestIdRef.current
    const isInitial = dataRef.current === null
    setError(null)
    if (isInitial) {
      setLoading(true)
    } else {
      setReloading(true)
    }

    const request = loadRef.current()
      .then((next) => {
        if (!mountedRef.current || requestId !== requestIdRef.current) return
        dataRef.current = next
        setData(next)
        setError(null)
      })
      .catch((err) => {
        if (!mountedRef.current || requestId !== requestIdRef.current) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (mountedRef.current && requestId === requestIdRef.current) {
          setLoading(false)
          setReloading(false)
        }
        inFlightRef.current = null
        if (pendingRefreshRef.current && mountedRef.current) {
          pendingRefreshRef.current = false
          void refresh()
        }
      })
    inFlightRef.current = request
    return request
  }, [enabled, pauseWhenHidden])

  useEffect(() => {
    mountedRef.current = true
    if (enabled) {
      void refresh()
    } else {
      setLoading(false)
      setReloading(false)
    }

    return () => {
      mountedRef.current = false
      requestIdRef.current += 1
      inFlightRef.current = null
      pendingRefreshRef.current = false
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...dependencies])

  useEffect(() => {
    if (!enabled) return
    return ipc.projections.onInvalidated((event) => {
      const scopeMatches = event.scope === 'all' || event.scope === scope
      if (!scopeMatches) return
      if (shouldReload && !shouldReload(event)) return
      void refresh()
    })
  }, [enabled, refresh, scope, shouldReload])

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return
    const timer = window.setInterval(() => {
      void refresh()
    }, intervalMs)
    return () => window.clearInterval(timer)
  }, [enabled, intervalMs, refresh])

  return {
    data,
    error,
    loading,
    reloading,
    refresh,
  }
}
