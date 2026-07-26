// DEV-253: "Chat about your memory" must land in a chat that has visibly
// started. The seed prompt is stashed here before navigation and consumed
// exactly once by the AI tab on mount, which then sends it as the first
// message of a new thread. These tests pin the handoff semantics and the
// seed prompt itself.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MEMORY_CHAT_SEED_PROMPT,
  consumePendingChatSeed,
  setPendingChatSeed,
} from '../src/renderer/lib/aiSeed.ts'

test('a stashed seed is consumed exactly once', () => {
  setPendingChatSeed(MEMORY_CHAT_SEED_PROMPT)
  assert.equal(consumePendingChatSeed(), MEMORY_CHAT_SEED_PROMPT)
  // A second consumer (remount, live event) must not replay the same send.
  assert.equal(consumePendingChatSeed(), null)
})

test('whitespace-only seeds never trigger a send', () => {
  setPendingChatSeed('   ')
  assert.equal(consumePendingChatSeed(), null)
})

test('the memory seed prompt is sendable and in the product voice', () => {
  assert.ok(MEMORY_CHAT_SEED_PROMPT.trim().length > 0)
  assert.match(MEMORY_CHAT_SEED_PROMPT, /memory/i)
  assert.ok(!MEMORY_CHAT_SEED_PROMPT.includes('—'), 'no em dashes in shipped copy')
})
