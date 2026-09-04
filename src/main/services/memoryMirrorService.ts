// Wiring for the readable memory mirror: settings + app paths + the timeline
// payload, joined to memoryMirror.ts's pure renderer.
//
// Kept separate from both halves so the renderer stays testable without
// Electron and the builder stays testable without settings. Every entry point
// here is best-effort: a filesystem the app cannot write to must never fail a
// day analysis, so failures are logged and swallowed.
import { app, shell } from 'electron'
import type Database from 'better-sqlite3'
import path from 'node:path'
import { getSettings } from './settings'
import { materializeTimelineDayProjection } from '../core/query/projections'
import { buildDayMemoryInput } from './memoryMirrorBuild'
import { listMemoryIndexCandidateDates } from './memoryIndex'
import {
  codexMemoryRoot,
  deleteDayMemory,
  listDayMemories,
  memoryFileName,
  memoryMirrorRoot,
  rebuildMemoryIndex,
  writeDayMemory,
  type WriteDayMemoryOptions,
  type WriteDayMemoryResult,
} from './memoryMirror'

/** Null in a harness with no Electron app object, which is the signal to skip. */
function userDataDir(): string | null {
  try {
    return app?.getPath('userData') ?? null
  } catch {
    return null
  }
}

export function mirrorRootPath(): string | null {
  const dir = userDataDir()
  return dir ? memoryMirrorRoot(dir) : null
}

function resolveRoots(): WriteDayMemoryOptions | null {
  const root = mirrorRootPath()
  if (!root) return null
  let settings
  try {
    settings = getSettings()
  } catch {
    return null
  }
  if (settings.memoryMirrorEnabled === false) return null
  return {
    mirrorRoot: root,
    codexRoot: settings.memoryMirrorCodexExport ? codexMemoryRoot() : null,
  }
}

/** Writes one day's memory file from the corrected timeline payload. Safe to
 *  call repeatedly: an unchanged day rewrites nothing. */
export async function syncDayMemoryMirror(
  db: Database.Database,
  dateStr: string,
): Promise<WriteDayMemoryResult | null> {
  const roots = resolveRoots()
  if (!roots) return null
  try {
    // No live session: the mirror only records settled activity, and a live
    // block is filtered out by the builder anyway.
    const payload = materializeTimelineDayProjection(db, dateStr, null)
    const input = buildDayMemoryInput(payload, { narrative: null })
    const result = await writeDayMemory(input, roots)
    // Only touch the index when the day actually changed. Rebuilding it reads
    // every day file, which is not something to do on a no-op write.
    if (result.outcome === 'written') await rebuildMemoryIndex(roots)
    return result
  } catch (error) {
    console.warn('[memoryMirror] failed to write', dateStr, error)
    return null
  }
}

/** One bounded backfill step, newest day first.
 *
 *  Without this, the mirror only ever contains days analyzed after the feature
 *  shipped: a person with two years of history opens the folder, finds it
 *  nearly empty, and concludes the memory is not really theirs. Returns the
 *  number of days written, and null when the mirror is disabled. */
export async function backfillMemoryMirrorStep(
  db: Database.Database,
  options: { daysPerStep?: number; maxDays?: number } = {},
): Promise<{ written: number; done: boolean } | null> {
  const roots = resolveRoots()
  if (!roots) return null
  const daysPerStep = options.daysPerStep ?? 5
  const maxDays = options.maxDays ?? 730

  try {
    const existing = new Set(await listDayMemories(roots.mirrorRoot))
    // Same day enumeration the memory index backfill uses, so the two agree on
    // what counts as a day with evidence (foreground sessions, focus events, or
    // browsing alone).
    const candidates = listMemoryIndexCandidateDates(db, maxDays)

    let written = 0
    for (const date of candidates) {
      if (existing.has(date)) continue
      const payload = materializeTimelineDayProjection(db, date, null)
      const result = await writeDayMemory(buildDayMemoryInput(payload, { narrative: null }), roots)
      if (result.outcome === 'written') written += 1
      if (written >= daysPerStep) {
        if (written > 0) await rebuildMemoryIndex(roots)
        return { written, done: false }
      }
    }
    if (written > 0) await rebuildMemoryIndex(roots)
    return { written, done: true }
  } catch (error) {
    console.warn('[memoryMirror] backfill step failed', error)
    return { written: 0, done: true }
  }
}

let backfillTimer: ReturnType<typeof setTimeout> | null = null

/** Background backfill: a few days per tick so the main process stays
 *  responsive; stops once the mirror is current. Safe to call repeatedly. */
export function startMemoryMirrorBackfill(
  getDatabase: () => Database.Database,
  options: { stepDelayMs?: number; maxDays?: number } = {},
): void {
  if (backfillTimer) return
  const stepDelayMs = options.stepDelayMs ?? 1500
  const step = async (): Promise<void> => {
    backfillTimer = null
    const progress = await backfillMemoryMirrorStep(getDatabase(), { maxDays: options.maxDays })
    if (progress && !progress.done) backfillTimer = setTimeout(() => void step(), stepDelayMs)
  }
  backfillTimer = setTimeout(() => void step(), stepDelayMs)
}

export function stopMemoryMirrorBackfill(): void {
  if (backfillTimer) {
    clearTimeout(backfillTimer)
    backfillTimer = null
  }
}

/** Removes a day's memory files. Called when a person deletes a day, so the
 *  readable copy never outlives the record it came from. */
export async function removeDayMemoryMirror(dateStr: string): Promise<void> {
  const root = mirrorRootPath()
  if (!root) return
  let codexRoot: string | null = null
  try {
    codexRoot = getSettings().memoryMirrorCodexExport ? codexMemoryRoot() : null
  } catch {
    codexRoot = null
  }
  try {
    // Deletion ignores the enabled flag: turning the mirror off must not orphan
    // files that were already written.
    const roots = { mirrorRoot: root, codexRoot: codexRoot ?? codexMemoryRoot() }
    await deleteDayMemory(dateStr, roots)
    // The index still lists the day it just removed.
    await rebuildMemoryIndex(roots)
  } catch (error) {
    console.warn('[memoryMirror] failed to delete', dateStr, error)
  }
}

export async function listMemoryMirrorDays(): Promise<string[]> {
  const root = mirrorRootPath()
  return root ? listDayMemories(root) : []
}

/** Opens the day's file in the OS file manager — the action that turns the
 *  local-first claim into something a person can check (positioning.md §3). */
export async function revealDayMemoryMirror(dateStr: string): Promise<boolean> {
  const root = mirrorRootPath()
  if (!root) return false
  try {
    shell.showItemInFolder(path.join(root, memoryFileName(dateStr)))
    return true
  } catch (error) {
    console.warn('[memoryMirror] failed to reveal', dateStr, error)
    return false
  }
}
