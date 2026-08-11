// Harness context: stages an isolated userData directory holding a copy of
// the real database (or a fixture), points the electron stub at it, and opens
// the same initDb() the app uses. Every CLI command runs through here so the
// data path is byte-identical to what the renderer sees over IPC.
//
// Layout under ~/.daylens-harness (outside the repo, never synced, never live):
//   pristine/daylens.sqlite   coherent backup of the production DB + config.json
//   pristine/meta.json        source path, snapshot time, source mtime
//   work/                     the userData dir commands actually run against
//
// `work` is writable on purpose — analyze/wrapped/chat persist exactly like the
// app. `daylens db reset` restores it from pristine; `daylens db snapshot`
// refreshes pristine from the live DB. Nothing here ever opens the live DB
// with a writable handle.

import { app } from 'electron'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const HARNESS_ROOT = process.env.DAYLENS_CLI_ROOT
  ?? path.join(os.homedir(), '.daylens-harness')
const PRISTINE_DIR = path.join(HARNESS_ROOT, 'pristine')
const WORK_DIR = path.join(HARNESS_ROOT, 'work')

interface SnapshotMeta {
  sourceUserData: string
  sourceDbPath: string
  snapshotAt: string
  sourceDbMtimeMs: number
}

function productionAppDataPath(): string {
  const home = os.homedir()
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support')
  if (process.platform === 'win32') return process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
  return process.env.XDG_CONFIG_HOME ?? path.join(home, '.config')
}

async function discoverProductionUserData(): Promise<string> {
  const { chooseUserDataPath } = await import('../src/main/services/userData')
  return process.env.DAYLENS_REAL_USER_DATA
    ?? chooseUserDataPath(productionAppDataPath(), process.platform)
}

export function readSnapshotMeta(): SnapshotMeta | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(PRISTINE_DIR, 'meta.json'), 'utf8')) as SnapshotMeta
  } catch {
    return null
  }
}

/** Coherent backup of the live DB (WAL-safe, read-only source handle). */
export async function createSnapshot(): Promise<SnapshotMeta> {
  const sourceUserData = await discoverProductionUserData()
  const sourceDbPath = path.join(sourceUserData, 'daylens.sqlite')
  if (!fs.existsSync(sourceDbPath)) {
    throw new Error(`Production DB not found at ${sourceDbPath}. Open Daylens once, then retry.`)
  }
  fs.mkdirSync(PRISTINE_DIR, { recursive: true })
  const targetDb = path.join(PRISTINE_DIR, 'daylens.sqlite')
  const tmpTarget = `${targetDb}.tmp`
  const source = new Database(sourceDbPath, { readonly: true, fileMustExist: true })
  try {
    await source.backup(tmpTarget)
  } finally {
    source.close()
  }
  fs.renameSync(tmpTarget, targetDb)
  const configSource = path.join(sourceUserData, 'config.json')
  if (fs.existsSync(configSource)) {
    fs.copyFileSync(configSource, path.join(PRISTINE_DIR, 'config.json'))
  }
  const meta: SnapshotMeta = {
    sourceUserData,
    sourceDbPath,
    snapshotAt: new Date().toISOString(),
    sourceDbMtimeMs: fs.statSync(sourceDbPath).mtimeMs,
  }
  fs.writeFileSync(path.join(PRISTINE_DIR, 'meta.json'), JSON.stringify(meta, null, 2))
  resetWorkFromPristine()
  return meta
}

export function hasSnapshot(): boolean {
  return fs.existsSync(path.join(PRISTINE_DIR, 'daylens.sqlite'))
}

export function resetWorkFromPristine(): void {
  if (!hasSnapshot()) throw new Error('No snapshot. Run: daylens db snapshot')
  fs.rmSync(WORK_DIR, { recursive: true, force: true })
  fs.mkdirSync(WORK_DIR, { recursive: true })
  fs.copyFileSync(path.join(PRISTINE_DIR, 'daylens.sqlite'), path.join(WORK_DIR, 'daylens.sqlite'))
  const config = path.join(PRISTINE_DIR, 'config.json')
  if (fs.existsSync(config)) fs.copyFileSync(config, path.join(WORK_DIR, 'config.json'))
}

export interface OpenOptions {
  /** Re-stage work/ from pristine before opening. */
  fresh?: boolean
  /** Use an explicit DB file (e.g. a fixture) instead of the work snapshot. */
  dbPath?: string
}

export interface HarnessContext {
  userData: string
  dbPath: string
  db: import('better-sqlite3').Database
  snapshotMeta: SnapshotMeta | null
}

let opened: HarnessContext | null = null

/**
 * Stage the userData dir, point Electron's userData at it, and open the DB
 * through the app's own initDb() (migrations, pragmas, FTS — identical to
 * production startup).
 */
export async function openHarness(options: OpenOptions = {}): Promise<HarnessContext> {
  if (opened) return opened
  let userData: string
  if (options.dbPath) {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-cli-fixture-'))
    fs.copyFileSync(path.resolve(options.dbPath), path.join(userData, 'daylens.sqlite'))
  } else {
    if (!hasSnapshot()) {
      process.stderr.write('[harness] no snapshot found; creating one from the live DB…\n')
      await createSnapshot()
    } else if (options.fresh || !fs.existsSync(path.join(WORK_DIR, 'daylens.sqlite'))) {
      resetWorkFromPristine()
    }
    userData = WORK_DIR
  }
  app.setPath('userData', userData)
  const { initDb, getDb } = await import('../src/main/services/database')
  const { initSettings } = await import('../src/main/services/settings')
  await initSettings()
  initDb()
  // Same on-demand enrichment backfill the app registers at startup: wrapping
  // or analyzing a historical day collects that day's git/calendar signals
  // into the work copy. Skipped for --db fixtures — a fixture day must stay
  // exactly what the fixture says it is.
  if (!options.dbPath) {
    const { ensureExternalSignalsForDate, registerExternalSignalBackfill } = await import('../src/main/services/externalSignals')
    registerExternalSignalBackfill((date) => ensureExternalSignalsForDate(getDb(), date))
  }
  opened = {
    userData,
    dbPath: path.join(userData, 'daylens.sqlite'),
    db: getDb(),
    snapshotMeta: readSnapshotMeta(),
  }
  return opened
}

export function snapshotAgeDescription(meta: SnapshotMeta | null): string {
  if (!meta) return 'no snapshot metadata'
  const ageMs = Date.now() - Date.parse(meta.snapshotAt)
  const hours = Math.floor(ageMs / 3_600_000)
  if (hours < 1) return 'snapshot < 1h old'
  if (hours < 48) return `snapshot ${hours}h old`
  return `snapshot ${Math.floor(hours / 24)}d old — consider: daylens db snapshot`
}
