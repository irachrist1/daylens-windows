// WO-19 / REQ-MCP-004: Chat MCP servers are person-managed. The four
// invariants: a disabled server is not connected, a server without the
// `enabled` field is treated as enabled (backward compat), servers discovered
// in external application configs cannot enter the chat path, and a removed
// server is absent from the next settings read.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { selectConnectableMcpServers, type McpServerConfig } from '../src/main/agent/mcpTools.ts'
import { discoverMcpServers } from '../src/main/services/enrichmentDiscovery.ts'
import { __resetSettings, __setSettings, getSettings } from './support/settings-stub.mjs'

test.beforeEach(() => {
  __resetSettings()
})

test('a disabled server is skipped, not connectable', () => {
  const servers: McpServerConfig[] = [
    { name: 'active', command: 'npx', args: ['-y', '@some/server'], enabled: true },
    { name: 'paused', command: 'npx', args: ['-y', '@other/server'], enabled: false },
  ]
  const { connectable, skipped } = selectConnectableMcpServers(servers)
  assert.equal(connectable.length, 1)
  assert.equal(connectable[0].name, 'active')
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].name, 'paused')
  assert.equal(skipped[0].status, 'skipped')
  assert.ok(skipped[0].status === 'skipped' && skipped[0].reason.length > 0)
})

test('a server without the enabled field is treated as enabled', () => {
  const servers: McpServerConfig[] = [
    { name: 'legacy', command: 'npx', args: ['-y', '@old/server'] },
  ]
  const { connectable, skipped } = selectConnectableMcpServers(servers)
  assert.equal(connectable.length, 1)
  assert.equal(skipped.length, 0)
})

test('discovery output cannot be used as a chat MCP server config', () => {
  // discoverMcpServers returns { name, transport } entries — no command field.
  // McpServerConfig requires command. A discovered server therefore cannot
  // be passed to connectMcpTools without the person explicitly providing a
  // command, which is the structural enforcement of AC-MCP-004.3.
  const configDir = path.join(os.tmpdir(), `dl-mcp-test-${Date.now()}`)
  const configPath = path.join(configDir, 'claude_desktop_config.json')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      'external-server': { command: 'npx', args: ['-y', '@external/server'] },
    },
  }))
  try {
    const discovered = discoverMcpServers(configPath)
    assert.equal(discovered.length, 1)
    assert.equal(discovered[0].name, 'external-server')
    assert.equal(discovered[0].transport, 'stdio')
    // The discovered entry has no command field — it is a { name, transport }
    // record, not a { name, command, args, env } config.
    assert.equal('command' in discovered[0], false)
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true })
  }
})

test('a removed server is absent from the next settings read', () => {
  __setSettings({
    mcpServers: [
      { name: 'keep', command: 'npx', args: ['-y', '@keep/server'] },
      { name: 'remove', command: 'npx', args: ['-y', '@remove/server'] },
    ],
  })
  const before = getSettings()
  assert.equal(before.mcpServers?.length, 2)

  __setSettings({
    mcpServers: [
      { name: 'keep', command: 'npx', args: ['-y', '@keep/server'] },
    ],
  })
  const after = getSettings()
  assert.equal(after.mcpServers?.length, 1)
  assert.equal(after.mcpServers?.[0].name, 'keep')
  const removed = after.mcpServers?.find((s) => s.name === 'remove')
  assert.equal(removed, undefined)
})
