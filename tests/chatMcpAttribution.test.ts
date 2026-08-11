// WO-22 / REQ-MCP-006: Untrusted Chat MCP output must be attributed to its
// source and tools from different servers must not silently replace each
// other.
import test from 'node:test'
import assert from 'node:assert/strict'
import { namespaceMcpToolName, wrapMcpToolsWithGuards, type McpServerConfig } from '../src/main/agent/mcpTools.ts'
import { __resetSettings, __setSettings } from './support/settings-stub.mjs'
import type { ToolSet } from 'ai'

test.beforeEach(() => {
  __resetSettings()
})

test('same tool name from different servers gets different keys', () => {
  const used = new Set<string>()
  const a = namespaceMcpToolName('server-a', 'search', used)
  const b = namespaceMcpToolName('server-b', 'search', used)
  assert.notEqual(a, b)
  assert.ok(a.includes('server_a'))
  assert.ok(b.includes('server_b'))
})

test('normalization collision is disambiguated, not silently replaced', () => {
  // "my-server" and "my_server" both normalize to "my_server".
  const used = new Set<string>()
  const a = namespaceMcpToolName('my-server', 'search', used)
  const b = namespaceMcpToolName('my_server', 'search', used)
  assert.notEqual(a, b, 'two servers that normalize to the same name must not collide')
})

test('truncation collision is disambiguated', () => {
  const used = new Set<string>()
  // Two long server/tool pairs that share the first 64 chars after normalization.
  const longA = 'a'.repeat(40)
  const longB = 'a'.repeat(40)
  const a = namespaceMcpToolName(longA, 'tool', used)
  const b = namespaceMcpToolName(longB, 'tool', used)
  assert.notEqual(a, b, 'truncation must not cause two tools to share a key')
})

test('a collision on a key already at the length cap still resolves', () => {
  const used = new Set<string>()
  // Both names exceed the 64-character cap and share every character up to it,
  // so the second call has to shorten the base to fit its suffix.
  const shared = 'a'.repeat(80)
  const first = namespaceMcpToolName(`${shared}-one`, 'search', used)
  const second = namespaceMcpToolName(`${shared}-two`, 'search', used)
  assert.equal(first.length, 64)
  assert.ok(second.length <= 64)
  assert.notEqual(second, first, 'a key at the cap must not swallow its own suffix')
})

test('the same server and tool name is stable across calls with a fresh set', () => {
  const used1 = new Set<string>()
  const used2 = new Set<string>()
  const a = namespaceMcpToolName('server', 'search', used1)
  const b = namespaceMcpToolName('server', 'search', used2)
  assert.equal(a, b)
})

test('wrapMcpToolsWithGuards still applies the guard to every tool with execute', async () => {
  __setSettings({ trackingControlsEnabled: true, trackingExcludedApps: ['Signal'] })
  const tools = {
    leaky: {
      description: 'a tool that leaks',
      execute: async () => ({
        token: 'a github pat ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaa leaked',
        items: [{ appName: 'Signal', note: 'private' }],
      }),
    },
    schema_only: { description: 'no execute' },
  } as unknown as ToolSet

  const wrapped = wrapMcpToolsWithGuards(tools)
  assert.equal(wrapped.schema_only, tools.schema_only, 'defs without execute pass through')

  const result = await (wrapped.leaky as { execute: (input: unknown, options: unknown) => Promise<unknown> }).execute({}, {}) as {
    token: string
    items: Array<{ appName: string }>
  }
  assert.ok(!result.token.includes('ghp_'), 'secrets are sanitized')
  assert.equal(result.items.length, 0, 'excluded-app records are filtered')
})
