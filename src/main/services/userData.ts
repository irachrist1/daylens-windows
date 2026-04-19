import fs from 'node:fs'
import path from 'node:path'

export const APP_DISPLAY_NAME = 'Daylens'
export const MAC_USER_DATA_DIR = 'Daylens Desktop'
export const LEGACY_USER_DATA_DIRS = ['Daylens', 'DaylensWindows']
const PRIMARY_DB_FILES = ['daylens.sqlite', 'daylens.sqlite-wal']
const LEGACY_DB_FILES = ['daylens.db']
const IMPORTANT_STATE_FILES = [
  'config.json',
  ...PRIMARY_DB_FILES,
  ...LEGACY_DB_FILES,
  'artifacts',
  'generated-reports',
  'tracker-owner.json',
]

export interface UserDataDirectoryState {
  path: string
  exists: boolean
  hasConfig: boolean
  onboardingComplete: boolean
  hasTimelineDatabase: boolean
  databaseBytes: number
  lastActivityMs: number
  hasMeaningfulData: boolean
}

export interface BackupManifest {
  createdAt: string
  sourceVersion: string
  snapshot: UserDataDirectoryState
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function statIfPresent(targetPath: string): fs.Stats | null {
  try {
    return fs.statSync(targetPath)
  } catch {
    return null
  }
}

function directoryStateRank(state: UserDataDirectoryState, preferredPath: string): number {
  const preferredBonus = state.path === preferredPath ? 1 : 0
  return (
    (state.hasMeaningfulData ? 1_000_000 : 0)
    + (state.hasTimelineDatabase ? 100_000 : 0)
    + (state.onboardingComplete ? 10_000 : 0)
    + preferredBonus
  )
}

export function getUserDataDirNames(platform: NodeJS.Platform): { preferredDirName: string; legacyDirNames: string[] } {
  if (platform === 'darwin') {
    return {
      preferredDirName: MAC_USER_DATA_DIR,
      legacyDirNames: LEGACY_USER_DATA_DIRS,
    }
  }

  return {
    preferredDirName: APP_DISPLAY_NAME,
    legacyDirNames: ['DaylensWindows'],
  }
}

export function describeUserDataDirectory(dirPath: string): UserDataDirectoryState {
  const directoryStats = statIfPresent(dirPath)
  if (!directoryStats?.isDirectory()) {
    return {
      path: dirPath,
      exists: false,
      hasConfig: false,
      onboardingComplete: false,
      hasTimelineDatabase: false,
      databaseBytes: 0,
      lastActivityMs: 0,
      hasMeaningfulData: false,
    }
  }

  const configPath = path.join(dirPath, 'config.json')
  const config = readJsonFile(configPath)
  const onboardingComplete = Boolean(config?.onboardingComplete)
  let databaseBytes = 0
  let lastActivityMs = 0
  let hasTimelineDatabase = false

  for (const filename of [...PRIMARY_DB_FILES, ...LEGACY_DB_FILES]) {
    const stats = statIfPresent(path.join(dirPath, filename))
    if (!stats?.isFile()) continue
    databaseBytes += stats.size
    lastActivityMs = Math.max(lastActivityMs, stats.mtimeMs)
    if (stats.size > 0) {
      hasTimelineDatabase = true
    }
  }

  for (const entry of IMPORTANT_STATE_FILES) {
    const stats = statIfPresent(path.join(dirPath, entry))
    if (!stats) continue
    lastActivityMs = Math.max(lastActivityMs, stats.mtimeMs)
  }

  return {
    path: dirPath,
    exists: true,
    hasConfig: config !== null,
    onboardingComplete,
    hasTimelineDatabase,
    databaseBytes,
    lastActivityMs,
    hasMeaningfulData: onboardingComplete || hasTimelineDatabase || databaseBytes > 0,
  }
}

export function chooseUserDataPath(appDataPath: string, platform: NodeJS.Platform): string {
  const { preferredDirName, legacyDirNames } = getUserDataDirNames(platform)
  const preferredPath = path.join(appDataPath, preferredDirName)
  const candidatePaths = [
    preferredPath,
    ...legacyDirNames.map((dirName) => path.join(appDataPath, dirName)),
  ]

  const uniqueCandidatePaths = candidatePaths.filter((candidate, index) => candidatePaths.indexOf(candidate) === index)
  const states = uniqueCandidatePaths.map((candidate) => describeUserDataDirectory(candidate))
  const meaningfulStates = states.filter((state) => state.hasMeaningfulData)

  if (meaningfulStates.length === 0) {
    return preferredPath
  }

  meaningfulStates.sort((left, right) => {
    const rankDiff = directoryStateRank(right, preferredPath) - directoryStateRank(left, preferredPath)
    if (rankDiff !== 0) return rankDiff
    if (right.lastActivityMs !== left.lastActivityMs) return right.lastActivityMs - left.lastActivityMs
    if (right.databaseBytes !== left.databaseBytes) return right.databaseBytes - left.databaseBytes
    return 0
  })

  return meaningfulStates[0]?.path ?? preferredPath
}

export function createBackupManifest(sourceDir: string, sourceVersion: string): BackupManifest {
  return {
    createdAt: new Date().toISOString(),
    sourceVersion,
    snapshot: describeUserDataDirectory(sourceDir),
  }
}

export function readBackupManifest(backupDir: string): BackupManifest | null {
  const manifestPath = path.join(backupDir, 'backup-manifest.json')
  const manifest = readJsonFile(manifestPath)
  if (!manifest) return null

  const snapshot = manifest.snapshot
  if (!snapshot || typeof snapshot !== 'object') return null

  const candidate = snapshot as Record<string, unknown>
  return {
    createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : '',
    sourceVersion: typeof manifest.sourceVersion === 'string' ? manifest.sourceVersion : '',
    snapshot: {
      path: backupDir,
      exists: true,
      hasConfig: Boolean(candidate.hasConfig),
      onboardingComplete: Boolean(candidate.onboardingComplete),
      hasTimelineDatabase: Boolean(candidate.hasTimelineDatabase),
      databaseBytes: typeof candidate.databaseBytes === 'number' ? candidate.databaseBytes : 0,
      lastActivityMs: typeof candidate.lastActivityMs === 'number' ? candidate.lastActivityMs : 0,
      hasMeaningfulData: Boolean(candidate.hasMeaningfulData),
    },
  }
}

export function isHealthyUserDataState(dirPath: string): boolean {
  const state = describeUserDataDirectory(dirPath)
  return state.onboardingComplete && state.hasTimelineDatabase
}

export function selectLatestRestorableBackup(backupRoot: string): string | null {
  let entries: string[] = []
  try {
    entries = fs.readdirSync(backupRoot).sort().reverse()
  } catch {
    return null
  }

  for (const entry of entries) {
    const backupDir = path.join(backupRoot, entry)
    const manifest = readBackupManifest(backupDir)
    if (manifest?.snapshot.onboardingComplete && manifest.snapshot.hasTimelineDatabase) {
      return backupDir
    }

    const snapshot = describeUserDataDirectory(backupDir)
    if (snapshot.onboardingComplete && snapshot.hasTimelineDatabase) {
      return backupDir
    }
  }

  return null
}
