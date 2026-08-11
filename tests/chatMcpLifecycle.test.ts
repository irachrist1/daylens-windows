// WO-20 / REQ-MCP-005: Chat MCP server process isolation and lifecycle.
// The timeout helper must release resources on timeout and swallow the
// pending promise's eventual rejection. On success it must not call cleanup.
import test from 'node:test'
import assert from 'node:assert/strict'
import { raceConnectWithCleanup } from '../src/main/agent/mcpTools.ts'

test('returns the result when the operation succeeds before the timeout', async () => {
  let cleanupCalled = false
  const result = await raceConnectWithCleanup(
    async () => 'connected',
    1000,
    async () => { cleanupCalled = true },
  )
  assert.equal(result, 'connected')
  assert.equal(cleanupCalled, false)
})

test('calls cleanup and rejects when the operation exceeds the timeout', async () => {
  let cleanupCalled = false
  await assert.rejects(
    raceConnectWithCleanup(
      () => new Promise<string>((resolve) => setTimeout(() => resolve('late'), 200)),
      50,
      async () => { cleanupCalled = true },
    ),
    { message: 'connect timeout' },
  )
  assert.equal(cleanupCalled, true)
})

test('calls cleanup and rethrows when the operation fails before the timeout', async () => {
  let cleanupCalled = false
  await assert.rejects(
    raceConnectWithCleanup(
      async () => { throw new Error('connection refused') },
      1000,
      async () => { cleanupCalled = true },
    ),
    { message: 'connection refused' },
  )
  assert.equal(cleanupCalled, true)
})

test('swallows the pending promise rejection when cleanup closes the resource', async () => {
  let rejectLater: (error: Error) => void
  const pending = new Promise<string>((_resolve, reject) => { rejectLater = reject })
  await assert.rejects(
    raceConnectWithCleanup(
      () => pending,
      50,
      async () => { rejectLater!(new Error('transport closed')) },
    ),
    { message: 'connect timeout' },
  )
  // Give the microtask queue a chance to flush the pending rejection.
  await new Promise((resolve) => setImmediate(resolve))
  // If the pending rejection were unhandled, node:test would report it.
})
