// Default database discovery for the standalone MCP server.
//
// When an MCP client launches the server without DAYLENS_DB_PATH, the fallback
// must find the SAME database the app itself would open. The app resolves its
// userData directory through chooseUserDataPath (src/main/services/userData.ts),
// which on macOS prefers "Daylens Desktop" and only falls back to the legacy
// "Daylens" / "DaylensWindows" directories when they hold the meaningful data.
// A hardcoded legacy path here previously served months-stale data on machines
// where the app had long since moved to "Daylens Desktop".
//
// userData.ts is pure Node (fs/path only), so both the vite bundle
// (vite.mcp.config.ts) and the dev ts-loader can pull it in directly.
import os from 'node:os'
import path from 'node:path'
import { chooseUserDataPath } from '../../../src/main/services/userData'

// Mirrors Electron's app.getPath('appData') per platform — the base directory
// the app's userData folders live under.
export function defaultAppDataPath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homedir: string,
): string {
  if (platform === 'win32') {
    return env.APPDATA ?? path.join(homedir, 'AppData', 'Roaming')
  }
  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support')
  }
  return env.XDG_CONFIG_HOME ?? path.join(homedir, '.config')
}

export function resolveDefaultDbPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
): string {
  const appData = defaultAppDataPath(platform, env, homedir)
  return path.join(chooseUserDataPath(appData, platform), 'daylens.sqlite')
}
