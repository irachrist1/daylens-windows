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

// DEV-248, the main-process half of the per-slide wrap export. Pins the disk
// guarantees:
//  - a previous export is DATA: an existing non-empty folder is never reused,
//    the writer uniquifies to `-2`, `-3`, ... instead
//  - a partial write cleans up ONLY the files this run wrote (plus the failed
//    target) — never a recursive folder delete that could take a previous
//    export or anything else the person keeps there
//  - failure is never silent: the rejection names the file and the coverage
// Plus the IPC boundary validation, since filenames cross the bridge.

function files(names: string[]): WrapSlideFile[] {
  return names.map((filename) => ({ filename, bytes: new Uint8Array([1, 2, 3]) }))
}

/** A recording in-memory fs. `existing` seeds directories that already exist
 *  (name → entry names); everything else does not exist. */
function recordingFs(opts: { existing?: Record<string, string[]>; failOn?: string } = {}): {
  deps: WrapSlideFsDeps
  written: string[]
  unlinked: string[]
  rmdirs: string[]
  mkdirs: string[]
} {
  const written: string[] = []
  const unlinked: string[] = []
  const rmdirs: string[] = []
  const mkdirs: string[] = []
  const existing = opts.existing ?? {}
  return {
    written, unlinked, rmdirs, mkdirs,
    deps: {
      mkdir: async (dir) => { mkdirs.push(dir) },
      writeFile: async (filePath) => {
        if (opts.failOn && filePath.endsWith(opts.failOn)) throw new Error('EDQUOT: quota exceeded')
        written.push(filePath)
      },
      readdir: async (dir) => (dir in existing ? existing[dir] : null),
      unlink: async (filePath) => { unlinked.push(filePath) },
      rmdirIfEmpty: async (dir) => { rmdirs.push(dir) },
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

test('write: every slide lands in one fresh folder named after the wrap', async () => {
  const { deps, written, mkdirs } = recordingFs()
  const batch = files(['w-slide-01-opening.png', 'w-slide-02-apps.png', 'w-slide-03-finale.png'])
  const result = await writeWrapSlides('/tmp/dest', 'daylens-week-2026-06-24', batch, deps)
  assert.equal(result.dir, '/tmp/dest/daylens-week-2026-06-24')
  assert.deepEqual(mkdirs, [result.dir])
  assert.deepEqual(result.files, batch.map((f) => f.filename))
  assert.equal(written.length, 3)
  assert.ok(written.every((p) => p.startsWith(result.dir + '/')))
})

test('write: an existing EMPTY folder is reused, not uniquified past', async () => {
  const { deps } = recordingFs({ existing: { '/tmp/dest/daylens-week': [] } })
  const result = await writeWrapSlides('/tmp/dest', 'daylens-week', files(['w-slide-01.png']), deps)
  assert.equal(result.dir, '/tmp/dest/daylens-week')
})

test('write: an existing non-empty folder is a previous export, uniquify, never reuse', async () => {
  const { deps, written } = recordingFs({
    existing: {
      '/tmp/dest/daylens-week': ['monday-slide-01.png'],
      '/tmp/dest/daylens-week-2': ['tuesday-slide-01.png'],
    },
  })
  const result = await writeWrapSlides('/tmp/dest', 'daylens-week', files(['w-slide-01.png']), deps)
  assert.equal(result.dir, '/tmp/dest/daylens-week-3', 'skips every occupied folder')
  assert.ok(written.every((p) => p.startsWith('/tmp/dest/daylens-week-3/')), 'nothing is written into occupied folders')
})

test('write failure: removes ONLY the files this run wrote, names the file, and never touches a previous export', async () => {
  // The reviewed data-loss scenario: Monday's export lives in the plain
  // folder; Friday's re-export goes to `-2` and hits disk-full at slide 3.
  const { deps, unlinked, rmdirs } = recordingFs({
    existing: { '/tmp/dest/daylens-week': ['monday-slide-01.png', 'monday-slide-02.png'] },
    failOn: 'w-slide-03-finale.png',
  })
  const batch = files(['w-slide-01-opening.png', 'w-slide-02-apps.png', 'w-slide-03-finale.png', 'w-slide-04-extra.png'])
  await assert.rejects(
    () => writeWrapSlides('/tmp/dest', 'daylens-week', batch, deps),
    (error: Error) => {
      assert.match(error.message, /w-slide-03-finale\.png/, 'the rejection names the failed file')
      assert.match(error.message, /2 of 4/, 'the rejection reports the coverage')
      return true
    },
  )
  assert.deepEqual(
    unlinked.sort(),
    [
      '/tmp/dest/daylens-week-2/w-slide-01-opening.png',
      '/tmp/dest/daylens-week-2/w-slide-02-apps.png',
      '/tmp/dest/daylens-week-2/w-slide-03-finale.png',
    ],
    'cleanup removes exactly this run: the two written files plus the failed target',
  )
  assert.ok(unlinked.every((p) => !p.startsWith('/tmp/dest/daylens-week/')), "Monday's export is never touched")
  assert.deepEqual(rmdirs, ['/tmp/dest/daylens-week-2'], 'the folder is removed only via the only-if-empty path')
})
