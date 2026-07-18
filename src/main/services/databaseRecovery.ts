import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

// Corruption recovery for the main SQLite database. Kept free of electron
// imports so the whole open/quarantine/restore path is exercisable by the
// hermetic test suite; src/main/index.ts owns the dialog that asks the person
// what to do and maps their answer onto recoverCorruptDatabase().

const DB_SIDECAR_SUFFIXES = ['', '-wal', '-shm'] as const

export type DatabaseIntegrityResult =
  | { ok: true }
  | { ok: false; reason: string }

export type CorruptDatabaseChoice = 'restore' | 'fresh'

export interface CorruptDatabaseRecovery {
  outcome: 'restored' | 'fresh'
  quarantinedTo: string | null
}

// A missing or empty file is fine — initDb() creates a fresh database there.
export function checkDatabaseIntegrity(dbPath: string): DatabaseIntegrityResult {
  let stats: fs.Stats
  try {
    stats = fs.statSync(dbPath)
  } catch {
    return { ok: true }
  }
  if (stats.size === 0) return { ok: true }

  let db: Database.Database | null = null
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const rows = db.pragma('integrity_check') as { integrity_check: string }[]
    const failures = rows
      .map((row) => row.integrity_check)
      .filter((message) => message !== 'ok')
    if (failures.length > 0) {
      return { ok: false, reason: failures.slice(0, 3).join('; ') }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  } finally {
    db?.close()
  }
}

// Move the corrupt database (and its WAL/SHM sidecars) aside instead of
// deleting it — the person may want to attempt manual recovery later, and a
// rename cannot half-fail the way an in-place overwrite can.
export function quarantineCorruptDatabase(dbPath: string, now = new Date()): string | null {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const basePath = `${dbPath}.corrupt-${stamp}`
  let quarantinePath = basePath
  let attempt = 1
  while (DB_SIDECAR_SUFFIXES.some((suffix) => fs.existsSync(`${quarantinePath}${suffix}`))) {
    quarantinePath = `${basePath}-${attempt}`
    attempt += 1
  }
  let quarantined = false
  for (const suffix of DB_SIDECAR_SUFFIXES) {
    const source = `${dbPath}${suffix}`
    if (!fs.existsSync(source)) continue
    fs.renameSync(source, `${quarantinePath}${suffix}`)
    quarantined = true
  }
  return quarantined ? quarantinePath : null
}

function restoreDatabaseFromBackup(backupDir: string, dbPath: string): boolean {
  const dbFileName = path.basename(dbPath)
  const backupDbPath = path.join(backupDir, dbFileName)
  if (!fs.existsSync(backupDbPath)) return false
  for (const suffix of DB_SIDECAR_SUFFIXES) {
    const source = `${backupDbPath}${suffix}`
    if (!fs.existsSync(source)) continue
    fs.copyFileSync(source, `${dbPath}${suffix}`)
  }
  return true
}

// Quarantine the corrupt file, then either restore the backup copy or leave
// the slot empty for initDb() to create a fresh database. A restored copy is
// integrity-checked too: a corrupt backup falls back to the fresh path rather
// than reproducing the crash loop the person just chose to escape.
export function recoverCorruptDatabase(
  dbPath: string,
  backupDir: string | null,
  choice: CorruptDatabaseChoice,
): CorruptDatabaseRecovery {
  const quarantinedTo = quarantineCorruptDatabase(dbPath)

  if (choice === 'restore' && backupDir && restoreDatabaseFromBackup(backupDir, dbPath)) {
    const restored = checkDatabaseIntegrity(dbPath)
    if (restored.ok) {
      return { outcome: 'restored', quarantinedTo }
    }
    quarantineCorruptDatabase(dbPath)
  }

  return { outcome: 'fresh', quarantinedTo }
}
