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
  /**
   * Coalesce a burst of invalidation events into a single refresh. A session
   * flush fans out several scope invalidations (timeline/apps/insights) and the
   * attribution pass fires more ~3s later, so without a debounce every mounted
   * view can refetch several times per flush. Only applies to invalidation-driven
   * refreshes; mount and interval refreshes are unaffected.
   */
  invalidationDebounceMs?: number
  dependencies?: ReadonlyArray<unknown>
}

interface UseProjectionResourceState<T> {
  data: T | null
  error: string | null
  loading: boolean
  reloading: boolean
  refresh: () => Promise<void>
}

function safeSerialize(value: unknown): string | null {
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

export function useProjectionResource<T>({
  scope,
  load,
  enabled = true,
  intervalMs = 0,
  pauseWhenHidden = true,
  shouldReload,
  invalidationDebounceMs = 250,
  dependencies = [],
}: UseProjectionResourceOptions<T>): UseProjectionResourceState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloading, setReloading] = useState(false)
  const mountedRef = useRef(true)
  const requestIdRef = useRef(0)
  const dataRef = useRef<T | null>(null)
  // Serialized form of the last payload we committed. Poll- and invalidation-
  // driven refreshes frequently return data identical to what is already
  // mounted; comparing the serialized payload lets us skip setData (and the
  // re-render of every consumer) when nothing actually changed (F28).
  const serializedRef = useRef<string | null>(null)
  const inFlightRef = useRef<Promise<void> | null>(null)
  const pendingRefreshRef = useRef(false)
  const skippedWhileHiddenRef = useRef(false)
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
    if (pauseWhenHidden && document.hidden) {
      // Remember the skipped refresh so the visibilitychange effect below can
      // run it when the window is shown again. Without this, a view mounted
      // while the window was hidden/occluded kept `loading` forever — a past
      // date has no poll interval, so nothing else would ever retry and the
      // view sat on skeletons with its data one IPC call away.
      skippedWhileHiddenRef.current = true
      return
    }

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
        setError(null)
        // Skip the commit when the refreshed payload is byte-identical to what is
        // already mounted, keeping the existing reference so memoized consumers
        // don't re-render. Falls through to a normal commit if serialization fails.
        const serialized = safeSerialize(next)
        if (serialized !== null && serialized === serializedRef.current) return
        serializedRef.current = serialized
        dataRef.current = next
        setData(next)
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
    if (!enabled || !pauseWhenHidden) return
    const onVisibilityChange = () => {
      if (document.hidden || !skippedWhileHiddenRef.current) return
      skippedWhileHiddenRef.current = false
      void refresh()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [enabled, pauseWhenHidden, refresh])

  useEffect(() => {
    if (!enabled) return
    let debounceTimer: number | null = null
    const unsubscribe = ipc.projections.onInvalidated((event) => {
      const scopeMatches = event.scope === 'all' || event.scope === scope
      if (!scopeMatches) return
      if (shouldReload && !shouldReload(event)) return
      if (invalidationDebounceMs <= 0) {
        void refresh()
        return
      }
      if (debounceTimer != null) window.clearTimeout(debounceTimer)
      debounceTimer = window.setTimeout(() => {
        debounceTimer = null
        void refresh()
      }, invalidationDebounceMs)
    })
    return () => {
      if (debounceTimer != null) window.clearTimeout(debounceTimer)
      unsubscribe?.()
    }
  }, [enabled, refresh, scope, shouldReload, invalidationDebounceMs])

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
