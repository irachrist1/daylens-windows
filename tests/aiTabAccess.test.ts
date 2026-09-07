import test from 'node:test'
import assert from 'node:assert/strict'
import {
  enqueueComposerPrompt,
  hasQueuedComposerPrompts,
  isAiChatVisible,
  isAiProviderPending,
  peekQueuedComposerPrompt,
  providerProbeFailureKind,
  readQueuedComposerPrompts,
  reassignQueuedComposerPrompts,
  replaceQueuedComposerPrompts,
  resetQueuedComposerPrompts,
  takeQueuedComposerPrompt,
} from '../src/renderer/lib/aiTabAccess.ts'

test('unresolved access keeps the chat visible', () => {
  assert.equal(isAiChatVisible(null), true)
  assert.equal(isAiChatVisible(true), true)
  assert.equal(isAiChatVisible(false), false)
})

test('the provider verdict is pending until both settings and access resolve', () => {
  assert.equal(isAiProviderPending(null, null), true)
  assert.equal(isAiProviderPending({ aiProvider: 'anthropic' }, null), true)
  assert.equal(isAiProviderPending(null, true), true)
  assert.equal(isAiProviderPending({ aiProvider: 'anthropic' }, true), false)
  assert.equal(isAiProviderPending({ aiProvider: 'anthropic' }, false), false)
})

test('early composer submissions stay with their originating conversation', () => {
  resetQueuedComposerPrompts()
  enqueueComposerPrompt('first', 1)
  enqueueComposerPrompt('new chat', null)
  enqueueComposerPrompt('second', 1)
  assert.equal(hasQueuedComposerPrompts(1), true)
  assert.deepEqual(peekQueuedComposerPrompt(1), { text: 'first', threadId: 1 })
  assert.deepEqual(takeQueuedComposerPrompt(1), { text: 'first', threadId: 1 })
  assert.deepEqual(peekQueuedComposerPrompt(null), { text: 'new chat', threadId: null })
  assert.equal(readQueuedComposerPrompts(1), 'second')
  assert.equal(readQueuedComposerPrompts(null), 'new chat')
  reassignQueuedComposerPrompts(null, 3)
  assert.equal(readQueuedComposerPrompts(null), '')
  assert.equal(readQueuedComposerPrompts(3), 'new chat')
})

test('flushing one conversation does not take prompts queued on another', () => {
  resetQueuedComposerPrompts()
  enqueueComposerPrompt('keep me', 1)
  enqueueComposerPrompt('send me', 2)
  assert.deepEqual(takeQueuedComposerPrompt(2), { text: 'send me', threadId: 2 })
  assert.deepEqual(peekQueuedComposerPrompt(1), { text: 'keep me', threadId: 1 })
  assert.equal(hasQueuedComposerPrompts(2), false)
})

test('denied composer drafts remain recoverable and editable', () => {
  resetQueuedComposerPrompts()
  enqueueComposerPrompt('original', 1)
  enqueueComposerPrompt('other chat', 2)
  replaceQueuedComposerPrompts(1, 'edited draft')
  assert.equal(readQueuedComposerPrompts(1), 'edited draft')
  assert.equal(readQueuedComposerPrompts(2), 'other chat')
  replaceQueuedComposerPrompts(1, '')
  assert.equal(hasQueuedComposerPrompts(1), false)
})

test('a remount with a remembered provider snapshot still surfaces probe failures', () => {
  assert.equal(providerProbeFailureKind('Provider failed', false, false), 'banner')
  assert.equal(providerProbeFailureKind('Provider failed', false, true), 'blocking')
  assert.equal(providerProbeFailureKind('Provider failed', true, false), 'none')
  assert.equal(providerProbeFailureKind(null, false, false), 'none')
})
