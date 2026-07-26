import type { ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { getStreamingSnapshot, subscribeStreaming } from './streamingStore'

interface StreamingMessageProps {
  messageId: string
  fallback: ReactNode
  // The Markdown renderer is passed in to keep this component decoupled from
  // the parent's markdown implementation.
  renderContent: (text: string) => ReactNode
  // Optional callback fired after each snapshot update — typically used by
  // the parent to scroll the message list to the bottom as content streams in
  // without requiring the parent itself to subscribe to streaming state.
  onSnapshotUpdate?: () => void
}

type FrameHandle =
  | { kind: 'raf'; id: number }
  | { kind: 'timeout'; id: ReturnType<typeof globalThis.setTimeout> }

function requestFrame(callback: () => void): FrameHandle {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return { kind: 'raf', id: window.requestAnimationFrame(callback) }
  }
  return { kind: 'timeout', id: globalThis.setTimeout(callback, 16) }
}

function cancelFrame(handle: FrameHandle): void {
  if (handle.kind === 'raf' && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(handle.id)
    return
  }
  if (handle.kind === 'timeout') {
    globalThis.clearTimeout(handle.id)
  }
}

export function StreamingMessage({ messageId, fallback, renderContent, onSnapshotUpdate }: StreamingMessageProps) {
  // useSyncExternalStore drives a re-render of THIS component on every
  // snapshot push, while the parent stays untouched. The visible snapshot below
  // advances at frame cadence so markdown parsing and scroll work are batched.
  const snapshot = useSyncExternalStore(
    (listener) => subscribeStreaming(messageId, listener),
    () => getStreamingSnapshot(messageId),
    () => '',
  )
  const [visibleSnapshot, setVisibleSnapshot] = useState(snapshot)
  const latestSnapshotRef = useRef(snapshot)
  const lastNotifiedRef = useRef<number>(0)
  const frameRef = useRef<FrameHandle | null>(null)

  useEffect(() => {
    latestSnapshotRef.current = snapshot
    if (frameRef.current !== null) return

    frameRef.current = requestFrame(() => {
      frameRef.current = null
      const next = latestSnapshotRef.current
      setVisibleSnapshot(next)
      if (next.length === lastNotifiedRef.current) return
      lastNotifiedRef.current = next.length
      onSnapshotUpdate?.()
    })
  }, [snapshot, onSnapshotUpdate])

  useEffect(() => () => {
    if (frameRef.current !== null) {
      cancelFrame(frameRef.current)
      frameRef.current = null
    }
  }, [])

  const renderedContent = useMemo(
    () => visibleSnapshot ? renderContent(visibleSnapshot) : fallback,
    [fallback, renderContent, visibleSnapshot],
  )

  // Tool activity while the agent works is the <AgentProgressPanel>'s job —
  // this component renders only the streaming answer text.
  return <>{renderedContent}</>
}
