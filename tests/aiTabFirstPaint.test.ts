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
