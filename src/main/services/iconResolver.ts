import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type Database from 'better-sqlite3'
import { app, nativeImage } from 'electron'
import type { AppSettings, IconRequest, ResolvedIconPayload, ResolvedIconSource } from '@shared/types'
import { getLatestAppIdentity, type AppIdentityRecord } from '../core/inference/appIdentityRegistry'
import { resolveCanonicalApp } from '../lib/appIdentity'
import { getDb } from './database'
import { getSettings } from './settings'

const execAsync = promisify(execFile)

const ICON_FETCH_TIMEOUT_MS = 5_000
const ICON_FETCH_HEADERS = {
  'user-agent': 'Mozilla/5.0 Daylens/1.0',
  accept: 'image/*,text/html;q=0.9,*/*;q=0.2',
}
const WEBSITE_ICON_TTL_MS = 7 * 24 * 60 * 60 * 1_000
const NEGATIVE_ICON_TTL_MS = 15 * 60 * 1_000
const ICON_CACHE_VERSION = 5
const MAC_BUNDLE_THUMBNAIL_SIZE = 256

type SettingsSnapshot = Pick<AppSettings, 'allowThirdPartyWebsiteIconFallback'>

interface BrowserEntry {
  name: string
  bundleId: string
  historyPath: string
  type: 'chromium' | 'firefox'
}

interface DiskCacheEntry {
  version: number
  cacheKey: string
  source: ResolvedIconSource
  mime: string | null
  bytesBase64: string | null
  storedAt: number
  expiresAt: number | null
}

export interface IconResolverOverrides {
  cacheDir?: string
  db?: Database.Database
  platform?: NodeJS.Platform
  settings?: SettingsSnapshot
  getFileIconDataUrl?: (filePath: string) => Promise<string | null>
  getMacBundleIconDataUrl?: (bundlePath: string) => Promise<string | null>
  getBrowserEntries?: () => BrowserEntry[]
  getAppIdentity?: (query: { appInstanceId?: string | null; bundleId?: string | null; canonicalAppId?: string | null; appName?: string | null }) => AppIdentityRecord | null
  getSiteIconFromBrowserCache?: (domain: string, pageUrl?: string | null) => Promise<string | null>
  fetchSiteIconFromOrigin?: (origin: string) => Promise<string | null>
  fetchSiteFallbackIcon?: (domain: string) => Promise<string | null>
  resolveMacBundlePath?: (bundleId?: string | null, appName?: string | null) => Promise<string | null>
  resolveWindowsUwpIcon?: (packageFamily: string) => Promise<string | null>
}

type AppIconRequest = Extract<IconRequest, { kind: 'app' }>
type SiteIconRequest = Extract<IconRequest, { kind: 'site' }>
type ArtifactIconRequest = Extract<IconRequest, { kind: 'artifact' }>

const memoryCache = new Map<string, DiskCacheEntry>()
const inFlightResolutions = new Map<string, Promise<ResolvedIconPayload>>()

function iconLog(message: string, details?: Record<string, unknown>): void {
  if (details) {
    console.log(`[icons] ${message}`, details)
    return
  }
  console.log(`[icons] ${message}`)
}

function iconWarn(message: string, details?: Record<string, unknown>): void {
  if (details) {
    console.warn(`[icons] ${message}`, details)
    return
  }
  console.warn(`[icons] ${message}`)
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function iconFingerprint(dataUrl: string | null | undefined): string | null {
  if (!dataUrl) return null
  const parsed = parseDataUrl(dataUrl)
  const bytes = parsed?.bytes ?? Buffer.from(dataUrl, 'utf8')
  return createHash('sha1').update(bytes).digest('hex').slice(0, 12)
}

function describeRequest(request: IconRequest): Record<string, unknown> {
  if (request.kind === 'app') {
    return {
      kind: 'app',
      appInstanceId: request.appInstanceId ?? null,
      bundleId: request.bundleId ?? null,
      canonicalAppId: request.canonicalAppId ?? null,
      appName: request.appName ?? null,
    }
  }

  if (request.kind === 'site') {
    return {
      kind: 'site',
      domain: request.domain ?? null,
      pageUrl: request.pageUrl ?? null,
    }
  }

  return {
    kind: 'artifact',
    artifactType: request.artifactType,
    canonicalAppId: request.canonicalAppId ?? null,
    ownerBundleId: request.ownerBundleId ?? null,
    ownerAppName: request.ownerAppName ?? null,
    ownerAppInstanceId: request.ownerAppInstanceId ?? null,
    path: request.path ?? null,
    host: request.host ?? null,
    url: request.url ?? null,
    title: request.title ?? null,
  }
}

function describeIdentity(identity: AppIdentityRecord | null): Record<string, unknown> {
  return {
    appInstanceId: identity?.appInstanceId ?? null,
    bundleId: identity?.bundleId ?? null,
    canonicalAppId: identity?.canonicalAppId ?? null,
    displayName: identity?.displayName ?? null,
    executablePath: identity?.metadata.executablePath ?? null,
    uwpPackageFamily: identity?.metadata.uwpPackageFamily ?? null,
    hasActiveWindowIcon: Boolean(identity?.metadata.activeWindowIconBase64),
  }
}

function normalizeCacheKeyPart(value: string | null | undefined): string {
  return (value ?? '').trim()
}

function normalizeCanonicalAppId(
  canonicalAppId: string | null | undefined,
  bundleId: string | null | undefined,
  appName: string | null | undefined,
): string | null {
  const trimmed = canonicalAppId?.trim() || null
  if (trimmed && !looksLikeAbsolutePath(trimmed) && !trimmed.toLowerCase().includes('.app/')) {
    return trimmed
  }

  const derived = resolveCanonicalApp(
    bundleId ?? trimmed ?? '',
    appName ?? trimmed ?? bundleId ?? 'Unknown app',
  )
  return derived.canonicalAppId ?? null
}

function buildIconCacheKey(request: IconRequest): string {
  if (request.kind === 'app') {
    return [
      'app',
      normalizeCacheKeyPart(request.appInstanceId),
      normalizeCacheKeyPart(request.bundleId),
      normalizeCacheKeyPart(request.canonicalAppId),
      normalizeCacheKeyPart(request.appName).toLowerCase(),
    ].join('::')
  }

  if (request.kind === 'site') {
    const domain = normalizeDomain(request.domain, request.pageUrl)
    return [
      'site',
      domain,
      normalizeCacheKeyPart(request.pageUrl),
    ].join('::')
  }

  return [
    'artifact',
    normalizeCacheKeyPart(request.artifactType),
    normalizeCacheKeyPart(request.canonicalAppId),
    normalizeCacheKeyPart(request.ownerAppInstanceId),
    normalizeCacheKeyPart(request.ownerBundleId),
    normalizeCacheKeyPart(request.ownerAppName).toLowerCase(),
    normalizeCacheKeyPart(request.path),
    normalizeDomain(request.host, request.url),
    normalizeCacheKeyPart(request.url),
    normalizeCacheKeyPart(request.title).toLowerCase(),
  ].join('::')
}

function cacheTtlFor(request: IconRequest, payload: ResolvedIconPayload): number | null {
  if (!payload.dataUrl) return NEGATIVE_ICON_TTL_MS
  return request.kind === 'site' ? WEBSITE_ICON_TTL_MS : null
}

function dataUrlFromBuffer(buffer: Buffer, mime: string): string {
  return `data:${mime};base64,${buffer.toString('base64')}`
}

function parseDataUrl(dataUrl: string): { mime: string; bytes: Buffer } | null {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl.trim())
  if (!match) return null
  try {
    return {
      mime: match[1].trim().toLowerCase(),
      bytes: Buffer.from(match[2], 'base64'),
    }
  } catch {
    return null
  }
}

function inferImageMime(url: string, contentType: string | null): string | null {
  const normalizedType = contentType?.split(';')[0].trim().toLowerCase() ?? null
  if (normalizedType?.startsWith('image/')) return normalizedType

  const pathname = (() => {
    try {
      return new URL(url).pathname.toLowerCase()
    } catch {
      return url.toLowerCase()
    }
  })()

  if (pathname.endsWith('.svg')) return 'image/svg+xml'
  if (pathname.endsWith('.ico')) return 'image/x-icon'
  if (pathname.endsWith('.png')) return 'image/png'
  if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg'
  if (pathname.endsWith('.webp')) return 'image/webp'
  return null
}

function detectImageMime(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x00, 0x00, 0x01, 0x00]))) {
    return 'image/x-icon'
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return 'image/jpeg'
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp'
  }
  const head = buffer.subarray(0, Math.min(buffer.length, 256)).toString('utf8').trimStart().toLowerCase()
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'image/svg+xml'
  return null
}

function normalizeDomain(domain?: string | null, pageUrl?: string | null): string {
  const explicit = domain?.trim().toLowerCase()
  if (explicit) return explicit
  if (!pageUrl) return ''
  try {
    return new URL(pageUrl).hostname.trim().toLowerCase()
  } catch {
    return ''
  }
}

function normalizePossibleDataUrl(value: string | null | undefined, fallbackMime = 'image/png'): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('data:')) return trimmed
  try {
    const bytes = Buffer.from(trimmed, 'base64')
    if (bytes.length === 0) return null
    return dataUrlFromBuffer(bytes, fallbackMime)
  } catch {
    return null
  }
}

function looksLikeAbsolutePath(value: string | null | undefined): boolean {
  if (!value) return false
  return path.isAbsolute(value) || path.win32.isAbsolute(value)
}

function firstDefined<T>(...values: Array<T | null | undefined>): T | null {
  for (const value of values) {
    if (value !== null && value !== undefined) return value
  }
  return null
}

function normalizeMacAppPath(candidate: string): string {
  const trimmed = candidate.trim()
  if (trimmed.toLowerCase().endsWith('.app')) return trimmed
  const appSegmentIndex = trimmed.toLowerCase().indexOf('.app/')
  if (appSegmentIndex >= 0) {
    return trimmed.slice(0, appSegmentIndex + 4)
  }
  return trimmed
}

function escapeMdfindValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

async function firstMdfindResult(query: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync('mdfind', [query])
    const resolved = stdout
      .trim()
      .split('\n')
      .map((candidate) => candidate.trim())
      .filter(Boolean)
      .find((candidate) => candidate.endsWith('.app'))
    return resolved ?? null
  } catch {
    return null
  }
}

async function defaultResolveMacAppBundlePath(bundleId?: string | null, appName?: string | null): Promise<string | null> {
  const trimmedBundleId = bundleId?.trim() ?? ''
  if (trimmedBundleId.startsWith('/')) {
    return normalizeMacAppPath(trimmedBundleId)
  }

  if (trimmedBundleId) {
    const byBundleId = await firstMdfindResult(
      `kMDItemCFBundleIdentifier == "${escapeMdfindValue(trimmedBundleId)}"c`,
    )
    if (byBundleId) return byBundleId
  }

  const identity = resolveCanonicalApp(trimmedBundleId, appName?.trim() || trimmedBundleId)
  const appNameCandidates = Array.from(new Set([
    appName?.trim() ?? '',
    identity.displayName.trim(),
    path.basename(trimmedBundleId).replace(/\.app$/i, '').trim(),
  ].filter(Boolean)))

  for (const candidate of appNameCandidates) {
    const fsName = `${candidate.replace(/\.app$/i, '')}.app`
    const byFsName = await firstMdfindResult(`kMDItemFSName == "${escapeMdfindValue(fsName)}"c`)
    if (byFsName) return byFsName

    const byDisplayName = await firstMdfindResult(
      `kMDItemDisplayName == "${escapeMdfindValue(candidate.replace(/\.app$/i, ''))}"c`,
    )
    if (byDisplayName) return byDisplayName
  }

  return null
}

async function readMacBundleInfo(bundlePath: string): Promise<Record<string, unknown> | null> {
  const plistPath = path.join(bundlePath, 'Contents', 'Info.plist')
  try {
    const { stdout } = await execAsync('plutil', ['-convert', 'json', '-o', '-', plistPath])
    const parsed = JSON.parse(stdout) as Record<string, unknown>
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
}

function macBundleIconNames(info: Record<string, unknown> | null): string[] {
  if (!info) return []

  const names = new Set<string>()
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) names.add(value.trim())
  }

  add(info.CFBundleIconFile)
  add(info.CFBundleIconName)

  const icons = info.CFBundleIcons
  if (icons && typeof icons === 'object') {
    const primary = (icons as Record<string, unknown>).CFBundlePrimaryIcon
    if (primary && typeof primary === 'object') {
      const primaryRecord = primary as Record<string, unknown>
      add(primaryRecord.CFBundleIconName)
      for (const entry of stringArray(primaryRecord.CFBundleIconFiles)) {
        names.add(entry)
      }
    }
  }

  return Array.from(names)
}

function macBundleIconPathCandidates(bundlePath: string, info: Record<string, unknown> | null): string[] {
  const resourcesDir = path.join(bundlePath, 'Contents', 'Resources')
  const candidates = new Set<string>()

  for (const name of macBundleIconNames(info)) {
    const ext = path.extname(name)
    if (ext) {
      candidates.add(path.join(resourcesDir, name))
    } else {
      candidates.add(path.join(resourcesDir, `${name}.icns`))
      candidates.add(path.join(resourcesDir, `${name}.png`))
    }
  }

  try {
    const resourceEntries = fs.readdirSync(resourcesDir)
    for (const name of macBundleIconNames(info)) {
      const lowerName = name.toLowerCase()
      for (const entry of resourceEntries) {
        const lowerEntry = entry.toLowerCase()
        if (lowerEntry === lowerName || lowerEntry === `${lowerName}.icns` || lowerEntry === `${lowerName}.png`) {
          candidates.add(path.join(resourcesDir, entry))
        }
      }
    }
  } catch {
    // Ignore unreadable resources dir and fall through.
  }

  return Array.from(candidates)
}

async function defaultGetMacBundleIconDataUrl(bundlePath: string): Promise<string | null> {
  const normalizedBundlePath = normalizeMacAppPath(bundlePath)
  iconLog('mac bundle icon: trying thumbnail', {
    bundlePath: normalizedBundlePath,
  })

  try {
    const thumbnail = await nativeImage.createThumbnailFromPath(normalizedBundlePath, {
      width: MAC_BUNDLE_THUMBNAIL_SIZE,
      height: MAC_BUNDLE_THUMBNAIL_SIZE,
    })
    if (!thumbnail.isEmpty()) {
      const dataUrl = thumbnail.toDataURL()
      iconLog('mac bundle icon: thumbnail hit', {
        bundlePath: normalizedBundlePath,
        fingerprint: iconFingerprint(dataUrl),
      })
      return dataUrl
    }
    iconWarn('mac bundle icon: thumbnail was empty', {
      bundlePath: normalizedBundlePath,
    })
  } catch (error) {
    iconWarn('mac bundle icon: thumbnail failed', {
      bundlePath: normalizedBundlePath,
      error: describeError(error),
    })
  }

  const info = await readMacBundleInfo(normalizedBundlePath)
  const candidates = macBundleIconPathCandidates(normalizedBundlePath, info)
  iconLog('mac bundle icon: trying bundle resources', {
    bundlePath: normalizedBundlePath,
    candidates,
  })

  for (const candidate of candidates) {
    try {
      const directDataUrl = await imageFileToDataUrl(candidate)
      if (directDataUrl) {
        iconLog('mac bundle icon: bundle resource hit', {
          bundlePath: normalizedBundlePath,
          candidate,
          fingerprint: iconFingerprint(directDataUrl),
        })
        return directDataUrl
      }
    } catch (error) {
      iconWarn('mac bundle icon: direct resource read failed', {
        bundlePath: normalizedBundlePath,
        candidate,
        error: describeError(error),
      })
    }

    try {
      const convertedDataUrl = await convertImageWithSipsToDataUrl(candidate)
      if (convertedDataUrl) {
        iconLog('mac bundle icon: sips conversion hit', {
          bundlePath: normalizedBundlePath,
          candidate,
          fingerprint: iconFingerprint(convertedDataUrl),
        })
        return convertedDataUrl
      }
    } catch (error) {
      iconWarn('mac bundle icon: sips conversion failed', {
        bundlePath: normalizedBundlePath,
        candidate,
        error: describeError(error),
      })
    }
  }

  iconWarn('mac bundle icon: no local icon source resolved', {
    bundlePath: normalizedBundlePath,
  })
  return null
}

async function defaultGetFileIconDataUrl(filePath: string): Promise<string | null> {
  try {
    const icon = await app.getFileIcon(filePath, { size: 'normal' })
    return icon.isEmpty() ? null : icon.toDataURL()
  } catch {
    return null
  }
}

function escapePowerShellValue(value: string): string {
  return value.replace(/'/g, "''")
}

function manifestLogoCandidates(manifestText: string): string[] {
  const candidates = new Set<string>()
  const attributePatterns = [
    /Square44x44Logo="([^"]+)"/gi,
    /Square150x150Logo="([^"]+)"/gi,
    /Square310x310Logo="([^"]+)"/gi,
    /Wide310x150Logo="([^"]+)"/gi,
    /\bLogo="([^"]+)"/gi,
  ]

  for (const pattern of attributePatterns) {
    for (const match of manifestText.matchAll(pattern)) {
      const value = match[1]?.trim()
      if (value) candidates.add(value)
    }
  }

  for (const match of manifestText.matchAll(/<Logo>([^<]+)<\/Logo>/gi)) {
    const value = match[1]?.trim()
    if (value) candidates.add(value)
  }

  return Array.from(candidates)
}

function appxAssetScore(fileName: string): number {
  const lower = fileName.toLowerCase()
  const target = /targetsize-(\d+)/.exec(lower)
  if (target) return Number(target[1]) * 100
  const scale = /scale-(\d+)/.exec(lower)
  if (scale) return Number(scale[1]) * 10
  return lower.includes('contrast-') ? 5 : 1
}

function resolveAppxAssetPath(installLocation: string, assetReference: string): string | null {
  const normalized = assetReference.replace(/^[/\\]+/, '').replace(/\//g, path.sep)
  const exactPath = path.join(installLocation, normalized)
  if (fs.existsSync(exactPath)) return exactPath

  const directory = path.dirname(exactPath)
  if (!fs.existsSync(directory)) return null

  const extension = path.extname(exactPath)
  const baseName = path.basename(exactPath, extension).toLowerCase()
  const matches = fs.readdirSync(directory)
    .filter((entry) => entry.toLowerCase().startsWith(baseName))
    .filter((entry) => path.extname(entry).toLowerCase() === extension.toLowerCase())
    .sort((left, right) => appxAssetScore(right) - appxAssetScore(left))

  return matches[0] ? path.join(directory, matches[0]) : null
}

async function imageFileToDataUrl(filePath: string): Promise<string | null> {
  try {
    const bytes = await fs.promises.readFile(filePath)
    const mime = detectImageMime(bytes) ?? inferImageMime(filePath, null)
    return mime ? dataUrlFromBuffer(bytes, mime) : null
  } catch {
    return null
  }
}

async function convertImageWithSipsToDataUrl(filePath: string): Promise<string | null> {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'daylens-icon-'))
  const outputPath = path.join(tempDir, 'icon.png')
  try {
    await execAsync('sips', ['-s', 'format', 'png', filePath, '--out', outputPath])
    return imageFileToDataUrl(outputPath)
  } finally {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Best-effort temp cleanup only.
    }
  }
}

async function defaultResolveWindowsUwpIcon(packageFamily: string): Promise<string | null> {
  if (!packageFamily.trim()) return null

  const script = [
    `$pkg = Get-AppxPackage -PackageFamilyName '${escapePowerShellValue(packageFamily.trim())}' | Select-Object -First 1`,
    "if ($pkg) { $pkg.InstallLocation }",
  ].join('; ')

  const executables = ['powershell.exe', 'pwsh.exe']
  let installLocation: string | null = null

  for (const executable of executables) {
    try {
      const { stdout } = await execAsync(executable, ['-NoProfile', '-NonInteractive', '-Command', script])
      const candidate = stdout.trim().split(/\r?\n/).find(Boolean)?.trim()
      if (candidate) {
        installLocation = candidate
        break
      }
    } catch {
      // Try the next PowerShell executable.
    }
  }

  if (!installLocation) return null

  try {
    const manifestPath = path.join(installLocation, 'AppxManifest.xml')
    const manifest = await fs.promises.readFile(manifestPath, 'utf8')
    for (const candidate of manifestLogoCandidates(manifest)) {
      const resolvedAsset = resolveAppxAssetPath(installLocation, candidate)
      if (!resolvedAsset) continue
      const dataUrl = await imageFileToDataUrl(resolvedAsset)
      if (dataUrl) return dataUrl
    }
  } catch {
    return null
  }

  return null
}

function candidateSiteOrigins(domain: string, pageUrl?: string | null): string[] {
  const origins = new Set<string>()

  if (pageUrl) {
    try {
      const parsed = new URL(pageUrl)
      origins.add(parsed.origin)
    } catch {
      // Ignore malformed page URLs and fall back to the host.
    }
  }

  if (domain) {
    origins.add(`https://${domain}`)
  }

  return Array.from(origins)
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ICON_FETCH_TIMEOUT_MS)

  try {
    return await fetch(url, {
      redirect: 'follow',
      headers: ICON_FETCH_HEADERS,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

async function fetchImageDataUrl(url: string): Promise<string | null> {
  try {
    const response = await fetchWithTimeout(url)
    if (!response.ok) return null

    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length === 0 || bytes.length > 1_500_000) return null
    const mime = detectImageMime(bytes) ?? inferImageMime(url, response.headers.get('content-type'))
    if (!mime) {
      iconWarn('resolve site icon: unsupported image payload', {
        url,
        contentType: response.headers.get('content-type'),
        byteLength: bytes.length,
      })
      return null
    }
    return dataUrlFromBuffer(bytes, mime)
  } catch {
    return null
  }
}

function iconHrefCandidatesFromHtml(html: string, baseUrl: string): string[] {
  const urls = new Set<string>()

  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0]
    const rel = tag.match(/\brel=["']([^"']+)["']/i)?.[1]?.toLowerCase() ?? ''
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1]?.trim() ?? ''

    if (!href || (!rel.includes('icon') && !rel.includes('apple-touch-icon'))) continue

    try {
      urls.add(new URL(href, baseUrl).toString())
    } catch {
      // Ignore malformed hrefs.
    }
  }

  return Array.from(urls)
}

function manifestHrefCandidatesFromHtml(html: string, baseUrl: string): string[] {
  const urls = new Set<string>()

  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0]
    const rel = tag.match(/\brel=["']([^"']+)["']/i)?.[1]?.toLowerCase() ?? ''
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1]?.trim() ?? ''

    if (!href || !rel.split(/\s+/).includes('manifest')) continue

    try {
      urls.add(new URL(href, baseUrl).toString())
    } catch {
      // Ignore malformed manifest hrefs.
    }
  }

  return Array.from(urls)
}

function iconSizeScore(sizes: string | null | undefined): number {
  const normalized = sizes?.trim().toLowerCase() ?? ''
  if (!normalized) return 0
  if (normalized.includes('any')) return 1_000_000

  let best = 0
  for (const token of normalized.split(/\s+/)) {
    const match = /^(\d+)x(\d+)$/.exec(token)
    if (!match) continue
    best = Math.max(best, Number(match[1]) * Number(match[2]))
  }
  return best
}

function iconTypeScore(type: string | null | undefined, src: string): number {
  const normalized = type?.trim().toLowerCase() || inferImageMime(src, null) || ''
  if (normalized === 'image/png') return 40
  if (normalized === 'image/svg+xml') return 35
  if (normalized === 'image/webp') return 30
  if (normalized === 'image/x-icon' || normalized === 'image/vnd.microsoft.icon') return 25
  if (normalized.startsWith('image/')) return 20
  return 0
}

function manifestIconCandidatesFromJson(manifestText: string, manifestUrl: string): string[] {
  try {
    const parsed = JSON.parse(manifestText) as { icons?: Array<Record<string, unknown>> }
    const icons = Array.isArray(parsed?.icons) ? parsed.icons : []

    return icons
      .map((icon) => {
        const src = typeof icon.src === 'string' ? icon.src.trim() : ''
        if (!src) return null

        try {
          const absoluteUrl = new URL(src, manifestUrl).toString()
          return {
            url: absoluteUrl,
            sizeScore: iconSizeScore(typeof icon.sizes === 'string' ? icon.sizes : null),
            typeScore: iconTypeScore(typeof icon.type === 'string' ? icon.type : null, absoluteUrl),
          }
        } catch {
          return null
        }
      })
      .filter((entry): entry is { url: string; sizeScore: number; typeScore: number } => Boolean(entry))
      .sort((left, right) => {
        if (right.sizeScore !== left.sizeScore) return right.sizeScore - left.sizeScore
        return right.typeScore - left.typeScore
      })
      .map((entry) => entry.url)
  } catch {
    return []
  }
}

async function defaultFetchSiteIconFromOrigin(origin: string): Promise<string | null> {
  const directCandidates = [
    new URL('/favicon.ico', origin).toString(),
    new URL('/favicon.svg', origin).toString(),
    new URL('/apple-touch-icon.png', origin).toString(),
    new URL('/apple-touch-icon-precomposed.png', origin).toString(),
  ]

  for (const candidate of directCandidates) {
    iconLog('resolve site icon: trying direct origin candidate', {
      origin,
      candidate,
    })
    const dataUrl = await fetchImageDataUrl(candidate)
    if (dataUrl) {
      iconLog('resolve site icon: direct origin hit', {
        origin,
        candidate,
        fingerprint: iconFingerprint(dataUrl),
      })
      return dataUrl
    }
  }

  try {
    const response = await fetchWithTimeout(origin)
    if (!response.ok) return null
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (!contentType.includes('text/html')) return null

    const html = await response.text()
    for (const candidate of iconHrefCandidatesFromHtml(html, origin)) {
      iconLog('resolve site icon: trying html icon candidate', {
        origin,
        candidate,
      })
      const dataUrl = await fetchImageDataUrl(candidate)
      if (dataUrl) {
        iconLog('resolve site icon: html icon hit', {
          origin,
          candidate,
          fingerprint: iconFingerprint(dataUrl),
        })
        return dataUrl
      }
    }

    for (const manifestUrl of manifestHrefCandidatesFromHtml(html, origin)) {
      iconLog('resolve site icon: trying manifest', {
        origin,
        manifestUrl,
      })
      try {
        const manifestResponse = await fetchWithTimeout(manifestUrl)
        if (!manifestResponse.ok) continue
        const manifestText = await manifestResponse.text()
        for (const candidate of manifestIconCandidatesFromJson(manifestText, manifestUrl)) {
          iconLog('resolve site icon: trying manifest icon candidate', {
            origin,
            manifestUrl,
            candidate,
          })
          const dataUrl = await fetchImageDataUrl(candidate)
          if (dataUrl) {
            iconLog('resolve site icon: manifest icon hit', {
              origin,
              manifestUrl,
              candidate,
              fingerprint: iconFingerprint(dataUrl),
            })
            return dataUrl
          }
        }
      } catch (error) {
        iconWarn('resolve site icon: manifest fetch failed', {
          origin,
          manifestUrl,
          error: describeError(error),
        })
      }
    }
  } catch {
    return null
  }

  return null
}

async function defaultFetchSiteFallbackIcon(domain: string): Promise<string | null> {
  return fetchImageDataUrl(`https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`)
}

function sqliteTempBase(sourcePath: string): string {
  return path.join(
    os.tmpdir(),
    `daylens_icon_${Date.now()}_${createHash('sha1').update(sourcePath).digest('hex').slice(0, 8)}`,
  )
}

function copySqliteDatabase(sourcePath: string): { dbPath: string; cleanup: () => void } | null {
  if (!fs.existsSync(sourcePath)) return null
  const tempBase = sqliteTempBase(sourcePath)
  const tempDb = `${tempBase}.sqlite`
  const tempWal = `${tempBase}.sqlite-wal`
  const tempShm = `${tempBase}.sqlite-shm`

  try {
    fs.copyFileSync(sourcePath, tempDb)
    if (fs.existsSync(`${sourcePath}-wal`)) fs.copyFileSync(`${sourcePath}-wal`, tempWal)
    if (fs.existsSync(`${sourcePath}-shm`)) fs.copyFileSync(`${sourcePath}-shm`, tempShm)
  } catch {
    return null
  }

  return {
    dbPath: tempDb,
    cleanup: () => {
      for (const filePath of [tempDb, tempWal, tempShm]) {
        try {
          fs.rmSync(filePath, { force: true })
        } catch {
          // Ignore temp cleanup failures.
        }
      }
    },
  }
}

function chromiumUrlPatterns(domain: string, pageUrl?: string | null): { exact: string | null; likes: string[] } {
  const likes = Array.from(new Set([
    `https://${domain}/%`,
    `http://${domain}/%`,
    `https://www.${domain}/%`,
    `http://www.${domain}/%`,
  ]))
  return {
    exact: pageUrl?.trim() || null,
    likes,
  }
}

function tableNames(db: Database.Database): Set<string> {
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

async function openReadonlySqlite(dbPath: string): Promise<Database.Database | null> {
  try {
    const sqliteModule = await import('better-sqlite3')
    const Sqlite = sqliteModule.default
    return new Sqlite(dbPath, { readonly: true })
  } catch {
    return null
  }
}

async function readChromiumFaviconDataUrl(faviconsPath: string, domain: string, pageUrl?: string | null): Promise<string | null> {
  const copied = copySqliteDatabase(faviconsPath)
  if (!copied) {
    iconWarn('resolve site icon: chromium favicon cache unavailable', {
      faviconsPath,
      domain,
      pageUrl: pageUrl ?? null,
    })
    return null
  }

  let faviconDb: Database.Database | null = null
  try {
    faviconDb = await openReadonlySqlite(copied.dbPath)
    if (!faviconDb) return null
    const { exact, likes } = chromiumUrlPatterns(domain, pageUrl)
    const where = [
      ...(exact ? ['im.page_url = ?'] : []),
      ...likes.map(() => 'im.page_url LIKE ?'),
    ].join(' OR ')
    const orderPrefix = exact ? 'CASE WHEN im.page_url = ? THEN 0 ELSE 1 END,' : ''
    const statement = faviconDb.prepare(`
      SELECT fb.image_data AS image_data
      FROM icon_mapping im
      JOIN favicon_bitmaps fb ON fb.icon_id = im.icon_id
      WHERE ${where}
      ORDER BY ${orderPrefix} fb.width DESC, length(fb.image_data) DESC
      LIMIT 1
    `)
    const params = [
      ...(exact ? [exact] : []),
      ...likes,
      ...(exact ? [exact] : []),
    ]
    const row = statement.get(...params) as { image_data: Buffer } | undefined
    if (!row?.image_data || row.image_data.length === 0) return null
    const mime = detectImageMime(row.image_data) ?? 'image/png'
    iconLog('resolve site icon: chromium favicon cache hit', {
      faviconsPath,
      domain,
      pageUrl: pageUrl ?? null,
      mime,
    })
    return dataUrlFromBuffer(row.image_data, mime)
  } catch {
    return null
  } finally {
    try {
      faviconDb?.close()
    } catch {
      // Ignore readonly sqlite close failures.
    }
    copied.cleanup()
  }
}

async function readFirefoxFaviconDataUrl(dbPath: string, domain: string, pageUrl?: string | null): Promise<string | null> {
  const copied = copySqliteDatabase(dbPath)
  if (!copied) return null

  let faviconDb: Database.Database | null = null
  try {
    faviconDb = await openReadonlySqlite(copied.dbPath)
    if (!faviconDb) return null
    const tables = tableNames(faviconDb)
    if (!tables.has('moz_pages_w_icons') || !tables.has('moz_icons_to_pages') || !tables.has('moz_icons')) {
      return null
    }

    const { exact, likes } = chromiumUrlPatterns(domain, pageUrl)
    const where = [
      ...(exact ? ['p.page_url = ?'] : []),
      ...likes.map(() => 'p.page_url LIKE ?'),
    ].join(' OR ')
    const orderPrefix = exact ? 'CASE WHEN p.page_url = ? THEN 0 ELSE 1 END,' : ''
    const statement = faviconDb.prepare(`
      SELECT i.data AS image_data, i.mime_type AS mime_type
      FROM moz_pages_w_icons p
      JOIN moz_icons_to_pages ip ON ip.page_id = p.id
      JOIN moz_icons i ON i.id = ip.icon_id
      WHERE ${where}
      ORDER BY ${orderPrefix} i.width DESC, length(i.data) DESC
      LIMIT 1
    `)
    const params = [
      ...(exact ? [exact] : []),
      ...likes,
      ...(exact ? [exact] : []),
    ]
    const row = statement.get(...params) as { image_data: Buffer; mime_type: string | null } | undefined
    if (!row?.image_data || row.image_data.length === 0) return null
    const mime = row.mime_type?.trim() || detectImageMime(row.image_data) || 'image/png'
    iconLog('resolve site icon: firefox favicon cache hit', {
      dbPath,
      domain,
      pageUrl: pageUrl ?? null,
      mime,
    })
    return dataUrlFromBuffer(row.image_data, mime)
  } catch {
    return null
  } finally {
    try {
      faviconDb?.close()
    } catch {
      // Ignore readonly sqlite close failures.
    }
    copied.cleanup()
  }
}

async function defaultGetSiteIconFromBrowserCache(domain: string, pageUrl: string | null | undefined, entries: BrowserEntry[]): Promise<string | null> {
  for (const browser of entries) {
    iconLog('resolve site icon: checking browser cache', {
      browserName: browser.name,
      browserBundleId: browser.bundleId,
      browserType: browser.type,
      historyPath: browser.historyPath,
      domain,
      pageUrl: pageUrl ?? null,
    })
    if (browser.type === 'chromium') {
      const faviconsPath = path.join(path.dirname(browser.historyPath), 'Favicons')
      const dataUrl = await readChromiumFaviconDataUrl(faviconsPath, domain, pageUrl)
      if (dataUrl) return dataUrl
      continue
    }

    const firefoxProfileDir = path.dirname(browser.historyPath)
    const firefoxCandidates = [
      path.join(firefoxProfileDir, 'favicons.sqlite'),
      browser.historyPath,
    ]

    for (const candidate of firefoxCandidates) {
      const dataUrl = await readFirefoxFaviconDataUrl(candidate, domain, pageUrl)
      if (dataUrl) return dataUrl
    }
  }

  return null
}

async function loadBrowserEntries(): Promise<BrowserEntry[]> {
  const browserModule = await import('./browser')
  return browserModule.getBrowserEntries()
}

function iconCacheDirectory(overrides?: IconResolverOverrides): string {
  const directory = overrides?.cacheDir ?? path.join(app.getPath('userData'), 'icon-cache')
  fs.mkdirSync(directory, { recursive: true })
  return directory
}

function cacheFilePath(cacheKey: string, overrides?: IconResolverOverrides): string {
  const fileName = `${createHash('sha1').update(cacheKey).digest('hex')}.json`
  return path.join(iconCacheDirectory(overrides), fileName)
}

function isExpired(entry: DiskCacheEntry): boolean {
  return entry.expiresAt !== null && entry.expiresAt <= Date.now()
}

function entryToPayload(entry: DiskCacheEntry): ResolvedIconPayload {
  return {
    cacheKey: entry.cacheKey,
    source: entry.source,
    dataUrl: entry.bytesBase64 && entry.mime ? `data:${entry.mime};base64,${entry.bytesBase64}` : null,
  }
}

function persistCacheEntry(entry: DiskCacheEntry, overrides?: IconResolverOverrides): void {
  memoryCache.set(entry.cacheKey, entry)
  try {
    fs.writeFileSync(cacheFilePath(entry.cacheKey, overrides), JSON.stringify(entry), 'utf8')
    iconLog('cache store', {
      cacheKey: entry.cacheKey,
      source: entry.source,
      version: entry.version,
      hasData: Boolean(entry.bytesBase64),
      expiresAt: entry.expiresAt,
    })
  } catch {
    // Best-effort cache persistence only.
  }
}

function removeCacheEntry(cacheKey: string, overrides?: IconResolverOverrides): void {
  memoryCache.delete(cacheKey)
  try {
    fs.rmSync(cacheFilePath(cacheKey, overrides), { force: true })
    iconLog('cache remove', { cacheKey })
  } catch {
    // Best-effort cache cleanup only.
  }
}

function loadCacheEntry(cacheKey: string, overrides?: IconResolverOverrides): DiskCacheEntry | null {
  const inMemory = memoryCache.get(cacheKey)
  if (inMemory) {
    if (isExpired(inMemory)) {
      iconWarn('cache expired (memory)', { cacheKey, source: inMemory.source })
      removeCacheEntry(cacheKey, overrides)
      return null
    }
    iconLog('cache hit (memory)', { cacheKey, source: inMemory.source })
    return inMemory
  }

  try {
    const raw = fs.readFileSync(cacheFilePath(cacheKey, overrides), 'utf8')
    const parsed = JSON.parse(raw) as DiskCacheEntry
    if (parsed?.version !== ICON_CACHE_VERSION || parsed.cacheKey !== cacheKey) {
      iconWarn('cache invalidated', {
        cacheKey,
        expectedVersion: ICON_CACHE_VERSION,
        foundVersion: parsed?.version ?? null,
      })
      removeCacheEntry(cacheKey, overrides)
      return null
    }
    if (isExpired(parsed)) {
      iconWarn('cache expired (disk)', { cacheKey, source: parsed.source })
      removeCacheEntry(cacheKey, overrides)
      return null
    }
    memoryCache.set(cacheKey, parsed)
    iconLog('cache hit (disk)', { cacheKey, source: parsed.source })
    return parsed
  } catch {
    return null
  }
}

function payloadToEntry(
  payload: ResolvedIconPayload,
  ttlMs: number | null,
): DiskCacheEntry {
  const parsed = payload.dataUrl ? parseDataUrl(payload.dataUrl) : null
  const now = Date.now()
  return {
    version: ICON_CACHE_VERSION,
    cacheKey: payload.cacheKey,
    source: payload.source,
    mime: parsed?.mime ?? null,
    bytesBase64: parsed?.bytes.toString('base64') ?? null,
    storedAt: now,
    expiresAt: ttlMs === null ? null : now + ttlMs,
  }
}

function settingsSnapshot(overrides?: IconResolverOverrides): SettingsSnapshot {
  return overrides?.settings ?? {
    allowThirdPartyWebsiteIconFallback: getSettings().allowThirdPartyWebsiteIconFallback ?? true,
  }
}

function currentPlatform(overrides?: IconResolverOverrides): NodeJS.Platform {
  return overrides?.platform ?? process.platform
}

function getAppIdentityRecord(
  query: { appInstanceId?: string | null; bundleId?: string | null; canonicalAppId?: string | null; appName?: string | null },
  overrides?: IconResolverOverrides,
): AppIdentityRecord | null {
  if (overrides?.getAppIdentity) {
    return overrides.getAppIdentity(query)
  }
  try {
    return getLatestAppIdentity(overrides?.db ?? getDb(), query)
  } catch {
    return null
  }
}

function normalizeAppRequest(request: AppIconRequest): AppIconRequest {
  const bundleId = request.bundleId?.trim() || null
  const appName = request.appName?.trim() || null
  return {
    kind: 'app',
    appInstanceId: request.appInstanceId?.trim() || null,
    bundleId,
    appName,
    canonicalAppId: normalizeCanonicalAppId(request.canonicalAppId, bundleId, appName),
  }
}

function normalizeSiteRequest(request: SiteIconRequest): SiteIconRequest {
  return {
    kind: 'site',
    domain: normalizeDomain(request.domain, request.pageUrl) || null,
    pageUrl: request.pageUrl?.trim() || null,
  }
}

function normalizeArtifactRequest(request: ArtifactIconRequest): ArtifactIconRequest {
  const ownerBundleId = request.ownerBundleId?.trim() || null
  const ownerAppName = request.ownerAppName?.trim() || null
  return {
    kind: 'artifact',
    artifactType: request.artifactType,
    canonicalAppId: normalizeCanonicalAppId(
      request.canonicalAppId,
      ownerBundleId,
      ownerAppName ?? request.title?.trim() ?? null,
    ),
    ownerBundleId,
    ownerAppName,
    ownerAppInstanceId: request.ownerAppInstanceId?.trim() || null,
    path: request.path?.trim() || null,
    url: request.url?.trim() || null,
    host: normalizeDomain(request.host, request.url) || null,
    title: request.title?.trim() || null,
  }
}

async function resolveAppIconUncached(
  request: AppIconRequest,
  overrides?: IconResolverOverrides,
): Promise<Omit<ResolvedIconPayload, 'cacheKey'>> {
  const normalized = normalizeAppRequest(request)
  const derivedIdentity = resolveCanonicalApp(
    normalized.bundleId ?? normalized.canonicalAppId ?? '',
    normalized.appName ?? normalized.canonicalAppId ?? normalized.bundleId ?? 'Unknown app',
  )
  const identity = getAppIdentityRecord({
    appInstanceId: normalized.appInstanceId,
    bundleId: normalized.bundleId,
    canonicalAppId: normalized.canonicalAppId ?? derivedIdentity.canonicalAppId,
    appName: normalized.appName ?? derivedIdentity.displayName,
  }, overrides)
  iconLog('resolve app icon start', {
    request: describeRequest(normalized),
    identity: describeIdentity(identity),
  })

  const activeWindowIcon = normalizePossibleDataUrl(
    identity?.metadata.activeWindowIconBase64 ?? null,
    identity?.metadata.activeWindowIconMime ?? 'image/png',
  )
  if (activeWindowIcon) {
    iconLog('resolve app icon: active-window hit', {
      request: describeRequest(normalized),
      fingerprint: iconFingerprint(activeWindowIcon),
    })
    return { dataUrl: activeWindowIcon, source: 'active_window' }
  }

  const fileIcon = overrides?.getFileIconDataUrl ?? defaultGetFileIconDataUrl
  const platform = currentPlatform(overrides)
  const pathCandidates: Array<{ filePath: string; source: ResolvedIconSource }> = []
  const pathCandidateKeys = new Set<string>()
  const addPathCandidate = (candidatePath: string | null | undefined, source: ResolvedIconSource) => {
    const trimmed = candidatePath?.trim()
    if (!trimmed) return

    const normalizedPath = platform === 'darwin' && (trimmed.toLowerCase().endsWith('.app') || trimmed.toLowerCase().includes('.app/'))
      ? normalizeMacAppPath(trimmed)
      : trimmed
    const dedupeKey = (platform === 'win32' || platform === 'darwin')
      ? normalizedPath.toLowerCase()
      : normalizedPath
    if (pathCandidateKeys.has(dedupeKey)) return
    pathCandidateKeys.add(dedupeKey)

    if (platform === 'darwin' && (trimmed.toLowerCase().endsWith('.app') || trimmed.toLowerCase().includes('.app/'))) {
      pathCandidates.push({ filePath: normalizedPath, source: 'app_bundle' })
      return
    }

    pathCandidates.push({ filePath: normalizedPath, source })
  }

  if (looksLikeAbsolutePath(normalized.bundleId)) {
    addPathCandidate(normalized.bundleId!, 'app_file')
  }

  if (looksLikeAbsolutePath(identity?.metadata.executablePath)) {
    addPathCandidate(identity!.metadata.executablePath!, 'app_file')
  }

  if (platform === 'darwin') {
    const bundlePath = await (overrides?.resolveMacBundlePath ?? defaultResolveMacAppBundlePath)(
      normalized.bundleId ?? identity?.bundleId ?? null,
      normalized.appName ?? identity?.displayName ?? null,
    )
    if (bundlePath) {
      addPathCandidate(bundlePath, 'app_bundle')
    }
  }

  iconLog('resolve app icon: path candidates ready', {
    request: describeRequest(normalized),
    platform,
    pathCandidates,
  })

  const seenPaths = new Set<string>()
  for (const candidate of pathCandidates) {
    const normalizedPath = candidate.filePath.trim()
    if (!normalizedPath || seenPaths.has(normalizedPath)) continue
    seenPaths.add(normalizedPath)

    if (platform === 'darwin' && candidate.source === 'app_bundle') {
      iconLog('resolve app icon: trying app bundle', {
        request: describeRequest(normalized),
        filePath: normalizedPath,
      })
      const bundleDataUrl = await (overrides?.getMacBundleIconDataUrl ?? defaultGetMacBundleIconDataUrl)(normalizedPath)
      if (bundleDataUrl) {
        iconLog('resolve app icon: app bundle hit', {
          request: describeRequest(normalized),
          filePath: normalizedPath,
          fingerprint: iconFingerprint(bundleDataUrl),
        })
        return { dataUrl: bundleDataUrl, source: 'app_bundle' }
      }
      iconWarn('resolve app icon: app bundle miss', {
        request: describeRequest(normalized),
        filePath: normalizedPath,
      })
    }

    iconLog('resolve app icon: trying file icon', {
      request: describeRequest(normalized),
      filePath: normalizedPath,
      source: candidate.source,
    })
    const dataUrl = await fileIcon(normalizedPath)
    if (dataUrl) {
      iconLog('resolve app icon: file icon hit', {
        request: describeRequest(normalized),
        filePath: normalizedPath,
        source: candidate.source,
        fingerprint: iconFingerprint(dataUrl),
      })
      return { dataUrl, source: candidate.source }
    }
  }

  if (platform === 'win32') {
    const packageFamily = firstDefined(
      identity?.metadata.uwpPackageFamily,
      normalized.bundleId && !looksLikeAbsolutePath(normalized.bundleId) ? normalized.bundleId : null,
    )
    if (packageFamily) {
      const dataUrl = await (overrides?.resolveWindowsUwpIcon ?? defaultResolveWindowsUwpIcon)(packageFamily)
      if (dataUrl) {
        iconLog('resolve app icon: uwp manifest hit', {
          request: describeRequest(normalized),
          packageFamily,
          fingerprint: iconFingerprint(dataUrl),
        })
        return { dataUrl, source: 'uwp_manifest' }
      }
    }
  }

  iconWarn('resolve app icon: miss', {
    request: describeRequest(normalized),
  })
  return { dataUrl: null, source: 'miss' }
}

async function resolveSiteIconUncached(
  request: SiteIconRequest,
  overrides?: IconResolverOverrides,
): Promise<Omit<ResolvedIconPayload, 'cacheKey'>> {
  const normalized = normalizeSiteRequest(request)
  iconLog('resolve site icon start', {
    request: describeRequest(normalized),
  })
  if (!normalized.domain) {
    iconWarn('resolve site icon: missing domain', {
      request: describeRequest(normalized),
    })
    return { dataUrl: null, source: 'miss' }
  }

  const browserCache = overrides?.getSiteIconFromBrowserCache
  const browserCacheIcon = browserCache
    ? await browserCache(normalized.domain, normalized.pageUrl)
    : await defaultGetSiteIconFromBrowserCache(
        normalized.domain,
        normalized.pageUrl,
        overrides?.getBrowserEntries ? overrides.getBrowserEntries() : await loadBrowserEntries(),
      )
  if (browserCacheIcon) {
    iconLog('resolve site icon: browser cache hit', {
      request: describeRequest(normalized),
      fingerprint: iconFingerprint(browserCacheIcon),
    })
    return { dataUrl: browserCacheIcon, source: 'browser_cache' }
  }

  const fetchOrigin = overrides?.fetchSiteIconFromOrigin ?? defaultFetchSiteIconFromOrigin
  for (const origin of candidateSiteOrigins(normalized.domain, normalized.pageUrl)) {
    const dataUrl = await fetchOrigin(origin)
    if (dataUrl) {
      iconLog('resolve site icon: origin hit', {
        request: describeRequest(normalized),
        origin,
        fingerprint: iconFingerprint(dataUrl),
      })
      return { dataUrl, source: 'site_origin' }
    }
  }

  if (settingsSnapshot(overrides).allowThirdPartyWebsiteIconFallback) {
    const dataUrl = await (overrides?.fetchSiteFallbackIcon ?? defaultFetchSiteFallbackIcon)(normalized.domain)
    if (dataUrl) {
      iconLog('resolve site icon: third-party fallback hit', {
        request: describeRequest(normalized),
        fingerprint: iconFingerprint(dataUrl),
      })
      return { dataUrl, source: 'site_fallback' }
    }
  }

  iconWarn('resolve site icon: miss', {
    request: describeRequest(normalized),
  })
  return { dataUrl: null, source: 'miss' }
}

async function resolveArtifactIconUncached(
  request: ArtifactIconRequest,
  overrides?: IconResolverOverrides,
): Promise<Omit<ResolvedIconPayload, 'cacheKey'>> {
  const normalized = normalizeArtifactRequest(request)
  iconLog('resolve artifact icon start', {
    request: describeRequest(normalized),
  })
  const fileIcon = overrides?.getFileIconDataUrl ?? defaultGetFileIconDataUrl

  if (normalized.path) {
    const dataUrl = await fileIcon(normalized.path)
    if (dataUrl) {
      iconLog('resolve artifact icon: file hit', {
        request: describeRequest(normalized),
        fingerprint: iconFingerprint(dataUrl),
      })
      return { dataUrl, source: 'artifact_file' }
    }
  }

  if (normalized.artifactType === 'page' || normalized.artifactType === 'domain' || normalized.host) {
    return resolveSiteIconUncached({
      kind: 'site',
      domain: normalized.host,
      pageUrl: normalized.url,
    }, overrides)
  }

  if (normalized.canonicalAppId || normalized.ownerBundleId || normalized.ownerAppInstanceId || normalized.ownerAppName) {
    const appIcon = await resolveAppIconUncached({
      kind: 'app',
      appInstanceId: normalized.ownerAppInstanceId,
      bundleId: normalized.ownerBundleId,
      canonicalAppId: normalized.canonicalAppId,
      appName: normalized.ownerAppName ?? (!normalized.ownerBundleId && !normalized.ownerAppInstanceId ? normalized.title : null),
    }, overrides)
    if (appIcon.dataUrl) {
      iconLog('resolve artifact icon: inherited app hit', {
        request: describeRequest(normalized),
        fingerprint: iconFingerprint(appIcon.dataUrl),
      })
      return { dataUrl: appIcon.dataUrl, source: 'artifact_app' }
    }
  }

  iconWarn('resolve artifact icon: miss', {
    request: describeRequest(normalized),
  })
  return { dataUrl: null, source: 'miss' }
}

export function resetIconResolverCache(): void {
  memoryCache.clear()
  inFlightResolutions.clear()
}

function normalizeIconRequest(request: IconRequest): IconRequest {
  if (request.kind === 'app') return normalizeAppRequest(request)
  if (request.kind === 'site') return normalizeSiteRequest(request)
  return normalizeArtifactRequest(request)
}

export async function resolveIcon(
  request: IconRequest,
  overrides?: IconResolverOverrides,
): Promise<ResolvedIconPayload> {
  const normalizedRequest = normalizeIconRequest(request)
  const cacheKey = buildIconCacheKey(normalizedRequest)
  iconLog('resolve icon request', {
    cacheKey,
    request: describeRequest(normalizedRequest),
  })
  const cached = loadCacheEntry(cacheKey, overrides)
  if (cached) {
    iconLog('resolve icon: served from cache', {
      cacheKey,
      source: cached.source,
      hasData: Boolean(cached.bytesBase64),
    })
    return entryToPayload(cached)
  }

  const inFlight = inFlightResolutions.get(cacheKey)
  if (inFlight) {
    iconLog('resolve icon: awaiting in-flight resolution', { cacheKey })
    return inFlight
  }

  const resolutionPromise = (async () => {
    let resolved: Omit<ResolvedIconPayload, 'cacheKey'>
    if (normalizedRequest.kind === 'app') {
      resolved = await resolveAppIconUncached(normalizedRequest, overrides)
    } else if (normalizedRequest.kind === 'site') {
      resolved = await resolveSiteIconUncached(normalizedRequest, overrides)
    } else {
      resolved = await resolveArtifactIconUncached(normalizedRequest, overrides)
    }

    const payload: ResolvedIconPayload = {
      cacheKey,
      dataUrl: resolved.dataUrl,
      source: resolved.source,
    }
    iconLog('resolve icon complete', {
      cacheKey,
      source: payload.source,
      hasData: Boolean(payload.dataUrl),
      fingerprint: iconFingerprint(payload.dataUrl),
    })
    persistCacheEntry(payloadToEntry(payload, cacheTtlFor(normalizedRequest, payload)), overrides)
    return payload
  })()

  inFlightResolutions.set(cacheKey, resolutionPromise)
  try {
    return await resolutionPromise
  } finally {
    if (inFlightResolutions.get(cacheKey) === resolutionPromise) {
      inFlightResolutions.delete(cacheKey)
    }
  }
}
