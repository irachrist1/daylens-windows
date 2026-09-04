import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  MEMORY_INDEX_FILE,
  rebuildMemoryIndex,
  renderDayMemoryMarkdown,
  renderMemoryIndexMarkdown,
  summarizeMemoryFile,
  writeDayMemory,
  type DayMemoryInput,
  type MemoryDaySummary,
} from '../src/main/services/memoryMirror.ts'

function dayInput(date: string, titles: string[], entities: string[] = []): DayMemoryInput {
  const base = Date.parse(`${date}T08:00:00.000Z`)
  return {
    date,
    generatedAtMs: base,
    timezone: 'UTC',
    trackedSeconds: titles.length * 3600,
    blocks: titles.map((title, i) => ({
      id: `blk_${i}`,
      startMs: base + i * 3_600_000,
      endMs: base + (i + 1) * 3_600_000,
      title,
      narrative: null,
      apps: ['Cursor'],
      category: 'development',
      corrected: false,
    })),
    apps: [{ name: 'Cursor', bundleId: 'com.todesktop.cursor', seconds: titles.length * 3600 }],
    entities,
    narrative: null,
  }
}

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'daylens-index-'))
}

test('a rendered day summarizes back to what it was built from', () => {
  const input = dayInput('2026-08-14', ['Shipped the billing migration', 'Reviewed feedback'], ['Acme'])
  const summary = summarizeMemoryFile(renderDayMemoryMarkdown(input))
  assert.deepEqual(summary, {
    date: '2026-08-14',
    tracked: '2h',
    titles: ['Shipped the billing migration', 'Reviewed feedback'],
    entities: ['Acme'],
  })
})

test('summarizing survives quoting and commas in names', () => {
  const input = dayInput('2026-08-14', ['Reviewed: "Q3 plan", costs & scope'], ['Acme, Inc.', 'Onboarding'])
  const summary = summarizeMemoryFile(renderDayMemoryMarkdown(input))
  assert.deepEqual(summary?.titles, ['Reviewed: "Q3 plan", costs & scope'])
  assert.deepEqual(summary?.entities, ['Acme, Inc.', 'Onboarding'])
})

test('a file this module did not write is ignored rather than corrupting the index', () => {
  assert.equal(summarizeMemoryFile('just some notes'), null)
  assert.equal(summarizeMemoryFile('---\nnot: our shape\n---\n'), null)
  assert.equal(summarizeMemoryFile('---\ndate: nonsense\n---\n'), null)
  assert.equal(summarizeMemoryFile(''), null)
})

test('an empty day summarizes without blocks', () => {
  const summary = summarizeMemoryFile(renderDayMemoryMarkdown(dayInput('2026-08-14', [])))
  assert.deepEqual(summary, { date: '2026-08-14', tracked: '0m', titles: [], entities: [] })
})

test('the index lists days newest first', () => {
  const summaries: MemoryDaySummary[] = [
    { date: '2026-08-12', tracked: '3h', titles: ['A'], entities: [] },
    { date: '2026-08-14', tracked: '5h', titles: ['C'], entities: [] },
    { date: '2026-08-13', tracked: '4h', titles: ['B'], entities: [] },
  ]
  const out = renderMemoryIndexMarkdown(summaries)
  const order = [...out.matchAll(/^- \[(\d{4}-\d{2}-\d{2})\]/gm)].map((m) => m[1])
  assert.deepEqual(order, ['2026-08-14', '2026-08-13', '2026-08-12'])
})

test('the index tells an agent not to read every file, and where the numbers live', () => {
  const out = renderMemoryIndexMarkdown([])
  assert.match(out, /Do not read every/)
  assert.match(out, /authoritative/)
  assert.match(out, /never from the prose/)
  assert.match(out, /corrected: true/)
  assert.match(out, /No days recorded yet\./)
})

test('a day line links its file and caps how many titles it shows', () => {
  const out = renderMemoryIndexMarkdown([
    { date: '2026-08-14', tracked: '5h', titles: ['A', 'B', 'C', 'D', 'E', 'F'], entities: ['Acme'] },
  ])
  assert.match(out, /- \[2026-08-14\]\(2026-08-14\.md\) · 5h — A; B; C; D \(\+2 more\) · Acme/)
})

test('the index is rebuilt from the day files on disk', async () => {
  const root = await tmpDir()
  const mirrorRoot = path.join(root, 'memories')

  await writeDayMemory(dayInput('2026-08-13', ['Reviewed feedback']), { mirrorRoot })
  await writeDayMemory(dayInput('2026-08-14', ['Shipped the migration'], ['Acme']), { mirrorRoot })
  // A stray file must not break the rebuild or appear in the index.
  await fs.writeFile(path.join(mirrorRoot, 'scratch.md'), 'unrelated')

  const counted = await rebuildMemoryIndex({ mirrorRoot })
  assert.equal(counted, 2)

  const index = await fs.readFile(path.join(mirrorRoot, MEMORY_INDEX_FILE), 'utf8')
  assert.match(index, /## Days \(2, newest first\)/)
  assert.match(index, /Shipped the migration/)
  assert.doesNotMatch(index, /unrelated/)

  await fs.rm(root, { recursive: true, force: true })
})

test('rebuilding reflects a deleted day', async () => {
  const root = await tmpDir()
  const mirrorRoot = path.join(root, 'memories')

  await writeDayMemory(dayInput('2026-08-13', ['Reviewed feedback']), { mirrorRoot })
  await writeDayMemory(dayInput('2026-08-14', ['Shipped the migration']), { mirrorRoot })
  await rebuildMemoryIndex({ mirrorRoot })

  await fs.rm(path.join(mirrorRoot, '2026-08-14.md'))
  assert.equal(await rebuildMemoryIndex({ mirrorRoot }), 1)

  const index = await fs.readFile(path.join(mirrorRoot, MEMORY_INDEX_FILE), 'utf8')
  assert.doesNotMatch(index, /Shipped the migration/)
  assert.match(index, /Reviewed feedback/)

  await fs.rm(root, { recursive: true, force: true })
})

test('the index is written to the codex root as well', async () => {
  const root = await tmpDir()
  const mirrorRoot = path.join(root, 'memories')
  const codexRoot = path.join(root, 'codex')

  await writeDayMemory(dayInput('2026-08-14', ['Shipped the migration']), { mirrorRoot, codexRoot })
  await rebuildMemoryIndex({ mirrorRoot, codexRoot })

  assert.equal(
    await fs.readFile(path.join(mirrorRoot, MEMORY_INDEX_FILE), 'utf8'),
    await fs.readFile(path.join(codexRoot, MEMORY_INDEX_FILE), 'utf8'),
  )

  await fs.rm(root, { recursive: true, force: true })
})

function busyDays(count: number): MemoryDaySummary[] {
  return Array.from({ length: count }, (_, i) => ({
    date: new Date(Date.parse('2025-01-01T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10),
    tracked: '7h 42m',
    titles: ['Shipped the billing migration', 'Reviewed project feedback', 'Prepared the weekly update'],
    entities: ['Acme', 'Onboarding'],
  }))
}

test('the index stays small enough for an agent to read at scale', () => {
  // The reason the index exists: 600 day files are ~600k tokens and five years
  // is ~1.9M, neither of which fits a context window. Measured with
  // `npm run memory:scale`.
  const sixHundred = renderMemoryIndexMarkdown(busyDays(600)).length / 4
  assert.ok(sixHundred < 25_000, `600 days indexes to ~${Math.round(sixHundred)} tokens`)

  const fiveYears = renderMemoryIndexMarkdown(busyDays(1825)).length / 4
  assert.ok(fiveYears < 60_000, `five years indexes to ~${Math.round(fiveYears)} tokens`)

  assert.equal([...renderMemoryIndexMarkdown(busyDays(600)).matchAll(/^- \[/gm)].length, 600)
})

test('every day stays listed, but only recent ones carry titles', () => {
  const out = renderMemoryIndexMarkdown(busyDays(400))
  const lines = out.split('\n').filter((line) => line.startsWith('- ['))
  assert.equal(lines.length, 400)
  // Newest first, so the head is detailed and the tail is compact.
  assert.match(lines[0], /— Shipped the billing migration/)
  assert.match(lines[lines.length - 1], /— 3 blocks · Acme, Onboarding$/)
  assert.match(out, /listed without their block titles/)
})
