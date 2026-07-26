// DEV-248: writes a wrap deck's slides to disk as individual PNG files — one
// file per slide, inside a folder named after the wrap, in a destination the
// person picked once. The fs surface is injectable so the hermetic suite can
// prove the two failure guarantees without touching a real disk:
//  1. a partial write never survives — every file already written is removed
//     before the error propagates (wrapped.md: "leaves no partial share on disk")
//  2. failure is never silent — the rejection names the file that failed.

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
  /** Best-effort cleanup of a failed export folder. */
  rm: (dir: string) => Promise<void>
}

function realFs(): WrapSlideFsDeps {
  return {
    mkdir: async (dir) => { await fs.mkdir(dir, { recursive: true }) },
    writeFile: (filePath, bytes) => fs.writeFile(filePath, bytes),
    rm: (dir) => fs.rm(dir, { recursive: true, force: true }),
  }
}

/** Writes every slide into `<baseDir>/<folderName>/`. All-or-nothing: any
 *  write failure removes the folder (best effort) and rejects with the name
 *  of the file that failed. */
export async function writeWrapSlides(
  baseDir: string,
  folderName: string,
  files: WrapSlideFile[],
  deps: WrapSlideFsDeps = realFs(),
): Promise<{ dir: string; files: string[] }> {
  const dir = path.join(baseDir, sanitizeWrapFolderName(folderName))
  await deps.mkdir(dir)
  const written: string[] = []
  for (const file of files) {
    try {
      await deps.writeFile(path.join(dir, file.filename), file.bytes)
    } catch (error) {
      await deps.rm(dir).catch(() => { /* cleanup is best-effort; the write error below is the story */ })
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Writing ${file.filename} failed after ${written.length} of ${files.length} slides: ${reason}`)
    }
    written.push(file.filename)
  }
  return { dir, files: written }
}
