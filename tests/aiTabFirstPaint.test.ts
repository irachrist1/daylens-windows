// The AI tab used to return a centred "Loading AI…" paragraph while its
// provider probe ran — settings, key/CLI detection and a billing call — so
// every open blanked the whole screen, input included, for as long as the
// slowest of those took. These pin the shape that replaced it: paint the
// workspace first, fill in the provider verdict when it lands.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

const workspace = readSource('src/renderer/views/insights/AIWorkspace.tsx')
const chatHook = readSource('src/renderer/views/insights/useAIChat.ts')

test('the AI tab renders no screen that waits for the provider probe', () => {
  assert.doesNotMatch(workspace, /Loading AI/)
  assert.doesNotMatch(workspace, /if \(settings == null \|\| hasApiKey == null\)/)
})

test('the chat surfaces stay up while the provider verdict is unresolved', () => {
  assert.match(workspace, /const chatVisible = isAiChatVisible\(hasApiKey\)/)
  assert.match(workspace, /const providerPending = isAiProviderPending\(settings, hasApiKey\)/)
  assert.match(workspace, /settings && hasApiKey === false/)
  assert.match(workspace, /onSubmit=\{onComposerSubmit\}/)
})

test('the provider verdict survives a remount, so reopening the tab never starts blank', () => {
  assert.match(chatHook, /let lastProviderSnapshot: ProviderSnapshot \| null = null/)
  assert.match(chatHook, /providerResource\.data \?\? lastProviderSnapshot/)
})

test('a queued prompt stays on its conversation and survives a denied-access Connect AI swap', () => {
  assert.match(workspace, /enqueueComposerPrompt\(text, activeThreadId\)/)
  assert.match(workspace, /peekQueuedComposerPrompt\(activeThreadId\)/)
  assert.match(workspace, /takeQueuedComposerPrompt\(activeThreadId\)/)
  assert.match(workspace, /deniedDraft/)
  assert.match(workspace, /initialValue=\{deniedDraft\}/)
  assert.match(workspace, /onValueChange=\{preserveQueuedDraft\}/)
  assert.match(workspace, /return false/)
  assert.match(chatHook, /reassignQueuedComposerPrompts\(requestThreadId, response\.threadId\)/)
  assert.doesNotMatch(workspace, /drainQueuedComposerPrompts/)
  assert.doesNotMatch(workspace, /enqueueComposerPrompt\(text\)/)
})

test('a remounted provider probe failure still shows Retry', () => {
  assert.match(workspace, /providerProbeFailureKind\(loadError, initialLoading, providerPending\)/)
  assert.match(workspace, /probeFailure === 'banner'/)
  assert.match(workspace, /probeFailure === 'blocking'/)
  assert.match(workspace, /Couldn't refresh AI settings/)
  assert.doesNotMatch(workspace, /providerPending && loadError && !initialLoading/)
})
