// settings.mcpServers must actually round-trip: the key was typed on
// AppSettings and consumed by aiService (`settings.mcpServers ?? []` →
// connectMcpTools), but getSettings() never returned it, so user-configured
// servers silently never reached the agent. This test drives the REAL settings
// module (electron-store is the hermetic in-memory stub) and proves a
// configured server survives the exact read the agent deps perform.
import test from 'node:test'
import assert from 'node:assert/strict'
import { getSettings, initSettings, setSettings } from '../src/main/services/settings.ts'
import { __resetElectronStore } from './support/electron-store-stub.mjs'

test('a configured MCP server reaches the agent deps through getSettings()', async () => {
  __resetElectronStore()
  await initSettings()

  // Default: present and empty, never undefined.
  assert.deepEqual(getSettings().mcpServers, [])

  const configured = [
    { name: 'notes', command: '/usr/local/bin/notes-mcp', args: ['--stdio'], env: { NOTES_DIR: '/tmp/notes' } },
  ]
  await setSettings({ mcpServers: configured })

  const settings = getSettings()
  assert.deepEqual(settings.mcpServers, configured, 'the stored servers round-trip through getSettings')

  // The exact expression the chat lane uses to build ChatAgentDeps.mcpServers
  // (src/main/jobs/aiService.ts): with the fix it yields the configured
  // servers instead of always [].
  const agentDepsMcpServers = settings.mcpServers ?? []
  assert.equal(agentDepsMcpServers.length, 1)
  assert.equal(agentDepsMcpServers[0].name, 'notes')
  assert.equal(agentDepsMcpServers[0].command, '/usr/local/bin/notes-mcp')

  __resetElectronStore()
})
