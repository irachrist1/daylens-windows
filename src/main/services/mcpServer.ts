// Lifecycle manager for the Daylens MCP server subprocess.
// The server itself is a stdio process in packages/mcp-server/; this module
// manages its spawn/stop and computes the config snippet the user pastes into
// their MCP client (Claude Desktop, Cursor, etc.).
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { getSettings } from './settings'
import { isRealDayHarness } from '../lib/realDayHarness'
import { minimalChildEnv } from '../lib/childEnv'

export interface McpServerConfig {
  command: string
  args: string[]
  env: Record<string, string>
  // Metadata for the Settings UI — NOT part of the pasteable snippet (the UI
  // picks command/args/env explicitly). `isPackaged` lets the renderer explain
  // why a dev build shows source-checkout paths while a packaged install never
  // does (settings spec §7). `dbPath` is always the real userData database, so
  // the UI can show it and prove no developer path is exposed in production.
  isPackaged: boolean
  dbPath: string
  // Whether the Daylens-managed subprocess is up right now, so the Settings
  // section reports the live state instead of inferring it from the toggle it
  // just wrote.
  running: boolean
}

let _proc: ChildProcess | null = null

function resolveServerPaths():
  | { execPath: string; loaderPath: string | null; serverPath: string }
  | null {
  const root = app.getAppPath()

  if (app.isPackaged) {
    // Production: compiled bundle shipped as app resource.
    const bundlePath = path.join(root, 'dist', 'mcp-server', 'index.cjs')
    if (fs.existsSync(bundlePath)) {
      return { execPath: process.execPath, loaderPath: null, serverPath: bundlePath }
    }
    return null
  }

  // Development: run TypeScript source through our loader.
  const loaderPath = path.join(root, 'packages', 'mcp-server', 'loader.mjs')
  const serverPath = path.join(root, 'packages', 'mcp-server', 'src', 'index.ts')
  if (!fs.existsSync(loaderPath) || !fs.existsSync(serverPath)) return null
  return { execPath: process.execPath, loaderPath, serverPath }
}

export function getMcpServerConfig(): McpServerConfig | null {
  const paths = resolveServerPaths()
  if (!paths) return null

  const dbPath = path.join(app.getPath('userData'), 'daylens.sqlite')
  const settings = getSettings()
  const args = paths.loaderPath
    ? ['--loader', `file://${paths.loaderPath}`, paths.serverPath]
    : [paths.serverPath]

  return {
    command: paths.execPath,
    args,
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      DAYLENS_DB_PATH: dbPath,
      // The MCP subprocess reads the same store read-only and has no access to
      // the settings file, so the current exclusion set is handed in by env.
      // The Daylens-managed subprocess is respawned with a fresh snapshot on
      // every start, so exclusions stay current for the in-app server.
      DAYLENS_TRACKING_CONTROLS_ENABLED: settings.trackingControlsEnabled ? '1' : '0',
      DAYLENS_TRACKING_EXCLUDED_APPS: JSON.stringify(settings.trackingExcludedApps ?? []),
      DAYLENS_TRACKING_EXCLUDED_SITES: JSON.stringify(settings.trackingExcludedSites ?? []),
    },
    isPackaged: app.isPackaged,
    dbPath,
    running: isMcpServerRunning(),
  }
}

export function startMcpServer(): void {
  if (isRealDayHarness()) return
  if (_proc && !_proc.killed) return

  const config = getMcpServerConfig()
  if (!config) {
    console.warn('[mcp] Server files not found — toggle enabled but server not started')
    return
  }

  try {
    _proc = spawn(config.command, config.args, {
      env: minimalChildEnv(config.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (err) {
    console.error('[mcp] Failed to spawn server:', err)
    _proc = null
    return
  }

  _proc.on('error', (err: Error) => {
    console.error('[mcp] Server process error:', err)
    _proc = null
  })

  _proc.stderr?.on('data', (chunk: Buffer) => {
    console.error('[mcp-server]', chunk.toString().trim())
  })

  _proc.on('exit', (code) => {
    console.log(`[mcp] Server subprocess exited (code ${code})`)
    _proc = null
  })

  console.log(`[mcp] Server started (pid ${_proc.pid})`)
}

export function stopMcpServer(): void {
  if (!_proc || _proc.killed) return
  const proc = _proc
  _proc = null

  proc.kill('SIGTERM')
  const killTimer = setTimeout(() => {
    if (!proc.killed) {
      proc.kill('SIGKILL')
    }
  }, 5_000)
  proc.on('exit', () => clearTimeout(killTimer))
}

export function isMcpServerRunning(): boolean {
  return _proc !== null && !_proc.killed
}
