// A one-shot handoff for starting an AI chat from another view. The AI tab
// mounts only after navigation, so an event dispatched before navigate
// (Settings → Memory → "Chat about your memory") fired before any listener
// existed and was lost. The queuing view stashes the prompt here; the AI tab
// reads and clears it on mount, then SENDS it as the first message of a new
// thread so the person lands in a conversation that has visibly started
// (DEV-253), not on an empty composer.
let pendingChatSeed: string | null = null

// The first message the Memory page sends on the user's behalf. Written in
// the user's voice because it is sent as their message.
export const MEMORY_CHAT_SEED_PROMPT =
  'What do you know about me? Walk me through what you have saved in memory about my work and how I use my time.'

export function setPendingChatSeed(text: string): void {
  pendingChatSeed = text.trim() || null
}

export function consumePendingChatSeed(): string | null {
  const value = pendingChatSeed
  pendingChatSeed = null
  return value
}

/** The AI tab's access gate starts unresolved on every mount (settings and
 *  hasApiKey are null until the provider resource loads) and the tab renders
 *  a loading gate with no composer. Consuming the one-shot stash then would
 *  destroy the seed before anything could send or show it, so this consumes
 *  only once the gate has resolved; until then the stash survives untouched
 *  for a later effect run. */
export function consumePendingChatSeedWhenReady(
  settings: unknown,
  hasApiKey: boolean | null,
): string | null {
  if (settings == null || hasApiKey == null) return null
  return consumePendingChatSeed()
}
