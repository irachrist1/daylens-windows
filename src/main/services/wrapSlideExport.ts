// DEV-248: writes a wrap deck's slides to disk as individual PNG files — one
// file per slide, inside a folder named after the wrap, in a destination the
// person picked once. The fs surface is injectable so the hermetic suite can
// prove the disk guarantees without touching a real disk:
//  1. an existing non-empty folder is never reused — re-exporting the same
//     wrap gets a fresh `-2`, `-3`, ... folder instead of silently overwriting
//     (or later deleting) what a previous export put there
//  2. a partial write never survives — but cleanup removes ONLY the files this
//     run wrote (plus the failed target), never the folder's other contents,
//     and the folder itself only when that leaves it empty
//  3. failure is never silent — the rejection names the file that failed and
//     the coverage (wrapped.md: export failure reports which scenes rendered).

import fs from 'node:fs/promises'
import path from 'node:path'

export interface WrapSlideFile {
  filename: string
  /** PNG bytes as they crossed the IPC bridge. */
  bytes: Uint8Array
}

export const WRAP_EXPORT_MAX_FILES = 100
export const WRAP_EXPORT_MAX_BYTES_PER_FILE = 40 * 1024 * 1024

/** A folder name from an untrusted stem: keeps letters, digits, dot, dash,
 *  underscore; everything else collapses to a dash. Never empty, never a
 *  path traversal. */
export function sanitizeWrapFolderName(stem: string): string {
  const cleaned = stem.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '')
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'daylens-wrap'
}

/** Validates the IPC payload at the boundary. Returns a reason when the
 *  payload must be rejected, null when it is safe to write. */
export function validateWrapSlideFiles(files: unknown): string | null {
  if (!Array.isArray(files) || files.length === 0) return 'The export contained no slides.'
  if (files.length > WRAP_EXPORT_MAX_FILES) return `The export asked for ${files.length} files; the cap is ${WRAP_EXPORT_MAX_FILES}.`
  const seen = new Set<string>()
  for (const file of files as WrapSlideFile[]) {
    const name = file?.filename
    if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+\.png$/.test(name) || name.includes('..')) {
      return `Rejected an unsafe export filename: ${String(name)}`
    }
    if (seen.has(name)) return `Duplicate export filename: ${name}`
    seen.add(name)
    const bytes = file?.bytes
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return `Slide ${name} carried no image data.`
    if (bytes.byteLength > WRAP_EXPORT_MAX_BYTES_PER_FILE) return `Slide ${name} is larger than the export allows.`
  }
  return null
}

export interface WrapSlideFsDeps {
  mkdir: (dir: string) => Promise<void>
  writeFile: (filePath: string, bytes: Uint8Array) => Promise<void>
  /** Entry names of a directory, [] when empty, null when the path does not
   *  exist. A path that exists but is not a readable directory reports as
   *  occupied (non-empty). */
  readdir: (dir: string) => Promise<string[] | null>
  /** Remove one file; a missing file is not an error. */
  unlink: (filePath: string) => Promise<void>
  /** Remove a directory only if it is empty; anything else is a no-op. */
  rmdirIfEmpty: (dir: string) => Promise<void>
}

function realFs(): WrapSlideFsDeps {
  return {
    mkdir: async (dir) => { await fs.mkdir(dir, { recursive: true }) },
    writeFile: (filePath, bytes) => fs.writeFile(filePath, bytes),
    readdir: async (dir) => {
      try {
        return await fs.readdir(dir)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        // Exists but unreadable / not a directory: report occupied so the
        // caller uniquifies past it instead of writing into the unknown.
        return ['occupied']
      }
    },
    unlink: (filePath) => fs.rm(filePath, { force: true }),
    rmdirIfEmpty: async (dir) => { await fs.rmdir(dir).catch(() => { /* non-empty or already gone: leave it */ }) },
  }
}

const WRAP_EXPORT_MAX_FOLDER_ATTEMPTS = 500

/** The first folder path under `baseDir` free to use: the plain name when it
 *  does not exist (or exists empty), otherwise `-2`, `-3`, ... A previous
 *  export is DATA — it is never reused, overwritten, or cleaned up. */
async function pickExportDir(baseDir: string, folderName: string, deps: WrapSlideFsDeps): Promise<string> {
  const base = sanitizeWrapFolderName(folderName)
  for (let attempt = 1; attempt <= WRAP_EXPORT_MAX_FOLDER_ATTEMPTS; attempt++) {
    const candidate = path.join(baseDir, attempt === 1 ? base : `${base}-${attempt}`)
    const entries = await deps.readdir(candidate)
    if (entries === null || entries.length === 0) return candidate
  }
  throw new Error(`Could not find a free folder name for ${base} after ${WRAP_EXPORT_MAX_FOLDER_ATTEMPTS} tries.`)
}

/** Writes every slide into a fresh (or empty pre-existing) folder under
 *  `baseDir`, named after the wrap and uniquified when taken. All-or-nothing
 *  for THIS run: a write failure removes exactly the files this run wrote
 *  plus the failed target, removes the folder only if that leaves it empty,
 *  and rejects with the name of the file that failed. It never deletes
 *  anything a previous run (or the person) put on disk. */
export async function writeWrapSlides(
  baseDir: string,
  folderName: string,
  files: WrapSlideFile[],
  deps: WrapSlideFsDeps = realFs(),
): Promise<{ dir: string; files: string[] }> {
  const dir = await pickExportDir(baseDir, folderName, deps)
  await deps.mkdir(dir)
  const written: string[] = []
  for (const file of files) {
    const target = path.join(dir, file.filename)
    try {
      await deps.writeFile(target, file.bytes)
    } catch (error) {
      // Undo THIS run only: the files we wrote and the failed target. Never a
      // recursive delete — a previous successful export in a sibling folder
      // (or anything else the person keeps here) is untouchable.
      for (const p of [...written, target]) await deps.unlink(p).catch(() => { /* cleanup is best-effort */ })
      await deps.rmdirIfEmpty(dir).catch(() => { /* best-effort */ })
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Writing ${file.filename} failed after ${written.length} of ${files.length} slides: ${reason}`)
    }
    written.push(target)
  }
  return { dir, files: files.map((f) => f.filename) }
}
