// Reset-and-uninstall cleanup: removes the launch-on-login registration and,
// when the person explicitly chooses it, the local data directories. The data
// deletion runs from a detached helper after this process exits because
// Chromium keeps profile files open (and on Windows locked) until then.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, dialog, shell } from 'electron'
import { APP_DISPLAY_NAME, listUserDataCandidatePaths } from './userData'
import { getLinuxPackageDiagnostics, syncLinuxLaunchOnLogin } from './linuxDesktop'
import { clearApiKey } from './settings'
import type { AIProviderMode } from '@shared/types'

const API_KEY_PROVIDERS: AIProviderMode[] = ['anthropic', 'openai', 'google', 'openrouter']

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function collectLocalDataTargets(
  appDataPath: string,
  userDataPath: string,
  platform: NodeJS.Platform,
): string[] {
  const candidates = [userDataPath, ...listUserDataCandidatePaths(appDataPath, platform)]
  const unique = candidates.filter((candidate, index) => candidates.indexOf(candidate) === index)
  return unique.filter((candidate) => {
    try {
      return fs.statSync(candidate).isDirectory()
    } catch {
      return false
    }
  })
}

export function windowsUninstallerPath(execPath: string): string {
  return path.join(path.dirname(execPath), `Uninstall ${APP_DISPLAY_NAME}.exe`)
}

export function buildPosixDataCleanupScript(parentPid: number, targets: string[], logPath: string): string {
  const quotedTargets = targets.map(shQuote).join(' ')
  return `#!/bin/sh
exec >>${shQuote(logPath)} 2>&1
echo "[uninstall-cleanup] waiting for pid ${parentPid}"
i=0
while kill -0 ${parentPid} 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 200 ]; then break; fi
  sleep 0.15
done
sleep 0.5
rm -rf ${quotedTargets}
echo "[uninstall-cleanup] done"
rm -- "$0" 2>/dev/null || true
`
}

export function buildWindowsDataCleanupScript(parentPid: number, targets: string[]): string {
  const removals = targets.map((target) => `rd /s /q "${target}"`).join('\r\n')
  // No delayed expansion: it would corrupt paths containing "!". The goto-based
  // loop re-expands %tries% on every iteration anyway.
  return [
    '@echo off',
    'setlocal',
    'set tries=0',
    ':wait',
    'set /a tries+=1',
    'if %tries% gtr 120 goto clean',
    `tasklist /FI "PID eq ${parentPid}" 2>nul | findstr /r /c:" ${parentPid} " >nul`,
    'if not errorlevel 1 (',
    '  timeout /t 1 /nobreak >nul',
    '  goto wait',
    ')',
    ':clean',
    removals,
    'del "%~f0"',
    '',
  ].join('\r\n')
}

async function clearAllStoredApiKeys(): Promise<void> {
  for (const provider of API_KEY_PROVIDERS) {
    try {
      await clearApiKey(provider)
    } catch {
      // Key removal is best-effort: a locked or missing credential vault must
      // not block the rest of the cleanup.
    }
  }
}

function schedulePosixDataCleanup(targets: string[]): void {
  const cleanupId = `${Date.now()}-${process.pid}`
  const scriptPath = path.join(os.tmpdir(), `daylens-uninstall-cleanup-${cleanupId}.sh`)
  const logPath = path.join(os.tmpdir(), `daylens-uninstall-cleanup-${cleanupId}.log`)
  fs.writeFileSync(scriptPath, buildPosixDataCleanupScript(process.pid, targets, logPath), { mode: 0o755 })
  spawn('/bin/sh', [scriptPath], { detached: true, stdio: 'ignore' }).unref()
}

function scheduleWindowsDataCleanup(targets: string[]): void {
  const scriptPath = path.join(os.tmpdir(), `daylens-uninstall-cleanup-${Date.now()}-${process.pid}.cmd`)
  fs.writeFileSync(scriptPath, buildWindowsDataCleanupScript(process.pid, targets))
  spawn('cmd.exe', ['/d', '/s', '/c', scriptPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

export async function performUninstallCleanup(options: { deleteLocalData: boolean }): Promise<void> {
  const platform = process.platform

  if (options.deleteLocalData) {
    await clearAllStoredApiKeys()
  }

  if ((platform === 'darwin' || platform === 'win32') && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: false })
  }
  await syncLinuxLaunchOnLogin(false)

  const targets = options.deleteLocalData
    ? collectLocalDataTargets(app.getPath('appData'), app.getPath('userData'), platform)
    : []

  if (platform === 'win32') {
    const uninstaller = windowsUninstallerPath(process.execPath)
    if (app.isPackaged && fs.existsSync(uninstaller)) {
      // The NSIS uninstaller owns the removal: silent so the person's in-app
      // data choice is not re-asked, --delete-app-data only when they chose it.
      const args = ['/S']
      if (options.deleteLocalData) args.push('--delete-app-data')
      spawn(uninstaller, args, { detached: true, stdio: 'ignore' }).unref()
      return
    }
    if (targets.length > 0) scheduleWindowsDataCleanup(targets)
    return
  }

  if (targets.length > 0) {
    schedulePosixDataCleanup(targets)
  }

  if (platform === 'darwin' && app.isPackaged) {
    // macOS has no uninstaller hook — reveal the bundle so the person can drag
    // it to the Trash to finish the uninstall.
    shell.showItemInFolder(path.resolve(process.execPath, '..', '..', '..'))
  }

  if (platform === 'linux' && app.isPackaged) {
    // The app cannot remove its own deb/rpm (a root package operation), so hand
    // the person the exact finishing step — otherwise relaunching the still-
    // installed app would recreate fresh data and the default login item.
    const removalCommand = linuxPackageRemovalCommand()
    if (removalCommand) {
      await dialog.showMessageBox({
        type: 'info',
        title: 'Finish uninstalling Daylens',
        message: 'One step left to finish uninstalling.',
        detail: `Daylens has stopped launching at login and is quitting now. To remove the application itself, run:\n\n${removalCommand}`,
        buttons: ['OK'],
      })
    }
    const appImagePath = process.env.APPIMAGE?.trim()
    if (appImagePath && fs.existsSync(appImagePath)) shell.showItemInFolder(appImagePath)
  }
}

export function removalCommandForPackageType(packageType: string | null, owner: string | null): string | null {
  const packageName = owner?.trim() || 'daylens'
  if (packageType === 'deb') return `sudo apt remove ${packageName}`
  if (packageType === 'rpm') return `sudo dnf remove ${packageName}`
  if (packageType === 'pacman') return `sudo pacman -R ${packageName}`
  // AppImage and tar.gz installs are removed by deleting the file, which the
  // caller handles by revealing it.
  return null
}

function linuxPackageRemovalCommand(): string | null {
  const diagnostics = getLinuxPackageDiagnostics()
  if (!diagnostics) return null
  return removalCommandForPackageType(diagnostics.packageType, diagnostics.owner)
}
