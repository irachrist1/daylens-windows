/** Unresolved access keeps the chat up; only a resolved `false` shows Connect AI. */
export function isAiChatVisible(hasApiKey: boolean | null): boolean {
  return hasApiKey !== false
}

export function isAiProviderPending(settings: unknown, hasApiKey: boolean | null): boolean {
  return settings == null || hasApiKey == null
}

const queuedComposerPrompts: string[] = []

export function enqueueComposerPrompt(text: string): void {
  queuedComposerPrompts.push(text)
}

export function peekQueuedComposerPrompt(): string | undefined {
  return queuedComposerPrompts[0]
}

export function takeQueuedComposerPrompt(): string | undefined {
  return queuedComposerPrompts.shift()
}

export function hasQueuedComposerPrompts(): boolean {
  return queuedComposerPrompts.length > 0
}

export function drainQueuedComposerPrompts(): string {
  const joined = queuedComposerPrompts.join('\n\n')
  queuedComposerPrompts.length = 0
  return joined
}

export function resetQueuedComposerPrompts(): void {
  queuedComposerPrompts.length = 0
}
