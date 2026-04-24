export interface RemoteUpdateDescriptor {
  version: string
  releaseName: string | null
  releaseNotesText: string | null
  releaseDate: string | null
  installUrl: string
  installFileName: string
  manualUrl: string | null
  releasePageUrl: string | null
}

interface ParsedVersion {
  major: number
  minor: number
  patch: number
  prerelease: string | null
}

function parseVersion(value: string): ParsedVersion | null {
  const trimmed = value.trim().replace(/^v/i, '')
  const match = trimmed.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  }
}

export function compareReleaseVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === null) return 1
  if (b.prerelease === null) return -1
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true, sensitivity: 'base' })
}

export function isRemoteUpdateDescriptor(value: unknown): value is RemoteUpdateDescriptor {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.version === 'string' &&
    typeof candidate.installUrl === 'string' &&
    typeof candidate.installFileName === 'string' &&
    (candidate.releaseName === null || typeof candidate.releaseName === 'string') &&
    (candidate.releaseNotesText === null || typeof candidate.releaseNotesText === 'string') &&
    (candidate.releaseDate === null || typeof candidate.releaseDate === 'string') &&
    (candidate.manualUrl === null || typeof candidate.manualUrl === 'string') &&
    (candidate.releasePageUrl === null || typeof candidate.releasePageUrl === 'string')
  )
}

export function buildRemoteUpdateFeedUrl(baseUrl: string, platform: NodeJS.Platform, arch: string): string {
  const url = new URL(baseUrl)
  url.searchParams.set('platform', platform)
  url.searchParams.set('arch', arch)
  return url.toString()
}

export function normalizeRemoteUpdaterError(message: string): string {
  const compact = message.replace(/\s+/g, ' ').trim()

  if (/releases\.atom|github\.com\/[^/]+\/[^/]+\/releases/i.test(compact)) {
    return 'Daylens could not reach the old GitHub updater feed. Download the latest build from the Daylens site, then future updates will use the public Daylens update service.'
  }

  if (/HTTP 401|HTTP 403|authentication token|rate limit/i.test(compact)) {
    return 'Daylens could not reach the update service right now. The release feed rejected the request.'
  }

  if (/HTTP 404|Not Found/i.test(compact)) {
    return 'Daylens could not find a public update feed for this build.'
  }

  if (/HTTP 5\d\d/i.test(compact)) {
    return 'Daylens could not reach the update service right now. Try again in a moment.'
  }

  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|timed out|network/i.test(compact)) {
    return 'Daylens could not reach the update service. Check your connection and try again.'
  }

  if (compact.length === 0) {
    return 'Daylens could not check for updates right now.'
  }

  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact
}
