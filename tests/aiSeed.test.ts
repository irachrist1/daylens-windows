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
  consumePendingChatSeedWhenReady,
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

// The AI tab's consuming effect runs on every render of the access gate:
// first while settings/hasApiKey are still null (loading gate, no composer),
// then again once they resolve. The seed must survive the unresolved runs and
// be delivered exactly once after resolution. This drives the same function
// the component effect calls, across the same state sequence a fresh mount
// produces.
test('the seed survives a mount where AI access resolves late and sends once', () => {
  setPendingChatSeed(MEMORY_CHAT_SEED_PROMPT)
  const sent: string[] = []
  const runConsumingEffect = (settings: unknown, hasApiKey: boolean | null) => {
    const pending = consumePendingChatSeedWhenReady(settings, hasApiKey)
    if (pending) sent.push(pending)
  }

  // Mount: provider resource not loaded yet — both gate values null.
  runConsumingEffect(null, null)
  assert.deepEqual(sent, [], 'must not consume while the gate is unresolved')

  // Re-render: still resolving (e.g. settings present, access unknown).
  runConsumingEffect({ aiProvider: 'anthropic' }, null)
  assert.deepEqual(sent, [], 'must not consume while access is unknown')

  // Gate resolves: the seed is delivered exactly once.
  runConsumingEffect({ aiProvider: 'anthropic' }, true)
  assert.deepEqual(sent, [MEMORY_CHAT_SEED_PROMPT])

  // Later effect runs (dep changes, remounts) must not replay it.
  runConsumingEffect({ aiProvider: 'anthropic' }, true)
  assert.deepEqual(sent, [MEMORY_CHAT_SEED_PROMPT])
})

test('a resolved gate without AI access still consumes the seed once', () => {
  // hasApiKey === false is a RESOLVED gate: the composer fallback renders, so
  // the seed must be consumed (and pre-filled), not left to leak into an
  // unrelated later visit.
  setPendingChatSeed(MEMORY_CHAT_SEED_PROMPT)
  assert.equal(consumePendingChatSeedWhenReady({}, false), MEMORY_CHAT_SEED_PROMPT)
  assert.equal(consumePendingChatSeedWhenReady({}, false), null)
})

test('the memory seed prompt is sendable and in the product voice', () => {
  assert.ok(MEMORY_CHAT_SEED_PROMPT.trim().length > 0)
  assert.match(MEMORY_CHAT_SEED_PROMPT, /memory/i)
  assert.ok(!MEMORY_CHAT_SEED_PROMPT.includes('—'), 'no em dashes in shipped copy')
})
