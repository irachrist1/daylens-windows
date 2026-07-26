// Streaming-text store for the AI chat tab.
//
// Streaming snapshots used to live in React state on the parent Insights
// component, so every chunk re-rendered the entire AI tab tree — including
// the controlled <textarea> in the composer. That is the typing-flicker bug
// from V1-PHASE-6-AI §6.
//
// This module owns the in-flight snapshot for each assistant message and
// exposes a useSyncExternalStore-friendly API. <StreamingMessage> subscribes
// per messageId, so chunk arrivals only re-render the message body, never
// the composer.

import type { AIAgentStep, AIChatWorkingContext } from '@shared/types'
import { upsertStep } from '@shared/agentTrail'

type Listener = () => void

const snapshots = new Map<string, string>()
const statuses = new Map<string, string>()
// The activity trail: structured steps accumulated per in-flight message.
// A step event upserts by id, so active rows settle in place.
const stepsByMessage = new Map<string, AIAgentStep[]>()
// The turn's working-context summary (DEV-245), sent once after assembly.
const contextByMessage = new Map<string, AIChatWorkingContext>()
const EMPTY_STEPS: AIAgentStep[] = []
const listeners = new Map<string, Set<Listener>>()

export function setStreamingSnapshot(
  messageId: string,
  snapshot: string,
  status?: string,
  step?: AIAgentStep,
  context?: AIChatWorkingContext,
): void {
  snapshots.set(messageId, snapshot)
  // A tool-status line ("Searching for…") rides the same event stream (ADR
  // 0003). Text arriving clears the status — the answer replaces the activity.
  if (status !== undefined) statuses.set(messageId, status)
  else if (snapshot) statuses.delete(messageId)
  if (step) stepsByMessage.set(messageId, upsertStep(stepsByMessage.get(messageId) ?? EMPTY_STEPS, step))
  if (context) contextByMessage.set(messageId, context)
  const subs = listeners.get(messageId)
  if (subs) for (const fn of subs) fn()
}

export function getStreamingSnapshot(messageId: string): string {
  return snapshots.get(messageId) ?? ''
}

export function getStreamingStatus(messageId: string): string {
  return statuses.get(messageId) ?? ''
}

// Referentially stable between step arrivals — safe for useSyncExternalStore.
export function getStreamingSteps(messageId: string): AIAgentStep[] {
  return stepsByMessage.get(messageId) ?? EMPTY_STEPS
}

export function getStreamingContext(messageId: string): AIChatWorkingContext | null {
  return contextByMessage.get(messageId) ?? null
}

export function clearStreamingSnapshot(messageId: string): void {
  snapshots.delete(messageId)
  statuses.delete(messageId)
  stepsByMessage.delete(messageId)
  contextByMessage.delete(messageId)
  // Leave listeners in place; the unsubscribe path will drop the set when
  // the component unmounts. Clearing here would orphan a still-mounted
  // <StreamingMessage> waiting for a final flush.
}

export function subscribeStreaming(messageId: string, listener: Listener): () => void {
  let set = listeners.get(messageId)
  if (!set) {
    set = new Set()
    listeners.set(messageId, set)
  }
  set.add(listener)
  return () => {
    const current = listeners.get(messageId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) listeners.delete(messageId)
  }
}
