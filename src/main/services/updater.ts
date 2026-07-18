import { app, BrowserWindow, ipcMain, net } from 'electron'
import { autoUpdater } from 'electron-updater'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, constants as fsConstants, readFileSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ANALYTICS_EVENT, classifyFailureKind } from '@shared/analytics'
import {
  boundedDownloadProgressPercent,
  buildRemoteUpdateFeedUrl,
  compareReleaseVersions,
  downloadProgressPercent,
  isRemoteUpdateDescriptor,
  normalizeInstallSha256,
  normalizeRemoteUpdaterError,
  type RemoteUpdateDescriptor,
} from '@shared/updaterReleaseFeed'
import { capture, captureException } from './analytics'
import { getLinuxPackageDiagnostics, type LinuxPackageType } from './linuxDesktop'
import { isRealDayHarness } from '../lib/realDayHarness'

const MANUAL_DOWNLOAD_URL = 'https://christian-tonny.dev/daylens'
const REMOTE_UPDATE_FEED_URL = process.env.DAYLENS_UPDATE_FEED_URL?.trim() || 'https://christian-tonny.dev/daylens/api/update-feed'

export interface UpdaterState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error' | 'installing'
  version: string | null
  progressPct: number | null
  errorMessage: string | null
  releaseName: string | null
  releaseNotesText: string | null
  releaseDate: string | null
  packageType: LinuxPackageType
  supported: boolean
  supportMessage: string | null
  downloadUrl: string | null
  // False when an available update cannot be verified before install (feed
  // published no SHA-256 digest, or the artifact URL is not HTTPS). The UI
  // must then offer only the manual download.
  canAutoInstall: boolean
}

let _updateAvailable: string | null = null
export function getUpdateAvailable(): string | null { return _updateAvailable }

let _installingUpdate = false
let _statusWindow: BrowserWindow | null = null
let _beforeInstall: (() => Promise<void>) | null = null
let _pendingRemoteUpdate: RemoteUpdateDescriptor | null = null
let _state: UpdaterState = {
  status: 'idle',
  version: null,
  progressPct: null,
  errorMessage: null,
  releaseName: null,
  releaseNotesText: null,
  releaseDate: null,
  packageType: null,
  supported: false,
  supportMessage: null,
  downloadUrl: null,
  canAutoInstall: true,
}

export function isInstallingUpdate(): boolean { return _installingUpdate }

// Reset-and-uninstall quits with a downloaded update possibly staged;
// autoInstallOnAppQuit would reinstall the app the person just removed.
export function cancelPendingAutoInstall(): void {
  try {
    autoUpdater.autoInstallOnAppQuit = false
  } catch {
    // If electron-updater is unavailable there is nothing staged to cancel.
  }
}
export function registerUpdaterShutdown(fn: () => Promise<void>): void { _beforeInstall = fn }
export function getUpdaterState(): UpdaterState { return { ..._state } }

// Squirrel.Mac validates the downloaded bundle against the running app's
// designated requirement before swapping it in. Ad-hoc signatures (no Apple
// Developer ID) never satisfy that check (different cdhash, no Team ID
// anchor), so electron-updater's quitAndInstall path always fails on this
// build. We sidestep Squirrel entirely on ad-hoc Mac: download the ZIP from
// the GitHub release direct, extract with ditto, then hand a detached swap
// script the responsibility of replacing /Applications/Daylens.app once the
// running process exits.
let _macAdhocCache: boolean | null = null
let _windowsAuthenticodeCache: boolean | null = null

// The ad-hoc signing status only changes when the bundle changes, i.e. on a new
// version. Persist it in userData keyed by version so subsequent launches of the
// same build skip the `codesign` subprocess entirely.
function signingManifestPath(): string {
  return path.join(app.getPath('userData'), 'updater-signing.json')
}

function readPersistedAdhoc(version: string): boolean | null {
  try {
    const raw = readFileSync(signingManifestPath(), 'utf8')
    const parsed = JSON.parse(raw) as { version?: string; adhoc?: boolean }
    if (parsed.version === version && typeof parsed.adhoc === 'boolean') return parsed.adhoc
  } catch {
    // missing or unreadable manifest — fall through to probe
  }
  return null
}

function writePersistedAdhoc(version: string, adhoc: boolean): void {
  try {
    writeFileSync(signingManifestPath(), `${JSON.stringify({ version, adhoc })}\n`, 'utf8')
  } catch {
    // best-effort cache; a write failure just means we probe again next launch
  }
}

function isMacAdhocSigned(): boolean {
  if (process.platform !== 'darwin' || !app.isPackaged) return false
  if (_macAdhocCache !== null) return _macAdhocCache

  const version = app.getVersion()
  const persisted = readPersistedAdhoc(version)
  if (persisted !== null) {
    _macAdhocCache = persisted
    return persisted
  }

  try {
    const appBundlePath = path.resolve(process.execPath, '..', '..', '..')
    const result = spawnSync('/usr/bin/codesign', ['-dv', appBundlePath], {
      encoding: 'utf8',
    })
    const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`
    _macAdhocCache = /Signature=adhoc/i.test(combined) || /TeamIdentifier=not set/i.test(combined)
  } catch {
    _macAdhocCache = true
  }
  writePersistedAdhoc(version, _macAdhocCache)
  return _macAdhocCache
}

function canUseElectronUpdaterInstall(): boolean {
  // electron-updater (and Squirrel.Mac) cannot install onto an ad-hoc bundle.
  // Returns false there so we route the install through performAdhocMacInstall.
  if (process.platform === 'darwin') return !isMacAdhocSigned()
  return true
}

function isWindowsAuthenticodeSigned(): boolean {
  if (process.platform !== 'win32' || !app.isPackaged) return false
  if (_windowsAuthenticodeCache !== null) return _windowsAuthenticodeCache

  try {
    const script = [
      '$sig = Get-AuthenticodeSignature -FilePath $env:DAYLENS_EXE_PATH',
      "if ($sig.Status -eq 'Valid') { 'valid' } else { 'invalid' }",
    ].join('; ')
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8',
      env: { ...process.env, DAYLENS_EXE_PATH: process.execPath },
      timeout: 5_000,
      windowsHide: true,
    })
    _windowsAuthenticodeCache = result.status === 0 && result.stdout.trim().toLowerCase() === 'valid'
  } catch {
    _windowsAuthenticodeCache = false
  }

  return _windowsAuthenticodeCache
}

function getAutoUpdateSupport(): { supported: boolean; message: string | null; packageType: LinuxPackageType } {
  if (!app.isPackaged) {
    return {
      supported: false,
      message: 'Automatic updates are only available in packaged builds.',
      packageType: null,
    }
  }

  if (process.platform === 'win32') {
    if (!isWindowsAuthenticodeSigned()) {
      return {
        supported: false,
        message: 'This Windows build is unsigned, so built-in updates are disabled. Install a signed Daylens build to receive automatic updates.',
        packageType: null,
      }
    }
    return {
      supported: true,
      message: 'Daylens downloads updates silently in the background and applies them the next time you quit the app.',
      packageType: null,
    }
  }

  if (process.platform === 'darwin') {
    if (isMacAdhocSigned()) {
      return {
        supported: true,
        message: 'This Daylens build is ad-hoc signed (no Apple Developer ID), so Daylens downloads the update and swaps the app bundle in place with its own helper instead of macOS Squirrel. Fresh downloads can still trigger Gatekeeper until Daylens ships with Developer ID signing and notarization.',
        packageType: null,
      }
    }
    return {
      supported: true,
      message: 'Automatic update checks are enabled for this Daylens build. Daylens installs a new version only when you choose it.',
      packageType: null,
    }
  }

  if (process.platform === 'linux') {
    const packageDiagnostics = getLinuxPackageDiagnostics()
    const packageType = packageDiagnostics?.packageType ?? null

    if (packageType === 'appimage') {
      return {
        supported: true,
        message: 'AppImage runtime detected. Daylens can download and apply updates for this install.',
        packageType,
      }
    }

    if (packageType === 'deb') {
      return {
        supported: true,
        message: `DEB-managed install detected${packageDiagnostics?.owner ? ` (${packageDiagnostics.owner})` : ''}. Daylens can download a newer .deb and hand it off to dpkg or apt.`,
        packageType,
      }
    }

    if (packageType === 'rpm') {
      return {
        supported: true,
        message: `RPM-managed install detected${packageDiagnostics?.owner ? ` (${packageDiagnostics.owner})` : ''}. Daylens can download a newer .rpm and hand it off to the system package manager.`,
        packageType,
      }
    }

    if (packageType === 'pacman') {
      return {
        supported: false,
        message: `Pacman-managed install detected${packageDiagnostics?.owner ? ` (${packageDiagnostics.owner})` : ''}, but this repo does not publish a native pacman artifact yet. Built-in updates stay disabled here for now.`,
        packageType,
      }
    }

    return {
      supported: false,
      message: 'This Linux install could not be matched to an AppImage, DEB, or RPM package, so built-in updates stay disabled here.',
      packageType,
    }
  }

  return {
    supported: false,
    message: 'Automatic updates are not enabled for this platform yet.',
    packageType: null,
  }
}

function supportsAutoUpdates(): boolean {
  return getAutoUpdateSupport().supported
}

function usesRemoteUpdateFeed(): boolean {
  // macOS needs the remote feed because Squirrel.Mac validates the bundle against
  // the running app's designated requirement. Ad-hoc builds (no Developer ID) always
  // fail that check, so we bypass Squirrel entirely and do the swap ourselves.
  // Windows uses electron-updater's native NSIS update path, which silently downloads
  // the new installer in the background and applies it on the next app quit — no remote
  // feed needed there.
  return process.platform === 'darwin'
}

function normalizeUpdaterErrorMessage(message: string): string {
  if (usesRemoteUpdateFeed()) {
    return normalizeRemoteUpdaterError(message)
  }

  if (process.platform === 'win32') {
    if (/latest\.yml/i.test(message) && /(404|Cannot find)/i.test(message)) {
      return 'This Windows release was published without updater metadata, so in-app updates are unavailable for this build. Download the latest Windows installer from the Daylens site instead.'
    }
    return message
  }

  if (process.platform !== 'linux') return message

  if (/APPIMAGE/i.test(message)) {
    return 'Automatic updates are unavailable for this Linux install. Use the AppImage, DEB, or RPM release instead of the tarball build.'
  }

  if (/latest-linux\.yml|latest\.yml|Cannot find channel/i.test(message)) {
    return 'Daylens could not find published Linux update metadata for this release.'
  }

  if (/Cannot find.*(AppImage|deb|rpm|pacman)/i.test(message)) {
    return 'Daylens found Linux update metadata, but it did not include an artifact compatible with this install type.'
  }

  if (/pkexec|sudo/i.test(message)) {
    return 'Daylens downloaded the Linux update, but the system package manager could not start with elevated permissions.'
  }

  if (/zypper|dnf|yum|rpm|dpkg|apt-get|apt\b|pacman/i.test(message) && /not found|ENOENT/i.test(message)) {
    return 'Daylens could not find a compatible Linux package manager to install the downloaded update automatically.'
  }

  return message
}

function emitState(): void {
  _statusWindow?.webContents.send('update:status', getUpdaterState())
}

function setUpdaterState(partial: Partial<UpdaterState>): void {
  _state = { ..._state, ...partial }
  emitState()
}

function getReleaseNotesText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  if (Array.isArray(value)) {
    const combined = value
      .map((entry) => {
        if (typeof entry === 'string') return entry.trim()
        if (!entry || typeof entry !== 'object') return ''
        const note = (entry as { note?: unknown }).note
        return typeof note === 'string' ? note.trim() : ''
      })
      .filter(Boolean)
      .join('\n\n')

    return combined.length > 0 ? combined : null
  }

  return null
}

function getReleaseMetadata(info: unknown): Pick<UpdaterState, 'releaseName' | 'releaseNotesText' | 'releaseDate'> {
  if (!info || typeof info !== 'object') {
    return { releaseName: null, releaseNotesText: null, releaseDate: null }
  }

  const candidate = info as {
    releaseName?: unknown
    releaseNotes?: unknown
    releaseDate?: unknown
  }

  return {
    releaseName: typeof candidate.releaseName === 'string' ? candidate.releaseName : null,
    releaseNotesText: getReleaseNotesText(candidate.releaseNotes),
    releaseDate: typeof candidate.releaseDate === 'string' ? candidate.releaseDate : null,
  }
}

function resetNoUpdateState(support: ReturnType<typeof getAutoUpdateSupport>): void {
  _pendingRemoteUpdate = null
  _updateAvailable = null
  setUpdaterState({
    status: 'not-available',
    version: app.getVersion(),
    progressPct: null,
    errorMessage: null,
    releaseName: null,
    releaseNotesText: null,
    releaseDate: null,
    packageType: support.packageType,
    supported: support.supported,
    supportMessage: support.message,
    downloadUrl: null,
    canAutoInstall: true,
  })
}

function remoteUpdateIsVerifiable(descriptor: RemoteUpdateDescriptor): boolean {
  if (normalizeInstallSha256(descriptor.installSha256) === null) return false
  try {
    return new URL(descriptor.installUrl).protocol === 'https:'
  } catch {
    return false
  }
}

function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

async function fetchRemoteUpdateDescriptor(): Promise<RemoteUpdateDescriptor> {
  const url = buildRemoteUpdateFeedUrl(REMOTE_UPDATE_FEED_URL, process.platform, process.arch)
  const response = await net.fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'daylens-desktop-updater',
    },
  })

  if (!response.ok) {
    const body = (await response.text()).trim()
    throw new Error(`Update feed request failed (HTTP ${response.status})${body ? `: ${body}` : ''}`)
  }

  const payload = await response.json()
  if (!isRemoteUpdateDescriptor(payload)) {
    throw new Error('Update feed returned an invalid payload.')
  }
  return payload
}

async function checkRemoteFeed(trigger: 'manual' | 'background', support: ReturnType<typeof getAutoUpdateSupport>): Promise<UpdaterState> {
  const previousState = getUpdaterState()
  const previousPendingRemoteUpdate = _pendingRemoteUpdate
  const previousUpdateAvailable = _updateAvailable

  setUpdaterState({
    status: 'checking',
    errorMessage: null,
    progressPct: null,
  })

  try {
    const remoteUpdate = await fetchRemoteUpdateDescriptor()
    if (compareReleaseVersions(remoteUpdate.version, app.getVersion()) <= 0) {
      capture(ANALYTICS_EVENT.UPDATE_CHECK_COMPLETED, {
        result: 'not_available',
        status: 'not_available',
        surface: 'updater',
        trigger,
      })
      resetNoUpdateState(support)
      return getUpdaterState()
    }

    _pendingRemoteUpdate = remoteUpdate
    _updateAvailable = remoteUpdate.version

    // An update is only auto-installable when it can be verified end to end:
    // the artifact must travel over HTTPS and the feed must publish a SHA-256
    // digest to check the download against. Otherwise the user gets the
    // manual download path only (fail closed — never swap in an unverified
    // bundle and strip its quarantine).
    const canAutoInstall = remoteUpdateIsVerifiable(remoteUpdate)

    capture(ANALYTICS_EVENT.UPDATE_AVAILABLE, {
      result: 'available',
      status: 'available',
      version: remoteUpdate.version,
    })
    capture(ANALYTICS_EVENT.UPDATE_CHECK_COMPLETED, {
      result: 'available',
      status: 'available',
      version: remoteUpdate.version,
      surface: 'updater',
      trigger,
    })

    setUpdaterState({
      status: 'available',
      version: remoteUpdate.version,
      progressPct: null,
      errorMessage: null,
      releaseName: remoteUpdate.releaseName,
      releaseNotesText: remoteUpdate.releaseNotesText,
      releaseDate: remoteUpdate.releaseDate,
      downloadUrl: remoteUpdate.manualUrl ?? MANUAL_DOWNLOAD_URL,
      canAutoInstall,
      supportMessage: canAutoInstall
        ? support.message
        : 'This release was published without a verification digest, so Daylens will not replace the app automatically. Use the manual download instead.',
    })
    return getUpdaterState()
  } catch (err) {
    _pendingRemoteUpdate = null
    _updateAvailable = null

    capture(ANALYTICS_EVENT.UPDATE_ERROR, {
      failure_kind: classifyFailureKind(err),
      result: 'error',
      surface: 'updater',
    })
    capture(ANALYTICS_EVENT.UPDATE_CHECK_COMPLETED, {
      failure_kind: classifyFailureKind(err),
      result: 'error',
      status: 'error',
      surface: 'updater',
      trigger,
    })
    captureException(err, {
      tags: {
        process_type: 'main',
        reason: 'remote_update_check_failed',
      },
    })

    if (trigger === 'background') {
      _pendingRemoteUpdate = previousPendingRemoteUpdate
      _updateAvailable = previousUpdateAvailable
      _state = previousState
      emitState()
      return getUpdaterState()
    }

    const message = err instanceof Error ? err.message : 'Daylens could not check the public update feed.'
    setUpdaterState({
      status: 'error',
      errorMessage: normalizeUpdaterErrorMessage(message),
      progressPct: null,
      releaseName: null,
      releaseNotesText: null,
      releaseDate: null,
      downloadUrl: previousState.downloadUrl ?? MANUAL_DOWNLOAD_URL,
    })
    return getUpdaterState()
  }
}

function downloadToFile(
  url: string,
  destPath: string,
  onProgress: (pct: number | null) => void,
  expectedBytes?: number | null,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, redirect: 'follow' })
    request.on('response', (response) => {
      const status = response.statusCode ?? 0
      if (status < 200 || status >= 300) {
        reject(new Error(`Download failed (HTTP ${status}) — the release artifact may not be published yet.`))
        return
      }
      const totalHeader = response.headers['content-length']
      const headerTotal = Array.isArray(totalHeader) ? Number(totalHeader[0]) : Number(totalHeader)
      const total = Number.isFinite(expectedBytes) && expectedBytes && expectedBytes > 0
        ? expectedBytes
        : headerTotal
      let received = 0
      const fileStream = createWriteStream(destPath)
      let lastEmittedPct: number | null = null
      let settled = false
      const settleReject = (err: unknown) => {
        if (settled) return
        settled = true
        fileStream.destroy()
        reject(err)
      }
      response.on('data', (chunk: Buffer) => {
        received += chunk.length
        fileStream.write(chunk)
        const pct = downloadProgressPercent(received, total)
        if (pct !== lastEmittedPct) {
          lastEmittedPct = pct
          onProgress(pct)
        }
      })
      response.on('end', () => {
        if (Number.isFinite(total) && total && received !== total) {
          settleReject(new Error(`Downloaded update was incomplete (${received} of ${total} bytes).`))
          return
        }
        fileStream.end(() => {
          if (settled) return
          settled = true
          resolve()
        })
      })
      response.on('error', settleReject)
      fileStream.on('error', settleReject)
    })
    request.on('error', reject)
    request.end()
  })
}

async function downloadRemoteInstaller(onProgress: (pct: number | null) => void): Promise<string> {
  if (!_pendingRemoteUpdate) throw new Error('Daylens does not have a pending update to install.')
  const url = _pendingRemoteUpdate.installUrl

  // Fail closed: never download-and-install an artifact that cannot be
  // verified. The check state already routed unverifiable updates to manual
  // download; this guard is the backstop if install is invoked anyway.
  const expectedSha256 = normalizeInstallSha256(_pendingRemoteUpdate.installSha256)
  if (!expectedSha256) {
    throw new Error('This release was published without a verification digest, so Daylens cannot install it automatically. Use the manual download instead.')
  }
  if (!remoteUpdateIsVerifiable(_pendingRemoteUpdate)) {
    throw new Error('The update artifact is not served over HTTPS, so Daylens cannot install it automatically. Use the manual download instead.')
  }

  const fileName = _pendingRemoteUpdate.installFileName || `daylens-update-${_pendingRemoteUpdate.version}`
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'daylens-update-'))
  const tmpFile = path.join(tmpDir, fileName)
  try {
    await downloadToFile(url, tmpFile, onProgress, _pendingRemoteUpdate.installSizeBytes)
    if (_pendingRemoteUpdate.installSizeBytes) {
      const stat = await fs.stat(tmpFile)
      if (stat.size !== _pendingRemoteUpdate.installSizeBytes) {
        throw new Error(`Downloaded update was incomplete (${stat.size} of ${_pendingRemoteUpdate.installSizeBytes} bytes).`)
      }
    }
    const actualSha256 = await sha256OfFile(tmpFile)
    if (actualSha256 !== expectedSha256) {
      throw new Error('The downloaded update did not match the published checksum, so it was discarded. Try again, or use the manual download.')
    }
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* best-effort temp cleanup */ })
    throw err
  }
  return tmpFile
}

interface StagedAdhocMacUpdate {
  extractDir: string
  stagedApp: string
  zipParent: string
}

function readMacBundleIdentifier(appBundlePath: string): string | null {
  try {
    const result = spawnSync('/usr/bin/defaults', ['read', path.join(appBundlePath, 'Contents', 'Info'), 'CFBundleIdentifier'], {
      encoding: 'utf8',
      timeout: 5_000,
    })
    if (result.status !== 0) return null
    const value = (result.stdout ?? '').trim()
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

async function stageAdhocMacUpdate(zipPath: string): Promise<StagedAdhocMacUpdate> {
  const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), 'daylens-extract-'))
  const extract = spawnSync('/usr/bin/ditto', ['-x', '-k', zipPath, extractDir], { encoding: 'utf8' })
  if (extract.status !== 0) {
    throw new Error(`Update archive could not be opened: ${(extract.stderr || extract.stdout || '').trim() || `exit ${extract.status}`}`)
  }

  try {
    const entries = await fs.readdir(extractDir)
    const appName = entries.find((name) => name.endsWith('.app'))
    if (!appName) throw new Error('Update archive did not contain a .app bundle')
    const stagedApp = path.join(extractDir, appName)

    const targetApp = path.resolve(process.execPath, '..', '..', '..')

    // The hash pinned the bytes to the published release; this pins the
    // CONTENT to being a Daylens bundle before the swap script rm -rfs the
    // installed app and strips quarantine. A zip that hash-matched but does
    // not identify as this app never reaches the swap.
    const stagedBundleId = readMacBundleIdentifier(stagedApp)
    const runningBundleId = readMacBundleIdentifier(targetApp)
    if (!stagedBundleId || (runningBundleId && stagedBundleId !== runningBundleId)) {
      throw new Error('The downloaded update does not identify as Daylens, so it was discarded. Use the manual download instead.')
    }

    try {
      await fs.access(path.dirname(targetApp), fsConstants.W_OK)
    } catch {
      throw new Error(`Daylens cannot write to ${path.dirname(targetApp)} — move the app to /Applications and try again, or download the update manually.`)
    }

    return {
      extractDir,
      stagedApp,
      zipParent: path.dirname(zipPath),
    }
  } catch (err) {
    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => { /* best-effort temp cleanup */ })
    await fs.rm(path.dirname(zipPath), { recursive: true, force: true }).catch(() => { /* best-effort temp cleanup */ })
    throw err
  }
}

async function runBeforeInstallShutdown(): Promise<void> {
  if (!_beforeInstall) return
  try {
    await _beforeInstall()
  } catch (err) {
    // The app is already about to quit for an update. Shutdown is best-effort:
    // failures here should not strand the user after a valid update was staged.
    captureException(err, {
      tags: { process_type: 'main', reason: 'updater_shutdown_cleanup_failed' },
    })
  }
}

function friendlyUpdaterError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err || '')
  const compact = message.replace(/\s+/g, ' ').trim()

  if (/Database not initialised|initDb\(\)|database/i.test(compact)) {
    return 'Daylens got into an unusual state while closing for the update. Quit Daylens completely, reopen it, then choose Install update again. Your activity history is still safe on this computer.'
  }

  if (/incomplete|archive|pkzip|zip|ditto|extract|\.app bundle/i.test(compact)) {
    return 'The update download did not finish cleanly. Please try Install update again and Daylens will download a fresh copy.'
  }

  if (/cannot write|permission|EACCES|EPERM|Applications/i.test(compact)) {
    return 'Daylens could not replace the app in its current location. Move Daylens to Applications, reopen it, then try the update again.'
  }

  if (/HTTP|network|ENOTFOUND|EAI_AGAIN|ECONNRESET|timed out/i.test(compact)) {
    return 'Daylens could not finish downloading the update. Check your internet connection and try again.'
  }

  return 'Daylens could not finish the update. Please quit and reopen Daylens, then try Install update again.'
}

async function scheduleAdhocMacSwap(staged: StagedAdhocMacUpdate): Promise<void> {
  const { extractDir, stagedApp, zipParent } = staged
  const swapId = `${Date.now()}-${process.pid}`
  const scriptPath = path.join(os.tmpdir(), `daylens-swap-${swapId}.sh`)
  const logPath = path.join(os.tmpdir(), `daylens-swap-${swapId}.log`)
  const ppid = process.pid
  const targetApp = path.resolve(process.execPath, '..', '..', '..')

  // Detached helper: poll until the parent process has exited, atomically swap
  // the bundle at the original path (so dock icons / launchd refs survive),
  // re-sign ad-hoc + clear quarantine xattr so Gatekeeper accepts the moved
  // bundle, then relaunch.
  const script = `#!/bin/bash
set -u
exec >>"${logPath}" 2>&1
echo "[swap] start $(date)"
for i in $(seq 1 200); do
  if ! kill -0 ${ppid} 2>/dev/null; then break; fi
  sleep 0.15
done
sleep 0.5
if [ -d "${targetApp}" ]; then
  rm -rf "${targetApp}"
fi
mv "${stagedApp}" "${targetApp}" || { echo "[swap] mv failed"; exit 1; }
/usr/bin/codesign --force --deep --sign - "${targetApp}" || true
/usr/bin/xattr -cr "${targetApp}" || true
/usr/bin/open -n "${targetApp}"
rm -rf "${extractDir}" "${zipParent}" 2>/dev/null || true
rm -- "$0" 2>/dev/null || true
echo "[swap] done $(date)"
`
  await fs.writeFile(scriptPath, script, { mode: 0o755 })

  const child = spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' })
  child.unref()
}

async function performAdhocMacInstall(): Promise<boolean> {
  if (_installingUpdate || !_pendingRemoteUpdate) return false

  if (!remoteUpdateIsVerifiable(_pendingRemoteUpdate)) {
    setUpdaterState({
      status: 'available',
      errorMessage: null,
      progressPct: null,
      canAutoInstall: false,
      downloadUrl: _pendingRemoteUpdate.manualUrl ?? MANUAL_DOWNLOAD_URL,
      supportMessage: 'This release was published without a verification digest, so Daylens will not replace the app automatically. Use the manual download instead.',
    })
    return false
  }

  const version = _pendingRemoteUpdate.version
  capture(ANALYTICS_EVENT.UPDATE_INSTALL_REQUESTED, {
    surface: 'updater',
    trigger: 'manual',
    version,
  })

  try {
    setUpdaterState({ status: 'downloading', progressPct: null, errorMessage: null, downloadUrl: null })
    const zipPath = await downloadRemoteInstaller((pct) => {
      setUpdaterState({ status: 'downloading', progressPct: pct })
    })
    const stagedUpdate = await stageAdhocMacUpdate(zipPath)

    setUpdaterState({ status: 'installing', progressPct: 100, errorMessage: null })
    capture(ANALYTICS_EVENT.UPDATE_INSTALL_STARTED, {
      surface: 'updater',
      trigger: 'manual',
      version,
    })

    await runBeforeInstallShutdown()
    await scheduleAdhocMacSwap(stagedUpdate)

    _installingUpdate = true
    setTimeout(() => app.quit(), 250)
    return true
  } catch (err) {
    _installingUpdate = false
    capture(ANALYTICS_EVENT.UPDATE_ERROR, {
      failure_kind: classifyFailureKind(err),
      result: 'error',
      surface: 'updater',
    })
    captureException(err, {
      tags: { process_type: 'main', reason: 'adhoc_mac_install_failed' },
    })
    setUpdaterState({
      status: 'error',
      errorMessage: friendlyUpdaterError(err),
      progressPct: null,
      downloadUrl: MANUAL_DOWNLOAD_URL,
    })
    return false
  }
}

export function initUpdater(
  win: BrowserWindow,
  options: { diagnosticsOnly?: boolean } = {},
): void {
  _statusWindow = win
  const support = getAutoUpdateSupport()
  _state = {
    ..._state,
    version: app.getVersion(),
    packageType: support.packageType,
    supported: support.supported,
    supportMessage: support.message,
  }
  emitState()

  if (options.diagnosticsOnly) return

  ipcMain.removeHandler('update:get-status')
  ipcMain.removeHandler('update:check')
  ipcMain.removeHandler('update:install')

  if (isRealDayHarness()) {
    ipcMain.handle('update:get-status', () => getUpdaterState())
    ipcMain.handle('update:check', () => getUpdaterState())
    ipcMain.handle('update:install', () => false)
    return
  }

  ipcMain.handle('update:get-status', () => {
    return getUpdaterState()
  })

  ipcMain.handle('update:check', async () => {
    capture(ANALYTICS_EVENT.UPDATE_CHECK_REQUESTED, {
      surface: 'settings',
      trigger: 'manual',
    })

    if (!supportsAutoUpdates()) {
      setUpdaterState({
        status: 'not-available',
        version: app.getVersion(),
        progressPct: null,
        errorMessage: null,
        releaseName: null,
        releaseNotesText: null,
        releaseDate: null,
        packageType: support.packageType,
        supported: support.supported,
        supportMessage: support.message,
        downloadUrl: null,
      })
      capture(ANALYTICS_EVENT.UPDATE_CHECK_COMPLETED, {
        result: 'not_supported',
        status: 'not_available',
        surface: 'updater',
        trigger: 'manual',
      })
      return getUpdaterState()
    }

    if (usesRemoteUpdateFeed()) {
      return checkRemoteFeed('manual', support)
    }

    try {
      await autoUpdater.checkForUpdates()
    } catch {
      // Errors are reflected through the updater state.
    }
    return getUpdaterState()
  })

  ipcMain.handle('update:install', async () => {
    if (!supportsAutoUpdates()) return false

    if (process.platform === 'darwin') {
      if (_state.status !== 'available' || _installingUpdate) return false
      return performAdhocMacInstall()
    }



    if (_state.status !== 'downloaded' || _installingUpdate) return false

    capture(ANALYTICS_EVENT.UPDATE_INSTALL_REQUESTED, {
      surface: 'updater',
      trigger: 'manual',
      version: _state.version ?? app.getVersion(),
    })

    try {
      setUpdaterState({ status: 'installing', errorMessage: null })
      capture(ANALYTICS_EVENT.UPDATE_INSTALL_STARTED, {
        surface: 'updater',
        trigger: 'manual',
        version: _state.version ?? app.getVersion(),
      })

      await runBeforeInstallShutdown()

      _installingUpdate = true

      setImmediate(() => {
        autoUpdater.quitAndInstall()
      })

      return true
    } catch (err) {
      _installingUpdate = false
      capture(ANALYTICS_EVENT.UPDATE_ERROR, {
        failure_kind: classifyFailureKind(err),
        result: 'error',
        surface: 'updater',
      })
      captureException(err, {
        tags: {
          process_type: 'main',
          reason: 'update_install_failed',
        },
      })
      setUpdaterState({
        status: 'error',
        errorMessage: friendlyUpdaterError(err),
      })
      return false
    }
  })

  if (!supportsAutoUpdates()) return

  if (usesRemoteUpdateFeed()) {
    setTimeout(() => {
      console.log('[updater] checking public update feed…')
      void checkRemoteFeed('background', support)
    }, 10_000)
    return
  }

  const electronUpdaterInstall = canUseElectronUpdaterInstall()
  autoUpdater.autoDownload = electronUpdaterInstall
  autoUpdater.autoInstallOnAppQuit = electronUpdaterInstall && process.platform !== 'linux'

  autoUpdater.on('checking-for-update', () => {
    setUpdaterState({
      status: 'checking',
      errorMessage: null,
      progressPct: null,
    })
  })

  autoUpdater.on('update-available', (info) => {
    _updateAvailable = info.version
    capture(ANALYTICS_EVENT.UPDATE_AVAILABLE, {
      result: 'available',
      status: 'available',
      version: info.version,
    })
    capture(ANALYTICS_EVENT.UPDATE_CHECK_COMPLETED, {
      result: 'available',
      status: 'available',
      version: info.version,
      surface: 'updater',
    })
    if (!electronUpdaterInstall) {
      setUpdaterState({
        status: 'available',
        version: info.version,
        progressPct: null,
        errorMessage: null,
        downloadUrl: MANUAL_DOWNLOAD_URL,
        ...getReleaseMetadata(info),
      })
      return
    }
    setUpdaterState({
      status: 'downloading',
      version: info.version,
      progressPct: null,
      errorMessage: null,
      downloadUrl: null,
      ...getReleaseMetadata(info),
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    setUpdaterState({
      status: 'downloading',
      progressPct: boundedDownloadProgressPercent(progress.percent),
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    capture(ANALYTICS_EVENT.UPDATE_DOWNLOADED, {
      result: 'downloaded',
      status: 'downloaded',
      version: info.version,
    })
    setUpdaterState({
      status: 'downloaded',
      version: info.version,
      progressPct: 100,
      errorMessage: null,
      ...getReleaseMetadata(info),
    })
  })

  autoUpdater.on('update-not-available', () => {
    _updateAvailable = null
    capture(ANALYTICS_EVENT.UPDATE_CHECK_COMPLETED, {
      result: 'not_available',
      status: 'not_available',
      surface: 'updater',
    })
    setUpdaterState({
      status: 'not-available',
      version: app.getVersion(),
      progressPct: null,
      errorMessage: null,
      releaseName: null,
      releaseNotesText: null,
      releaseDate: null,
      packageType: support.packageType,
      supported: support.supported,
      supportMessage: support.message,
      downloadUrl: null,
    })
  })

  autoUpdater.on('error', (err) => {
    _updateAvailable = null
    capture(ANALYTICS_EVENT.UPDATE_ERROR, {
      failure_kind: classifyFailureKind(err),
      result: 'error',
      surface: 'updater',
    })
    capture(ANALYTICS_EVENT.UPDATE_CHECK_COMPLETED, {
      failure_kind: classifyFailureKind(err),
      result: 'error',
      status: 'error',
      surface: 'updater',
    })
    captureException(err, {
      tags: {
        process_type: 'main',
        reason: 'update_error',
      },
    })
    setUpdaterState({
      status: 'error',
      errorMessage: normalizeUpdaterErrorMessage(err.message),
      progressPct: null,
      releaseName: null,
      releaseNotesText: null,
      releaseDate: null,
      downloadUrl: null,
    })
  })

  setTimeout(() => {
    console.log('[updater] checking for updates…')
    autoUpdater.checkForUpdates().catch(() => { /* silent */ })
  }, 10_000)
}
