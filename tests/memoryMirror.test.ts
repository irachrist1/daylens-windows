import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  CODEX_EXTENSION_NAME,
  MEMORY_MIRROR_FORMAT,
  codexMemoryRoot,
  deleteDayMemory,
  formatDuration,
  listDayMemories,
  memoryFileName,
  memoryMirrorRoot,
  proseDurationViolations,
  renderDayMemoryMarkdown,
  writeDayMemory,
  type DayMemoryInput,
} from '../src/main/services/memoryMirror.ts'

const TZ = 'UTC'

function dayInput(overrides: Partial<DayMemoryInput> = {}): DayMemoryInput {
  return {
    date: '2026-08-14',
    generatedAtMs: Date.parse('2026-08-14T18:22:04.000Z'),
    timezone: TZ,
    trackedSeconds: 21540,
    blocks: [
      {
        id: 'blk_1',
        startMs: Date.parse('2026-08-14T08:47:00.000Z'),
        endMs: Date.parse('2026-08-14T12:46:00.000Z'),
        title: 'Designed the onboarding screens',
        narrative: 'You worked through the onboarding flow and checked the build alongside it.',
        apps: ['Figma', 'Cursor'],
        category: 'design',
        corrected: true,
      },
    ],
    apps: [
      { name: 'Figma', bundleId: 'com.figma.Desktop', seconds: 8820 },
      { name: 'Cursor', bundleId: 'com.todesktop.cursor', seconds: 5400 },
    ],
    entities: ['Acme'],
    narrative: 'You spent the morning on onboarding design.',
    ...overrides,
  }
}

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'daylens-mirror-'))
}

test('frontmatter carries the day and block numbers', () => {
  const out = renderDayMemoryMarkdown(dayInput())
  assert.match(out, /^---\n/)
  assert.match(out, new RegExp(`format: ${MEMORY_MIRROR_FORMAT.replace('/', '\\/')}`))
  assert.match(out, /date: 2026-08-14/)
  assert.match(out, /tracked_seconds: 21540/)
  assert.match(out, /tracked: "5h 59m"/)
  assert.match(out, /block_count: 1/)
  assert.match(out, /seconds: 14340/)
  assert.match(out, /start: "08:47"/)
  assert.match(out, /end: "12:46"/)
  assert.match(out, /corrected: true/)
})

test('the body carries no number the frontmatter is authoritative for', () => {
  const out = renderDayMemoryMarkdown(dayInput())
  const body = out.slice(out.indexOf('\n---\n', 4) + 5)
  assert.equal(proseDurationViolations(body).length, 0)
})

test('a duration in prose is reported rather than silently rewritten', () => {
  // The defect this rule exists for: a block header saying 3h 59m while its own
  // sentence says 3h 37m.
  const violations = proseDurationViolations('Spent 3h 37m editing Design, with ai tools alongside.')
  assert.deepEqual(violations, ['3h', '37m'])

  const input = dayInput({ narrative: 'Spent 3h 37m editing Design.' })
  assert.match(renderDayMemoryMarkdown(input), /Spent 3h 37m editing Design\./)
})

test('rendering is deterministic and independent of input ordering', () => {
  const base = dayInput()
  const shuffled = dayInput({
    apps: [...base.apps].reverse(),
    entities: ['Acme'],
  })
  assert.equal(renderDayMemoryMarkdown(base), renderDayMemoryMarkdown(shuffled))
})

test('blocks render in start order regardless of input order', () => {
  const early = {
    id: 'blk_0',
    startMs: Date.parse('2026-08-14T06:00:00.000Z'),
    endMs: Date.parse('2026-08-14T07:00:00.000Z'),
    title: 'Cleared the inbox',
    narrative: null,
    apps: ['Mail'],
    category: 'communication',
    corrected: false,
  }
  const out = renderDayMemoryMarkdown(dayInput({ blocks: [dayInput().blocks[0], early] }))
  assert.ok(out.indexOf('Cleared the inbox') < out.indexOf('Designed the onboarding screens'))
})

test('a title containing YAML punctuation stays parseable', () => {
  const out = renderDayMemoryMarkdown(
    dayInput({
      blocks: [{ ...dayInput().blocks[0], title: 'Reviewed: "Q3 plan" — costs & scope' }],
    }),
  )
  assert.match(out, /title: "Reviewed: \\"Q3 plan\\" — costs & scope"/)
  assert.match(out, /## Reviewed: "Q3 plan" — costs & scope/)
})

test('an empty day says so instead of rendering a bare header', () => {
  const out = renderDayMemoryMarkdown(
    dayInput({ blocks: [], apps: [], entities: [], narrative: null, trackedSeconds: 0 }),
  )
  assert.match(out, /blocks: \[\]/)
  assert.match(out, /apps: \[\]/)
  assert.match(out, /entities: \[\]/)
  assert.match(out, /No tracked activity was recorded for this day\./)
})

test('the day header does not depend on the runtime ICU build', () => {
  // Node and Electron ship different ICU versions, and they disagree on the
  // en-GB separator. Delegating this header to Intl made a file's bytes depend
  // on which runtime wrote it.
  assert.match(renderDayMemoryMarkdown(dayInput()), /^# Friday, 14 August 2026$/m)
  assert.match(
    renderDayMemoryMarkdown(dayInput({ date: '2026-01-01' })),
    /^# Thursday, 1 January 2026$/m,
  )
  assert.match(
    renderDayMemoryMarkdown(dayInput({ date: '2024-02-29' })),
    /^# Thursday, 29 February 2024$/m,
  )
})

test('the header is unchanged by the timezone the day was recorded in', () => {
  const utc = renderDayMemoryMarkdown(dayInput({ timezone: 'UTC' }))
  const pacific = renderDayMemoryMarkdown(dayInput({ timezone: 'Pacific/Auckland' }))
  const header = /^# .+$/m
  assert.equal(utc.match(header)?.[0], pacific.match(header)?.[0])
})

test('durations read the way a person writes them', () => {
  assert.equal(formatDuration(21540), '5h 59m')
  assert.equal(formatDuration(3600), '1h')
  assert.equal(formatDuration(600), '10m')
  assert.equal(formatDuration(0), '0m')
  assert.equal(formatDuration(-5), '0m')
})

test('a filename is only ever built from a real date', () => {
  assert.equal(memoryFileName('2026-08-14'), '2026-08-14.md')
  for (const bad of ['../../etc/passwd', '2026-8-4', '', '2026-08-14/../x']) {
    assert.throws(() => memoryFileName(bad), /refusing to build/)
  }
})

test('the codex root follows the extension convention and is not skysight', () => {
  const root = codexMemoryRoot({ CODEX_HOME: '/tmp/codex' } as NodeJS.ProcessEnv, '/home/x')
  assert.equal(root, path.join('/tmp/codex', 'memories', 'extensions', 'daylens'))
  assert.equal(CODEX_EXTENSION_NAME, 'daylens')

  const fallback = codexMemoryRoot({} as NodeJS.ProcessEnv, '/home/x')
  assert.equal(fallback, path.join('/home/x', '.codex', 'memories', 'extensions', 'daylens'))
})

test('the mirror root sits under the app data directory', () => {
  assert.equal(memoryMirrorRoot('/data/Daylens'), path.join('/data/Daylens', 'memories'))
})

test('writing creates the file, and rewriting an unchanged day does not', async () => {
  const root = await tmpDir()
  const mirrorRoot = path.join(root, 'memories')

  const first = await writeDayMemory(dayInput(), { mirrorRoot })
  assert.equal(first.outcome, 'written')
  assert.equal(first.codexPath, null)
  assert.ok(first.bytes > 0)

  const contents = await fs.readFile(first.mirrorPath, 'utf8')
  assert.match(contents, /# Friday, 14 August 2026/)

  const second = await writeDayMemory(dayInput(), { mirrorRoot })
  assert.equal(second.outcome, 'unchanged')

  const changed = await writeDayMemory(dayInput({ trackedSeconds: 30 }), { mirrorRoot })
  assert.equal(changed.outcome, 'written')

  await fs.rm(root, { recursive: true, force: true })
})

test('codex export writes the identical file to both roots', async () => {
  const root = await tmpDir()
  const mirrorRoot = path.join(root, 'memories')
  const codexRoot = path.join(root, 'codex', 'memories', 'extensions', 'daylens')

  const result = await writeDayMemory(dayInput(), { mirrorRoot, codexRoot })
  assert.ok(result.codexPath)
  assert.equal(
    await fs.readFile(result.mirrorPath, 'utf8'),
    await fs.readFile(result.codexPath!, 'utf8'),
  )

  await fs.rm(root, { recursive: true, force: true })
})

test('memory files are not world-readable', async () => {
  const root = await tmpDir()
  const mirrorRoot = path.join(root, 'memories')
  const result = await writeDayMemory(dayInput(), { mirrorRoot })
  const mode = (await fs.stat(result.mirrorPath)).mode & 0o777
  assert.equal(mode & 0o077, 0, `expected owner-only, got ${mode.toString(8)}`)
  await fs.rm(root, { recursive: true, force: true })
})

test('no temporary files survive a write', async () => {
  const root = await tmpDir()
  const mirrorRoot = path.join(root, 'memories')
  await writeDayMemory(dayInput(), { mirrorRoot })
  const entries = await fs.readdir(mirrorRoot)
  assert.deepEqual(entries, ['2026-08-14.md'])
  await fs.rm(root, { recursive: true, force: true })
})

test('deleting a day removes it from every root', async () => {
  const root = await tmpDir()
  const mirrorRoot = path.join(root, 'memories')
  const codexRoot = path.join(root, 'codex')

  await writeDayMemory(dayInput(), { mirrorRoot, codexRoot })
  const removed = await deleteDayMemory('2026-08-14', { mirrorRoot, codexRoot })
  assert.equal(removed.length, 2)
  assert.deepEqual(await listDayMemories(mirrorRoot), [])

  // Deleting again is not an error.
  assert.deepEqual(await deleteDayMemory('2026-08-14', { mirrorRoot, codexRoot }), [])

  await fs.rm(root, { recursive: true, force: true })
})

test('listing returns dates and ignores unrelated files', async () => {
  const root = await tmpDir()
  const mirrorRoot = path.join(root, 'memories')
  await writeDayMemory(dayInput(), { mirrorRoot })
  await writeDayMemory(dayInput({ date: '2026-08-13' }), { mirrorRoot })
  await fs.writeFile(path.join(mirrorRoot, 'notes.md'), 'x')
  await fs.writeFile(path.join(mirrorRoot, 'README.txt'), 'x')

  assert.deepEqual(await listDayMemories(mirrorRoot), ['2026-08-13', '2026-08-14'])
  assert.deepEqual(await listDayMemories(path.join(root, 'missing')), [])

  await fs.rm(root, { recursive: true, force: true })
})
