import test from 'node:test'
import assert from 'node:assert/strict'
import {
  drainQueuedComposerPrompts,
  enqueueComposerPrompt,
  hasQueuedComposerPrompts,
  isAiChatVisible,
  isAiProviderPending,
  peekQueuedComposerPrompt,
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

test('early composer submissions queue in order and drain on deny', () => {
  resetQueuedComposerPrompts()
  enqueueComposerPrompt('first')
  enqueueComposerPrompt('second')
  assert.equal(hasQueuedComposerPrompts(), true)
  assert.equal(peekQueuedComposerPrompt(), 'first')
  assert.equal(takeQueuedComposerPrompt(), 'first')
  assert.equal(peekQueuedComposerPrompt(), 'second')
  assert.equal(drainQueuedComposerPrompts(), 'second')
  assert.equal(hasQueuedComposerPrompts(), false)
  assert.equal(drainQueuedComposerPrompts(), '')
})
