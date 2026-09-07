/** Unresolved access keeps the chat up; only a resolved `false` shows Connect AI. */
export function isAiChatVisible(hasApiKey: boolean | null): boolean {
  return hasApiKey !== false
}

export function isAiProviderPending(settings: unknown, hasApiKey: boolean | null): boolean {
  return settings == null || hasApiKey == null
}

/** A failed probe with no remembered snapshot blocks the column; a failure
 *  after a remount still shows Retry, but keeps the last working chat up. */
export function providerProbeFailureKind(
  loadError: string | null,
  initialLoading: boolean,
  providerPending: boolean,
): 'none' | 'blocking' | 'banner' {
  if (!loadError || initialLoading) return 'none'
  return providerPending ? 'blocking' : 'banner'
}

export type QueuedComposerPrompt = {
  text: string
  threadId: number | null
}

const queuedComposerPrompts: QueuedComposerPrompt[] = []

export function enqueueComposerPrompt(text: string, threadId: number | null): void {
  queuedComposerPrompts.push({ text, threadId })
}

export function peekQueuedComposerPrompt(threadId: number | null): QueuedComposerPrompt | undefined {
  return queuedComposerPrompts.find((prompt) => prompt.threadId === threadId)
}

export function takeQueuedComposerPrompt(threadId: number | null): QueuedComposerPrompt | undefined {
  const index = queuedComposerPrompts.findIndex((prompt) => prompt.threadId === threadId)
  if (index < 0) return undefined
  return queuedComposerPrompts.splice(index, 1)[0]
}

export function hasQueuedComposerPrompts(threadId: number | null): boolean {
  return queuedComposerPrompts.some((prompt) => prompt.threadId === threadId)
}

export function readQueuedComposerPrompts(threadId: number | null): string {
  return queuedComposerPrompts
    .filter((prompt) => prompt.threadId === threadId)
    .map((prompt) => prompt.text)
    .join('\n\n')
}

export function reassignQueuedComposerPrompts(fromThreadId: number | null, toThreadId: number): void {
  for (const prompt of queuedComposerPrompts) {
    if (prompt.threadId === fromThreadId) prompt.threadId = toThreadId
  }
}

export function replaceQueuedComposerPrompts(threadId: number | null, text: string): void {
  for (let index = queuedComposerPrompts.length - 1; index >= 0; index -= 1) {
    if (queuedComposerPrompts[index]?.threadId === threadId) queuedComposerPrompts.splice(index, 1)
  }
  if (text.trim()) enqueueComposerPrompt(text, threadId)
}

export function resetQueuedComposerPrompts(): void {
  queuedComposerPrompts.length = 0
}
