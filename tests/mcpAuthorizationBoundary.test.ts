// WO-37 / REQ-MCP-001 + REQ-MCP-002: The MCP server subprocess must not
// inherit arbitrary process env vars (AC-MCP-002.4), and the config env must
// carry the tracking controls (AC-MCP-002.1/2.2). The default for
// mcpServerEnabled must be on (AC-MCP-001.1 — the server starts on launch
// unless the person says otherwise).
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { getMcpServerConfig } from '../src/main/services/mcpServer.ts'
import { minimalChildEnv } from '../src/main/lib/childEnv.ts'
import { __resetSettings, __setSettings } from './support/settings-stub.mjs'

function makeFakeCheckout(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-mcp-'))
  const serverDir = path.join(root, 'packages', 'mcp-server', 'src')
  fs.mkdirSync(serverDir, { recursive: true })
  fs.writeFileSync(path.join(root, 'packages', 'mcp-server', 'loader.mjs'), '')
  fs.writeFileSync(path.join(serverDir, 'index.ts'), '')
  return root
}

test.beforeEach(() => {
  __resetSettings()
})

test('the MCP server subprocess env does not inherit arbitrary process secrets', () => {
  process.env.DAYLENS_TEST_MCP_SECRET = 'sk-should-not-leak'
  try {
    const configEnv = {
      ELECTRON_RUN_AS_NODE: '1',
      DAYLENS_DB_PATH: '/tmp/test.sqlite',
    }
    const spawnEnv = minimalChildEnv(configEnv)
    assert.equal(spawnEnv.DAYLENS_TEST_MCP_SECRET, undefined,
      'arbitrary process env vars must not reach the MCP subprocess')
    assert.equal(spawnEnv.ELECTRON_RUN_AS_NODE, '1')
    assert.equal(spawnEnv.DAYLENS_DB_PATH, '/tmp/test.sqlite')
    assert.ok(spawnEnv.PATH, 'launch essentials are still present')
    assert.ok(spawnEnv.HOME, 'HOME is still present')
  } finally {
    delete process.env.DAYLENS_TEST_MCP_SECRET
  }
})

test('the config env carries the tracking controls for the subprocess', () => {
  __setSettings({
    trackingControlsEnabled: true,
    trackingExcludedApps: ['Signal'],
    trackingExcludedSites: ['private.example.com'],
  })
  const root = makeFakeCheckout()
  process.env.DAYLENS_TEST_APP_PATH = root
  try {
    const config = getMcpServerConfig()
    assert.ok(config)
    assert.equal(config.env.DAYLENS_TRACKING_CONTROLS_ENABLED, '1')
    assert.deepEqual(JSON.parse(config.env.DAYLENS_TRACKING_EXCLUDED_APPS), ['Signal'])
    assert.deepEqual(JSON.parse(config.env.DAYLENS_TRACKING_EXCLUDED_SITES), ['private.example.com'])
  } finally {
    delete process.env.DAYLENS_TEST_APP_PATH
    fs.rmSync(root, { recursive: true, force: true })
  }
})
