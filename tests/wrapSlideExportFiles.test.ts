import test from 'node:test'
import assert from 'node:assert/strict'
import {
  sanitizeWrapFolderName,
  validateWrapSlideFiles,
  writeWrapSlides,
  WRAP_EXPORT_MAX_FILES,
  type WrapSlideFile,
  type WrapSlideFsDeps,
} from '../src/main/services/wrapSlideExport.ts'

// DEV-248, the main-process half of the per-slide wrap export. Pins the two
// disk guarantees from wrapped.md's failure behavior: a partial write never
// survives (every already-written file is cleaned up before the error
// propagates), and failure is never silent (the rejection names the file and
// the coverage). Plus the IPC boundary validation, since filenames cross the
// bridge from the renderer.

function files(names: string[]): WrapSlideFile[] {
  return names.map((filename) => ({ filename, bytes: new Uint8Array([1, 2, 3]) }))
}

function recordingFs(failOn?: string): {
  deps: WrapSlideFsDeps
  written: string[]
  removed: string[]
  mkdirs: string[]
} {
  const written: string[] = []
  const removed: string[] = []
  const mkdirs: string[] = []
  return {
    written, removed, mkdirs,
    deps: {
      mkdir: async (dir) => { mkdirs.push(dir) },
      writeFile: async (filePath) => {
        if (failOn && filePath.endsWith(failOn)) throw new Error('EDQUOT: quota exceeded')
        written.push(filePath)
      },
      rm: async (dir) => { removed.push(dir) },
    },
  }
}

// ─── Validation at the IPC boundary ──────────────────────────────────────────

test('validation: a clean payload passes', () => {
  assert.equal(validateWrapSlideFiles(files(['a-slide-01-opening.png', 'a-slide-02-apps.png'])), null)
})

test('validation: rejects traversal, non-png, duplicates, empty bytes, and oversized batches', () => {
  assert.match(validateWrapSlideFiles([]) ?? '', /no slides/)
  assert.match(validateWrapSlideFiles(files(['../evil.png'])) ?? '', /unsafe/)
  assert.match(validateWrapSlideFiles(files(['a/b.png'])) ?? '', /unsafe/)
  assert.match(validateWrapSlideFiles(files(['notes.txt'])) ?? '', /unsafe/)
  assert.match(validateWrapSlideFiles(files(['a.png', 'a.png'])) ?? '', /Duplicate/)
  assert.match(validateWrapSlideFiles([{ filename: 'a.png', bytes: new Uint8Array(0) }]) ?? '', /no image data/)
  const tooMany = files(Array.from({ length: WRAP_EXPORT_MAX_FILES + 1 }, (_, i) => `s-${i}.png`))
  assert.match(validateWrapSlideFiles(tooMany) ?? '', /cap/)
})

test('folder names: sanitized from untrusted stems, never empty, never a traversal', () => {
  assert.equal(sanitizeWrapFolderName('daylens-2026-07-26'), 'daylens-2026-07-26')
  assert.equal(sanitizeWrapFolderName('../../etc'), 'etc')
  assert.equal(sanitizeWrapFolderName('a b/c'), 'a-b-c')
  assert.equal(sanitizeWrapFolderName('...'), 'daylens-wrap')
  assert.equal(sanitizeWrapFolderName(''), 'daylens-wrap')
})

// ─── Writing ──────────────────────────────────────────────────────────────────

test('write: every slide lands in one folder named after the wrap', async () => {
  const { deps, written, mkdirs } = recordingFs()
  const batch = files(['w-slide-01-opening.png', 'w-slide-02-apps.png', 'w-slide-03-finale.png'])
  const result = await writeWrapSlides('/tmp/dest', 'daylens-week-2026-06-24', batch, deps)
  assert.equal(result.dir, '/tmp/dest/daylens-week-2026-06-24')
  assert.deepEqual(mkdirs, [result.dir])
  assert.deepEqual(result.files, batch.map((f) => f.filename))
  assert.equal(written.length, 3)
  assert.ok(written.every((p) => p.startsWith(result.dir + '/')))
})

test('write failure: cleans up everything already written and rejects naming the file', async () => {
  const { deps, removed } = recordingFs('w-slide-03-finale.png')
  const batch = files(['w-slide-01-opening.png', 'w-slide-02-apps.png', 'w-slide-03-finale.png', 'w-slide-04-extra.png'])
  await assert.rejects(
    () => writeWrapSlides('/tmp/dest', 'daylens-week', batch, deps),
    (error: Error) => {
      assert.match(error.message, /w-slide-03-finale\.png/, 'the rejection names the failed file')
      assert.match(error.message, /2 of 4/, 'the rejection reports the coverage')
      return true
    },
  )
  assert.deepEqual(removed, ['/tmp/dest/daylens-week'], 'the partial folder is removed, no partial share on disk')
})
