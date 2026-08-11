// WO-17 / AC-MCP-003.3: when Daylens cannot prepare a usable connection, the MCP
// settings section must explain that and must not present unusable configuration
// as ready to copy.
//
// The section used to render its snippet behind `enabled && config`, so the
// unavailable case rendered nothing at all: an enabled toggle above an empty
// panel, with no way for a person to know whether Daylens was working or broken.
// The decision now lives in one function, and these tests pin the two states
// that used to be indistinguishable.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canCopyMcpConfig,
  describeMcpConnection,
  type McpClientConfig,
} from '../src/shared/mcpConnection.ts'

const CONFIG: McpClientConfig = {
  command: '/path/to/runtime',
  args: ['/path/to/server.cjs'],
  env: { ELECTRON_RUN_AS_NODE: '1', DAYLENS_DB_PATH: '/path/to/daylens.sqlite' },
  isPackaged: true,
  dbPath: '/path/to/daylens.sqlite',
  running: true,
}

test('an install that cannot run the server says so and offers nothing to copy', () => {
  const state = describeMcpConnection({ enabled: true, fetch: 'settled', config: null, error: null })
  assert.equal(state.kind, 'unavailable')
  assert.ok(state.kind === 'unavailable' && state.reason.length > 0)
  assert.equal(canCopyMcpConfig(state), false)
})

test('a failed lookup is reported as a failure, not as an unavailable install', () => {
  const state = describeMcpConnection({
    enabled: true,
    fetch: 'settled',
    config: null,
    error: 'IPC channel closed',
  })
  assert.equal(state.kind, 'failed')
  assert.ok(state.kind === 'failed' && state.reason.includes('IPC channel closed'))
  assert.equal(canCopyMcpConfig(state), false)
})

test('an in-flight lookup is not yet an answer', () => {
  for (const fetch of ['idle', 'loading'] as const) {
    const state = describeMcpConnection({ enabled: true, fetch, config: null, error: null })
    assert.equal(state.kind, 'checking', `fetch=${fetch} must not read as unavailable`)
    assert.equal(canCopyMcpConfig(state), false)
  }
})

test('a resolved configuration is the only state that can be copied', () => {
  const state = describeMcpConnection({ enabled: true, fetch: 'settled', config: CONFIG, error: null })
  assert.equal(state.kind, 'ready')
  assert.deepEqual(state.kind === 'ready' ? state.config : null, CONFIG)
  assert.equal(canCopyMcpConfig(state), true)
})

test('turning access off hides a configuration that was already fetched', () => {
  const state = describeMcpConnection({ enabled: false, fetch: 'settled', config: CONFIG, error: null })
  assert.equal(state.kind, 'off')
  assert.equal(canCopyMcpConfig(state), false)
})

test('the running flag rides with the configuration so the section reports live state', () => {
  const stopped = describeMcpConnection({
    enabled: true,
    fetch: 'settled',
    config: { ...CONFIG, running: false },
    error: null,
  })
  assert.equal(stopped.kind, 'ready')
  assert.equal(stopped.kind === 'ready' ? stopped.config.running : true, false)
})
