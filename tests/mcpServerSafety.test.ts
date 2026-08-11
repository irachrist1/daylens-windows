// Settings spec §7 / invariant: a packaged build ships the MCP server off and
// never exposes a developer filesystem path. The DB path handed to the MCP
// server must always be the real userData database, never the app/source root.
// This guards the regression where a packaged build leaked the developer's repo
// paths and defaulted the server on.
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { getMcpServerConfig } from '../src/main/services/mcpServer.ts'

// Stand up a fake dev checkout so resolveServerPaths finds the loader/server
// files and returns a real config (rather than null) to inspect.
function makeFakeCheckout(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-mcp-'))
  const serverDir = path.join(root, 'packages', 'mcp-server', 'src')
  fs.mkdirSync(serverDir, { recursive: true })
  fs.writeFileSync(path.join(root, 'packages', 'mcp-server', 'loader.mjs'), '')
  fs.writeFileSync(path.join(serverDir, 'index.ts'), '')
  return root
}

test('MCP db path is the userData database, never the app/source root', () => {
  const root = makeFakeCheckout()
  process.env.DAYLENS_TEST_APP_PATH = root
  try {
    const config = getMcpServerConfig()
    assert.ok(config, 'expected a resolved MCP config in a dev checkout')
    const userData = app.getPath('userData')
    assert.equal(config.dbPath, path.join(userData, 'daylens.sqlite'))
    assert.equal(config.env.DAYLENS_DB_PATH, config.dbPath)
    // The database must not live under the app/source root.
    assert.ok(!config.dbPath.startsWith(root), 'db path must not be inside the app root')
  } finally {
    delete process.env.DAYLENS_TEST_APP_PATH
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('MCP config reports whether the managed server is running', () => {
  const root = makeFakeCheckout()
  process.env.DAYLENS_TEST_APP_PATH = root
  try {
    const config = getMcpServerConfig()
    assert.ok(config)
    // Nothing started it in this test, so the Settings section must be told the
    // server is down rather than inferring "on" from the toggle it just wrote.
    assert.equal(config.running, false)
  } finally {
    delete process.env.DAYLENS_TEST_APP_PATH
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('MCP config reports the packaged state for the UI to explain dev paths', () => {
  const root = makeFakeCheckout()
  process.env.DAYLENS_TEST_APP_PATH = root
  try {
    const config = getMcpServerConfig()
    assert.ok(config)
    // The stub runs as a dev build; the flag must reflect that so the UI can
    // label source-checkout paths as dev-only.
    assert.equal(config.isPackaged, app.isPackaged)
  } finally {
    delete process.env.DAYLENS_TEST_APP_PATH
    fs.rmSync(root, { recursive: true, force: true })
  }
})
