// Lifecycle manager for the Daylens MCP server subprocess.
// The server itself is a stdio process in packages/mcp-server/; this module
// manages its spawn/stop and computes the config snippet the user pastes into
// their MCP client (Claude Desktop, Cursor, etc.).
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

export interface McpServerConfig {
  command: string
  args: string[]
  env: Record<string, string>
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
  const args = paths.loaderPath
    ? ['--loader', `file://${paths.loaderPath}`, paths.serverPath]
    : [paths.serverPath]

  return {
    command: paths.execPath,
    args,
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      DAYLENS_DB_PATH: dbPath,
    },
  }
}

export function startMcpServer(): void {
  if (_proc && !_proc.killed) return

  const config = getMcpServerConfig()
  if (!config) {
    console.warn('[mcp] Server files not found — toggle enabled but server not started')
    return
  }

  _proc = spawn(config.command, config.args, {
    env: { ...process.env, ...config.env },
    // stdin is a pipe so the server blocks on read rather than exiting on EOF;
    // stdout is piped to keep it off the main process terminal.
    stdio: ['pipe', 'pipe', 'pipe'],
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
  _proc.kill('SIGTERM')
  _proc = null
}

export function isMcpServerRunning(): boolean {
  return _proc !== null && !_proc.killed
}
