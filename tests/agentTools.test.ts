// Coverage for the chat agent's tool layer: Daylens data tools
// (src/main/agent/daylensTools.ts), read-only machine tools
// (src/main/agent/systemTools.ts), and interaction tools
// (src/main/agent/interactionTools.ts). Tool execute signatures are AI SDK v6
// `tool({ execute })` — call `await (tools.foo as any).execute(input, {} as any)`.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'
import ExcelJS from 'exceljs'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { buildDaylensTools } from '../src/main/agent/daylensTools.ts'
import { buildSystemTools } from '../src/main/agent/systemTools.ts'
import { mcpChildEnv } from '../src/main/agent/mcpTools.ts'
import { buildInteractionTools } from '../src/main/agent/interactionTools.ts'
import type { AIMessageArtifact } from '../src/shared/types.ts'

function setupDb(): Database.Database {
  return createProductionTestDatabase()
}

function localMs(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

// ─── daylensTools: list_page_visits ────────────────────────────────────────

test('list_page_visits aggregates repeat visits to the same page and matches domainContains', async () => {
  const db = setupDb()
  const insertVisit = db.prepare(`
    INSERT INTO website_visits (
      domain, page_title, url, visit_time, visit_time_us, duration_sec,
      browser_bundle_id, source
    ) VALUES (?, ?, ?, ?, ?, ?, 'com.google.Chrome', 'history')
  `)
  const visitTimeA = localMs(2026, 6, 10, 9, 0)
  const visitTimeB = localMs(2026, 6, 10, 9, 30)
  insertVisit.run(
    'youtube.com',
    'How I wasted $52,000 in my Dream Smart Home - YouTube',
    'https://www.youtube.com/watch?v=smart',
    visitTimeA,
    visitTimeA * 1000,
    300,
  )
  insertVisit.run(
    'youtube.com',
    'How I wasted $52,000 in my Dream Smart Home - YouTube',
    'https://www.youtube.com/watch?v=smart',
    visitTimeB,
    visitTimeB * 1000,
    180,
  )
  // A page on an unrelated domain in the same range — must not match domainContains 'youtube'.
  insertVisit.run(
    'docs.google.com',
    'Unrelated doc',
    'https://docs.google.com/document/d/unrelated',
    localMs(2026, 6, 10, 10, 0),
    localMs(2026, 6, 10, 10, 0) * 1000,
    60,
  )

  const tools = buildDaylensTools(db)
  const result = await (tools.list_page_visits as any).execute(
    { startDate: '2026-06-10', endDate: '2026-06-10', domainContains: 'youtube' },
    {} as any,
  )

  assert.equal(result.found, true)
  assert.equal(result.pages.length, 1, 'the two visits to the same page must aggregate into one row')
  const page = result.pages[0]
  assert.equal(page.domain, 'youtube.com')
  assert.equal(page.visitCount, 2)
  assert.equal(page.totalSeconds, 480, 'durations of the repeated visits must sum')
  db.close()
})

test('list_page_visits returns found:false with a reason for a disjoint range', async () => {
  const db = setupDb()
  db.prepare(`
    INSERT INTO website_visits (
      domain, page_title, url, visit_time, visit_time_us, duration_sec,
      browser_bundle_id, source
    ) VALUES (?, ?, ?, ?, ?, ?, 'com.google.Chrome', 'history')
  `).run(
    'youtube.com',
    'Some video - YouTube',
    'https://www.youtube.com/watch?v=abc',
    localMs(2026, 6, 10, 9, 0),
    localMs(2026, 6, 10, 9, 0) * 1000,
    120,
  )

  const tools = buildDaylensTools(db)
  const result = await (tools.list_page_visits as any).execute(
    { startDate: '2026-01-01', endDate: '2026-01-02' },
    {} as any,
  )

  assert.equal(result.found, false)
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0)
  db.close()
})

// ─── daylensTools: get_moment ───────────────────────────────────────────────

test('get_moment reports found:false for a malformed time string', async () => {
  const db = setupDb()
  const tools = buildDaylensTools(db)
  const result = await (tools.get_moment as any).execute(
    { date: '2026-06-10', time: 'not-a-time' },
    {} as any,
  )
  assert.equal(result.found, false)
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0)
  db.close()
})

test('get_day_overview distinguishes locked time from unexplained capture gaps', async () => {
  const db = setupDb()
  const insert = db.prepare(`
    INSERT INTO focus_events (
      ts_ms, mono_ns, event_type, source, confidence, platform, schema_ver
    ) VALUES (?, ?, ?, 'nsworkspace_event', 'observed', 'darwin', 2)
  `)
  const date = '2026-06-10'
  insert.run(localMs(2026, 6, 10, 8, 55), 1, 'app_activated')
  insert.run(localMs(2026, 6, 10, 9, 0), 2, 'lock')
  insert.run(localMs(2026, 6, 10, 10, 0), 3, 'unlock')
  insert.run(localMs(2026, 6, 10, 10, 5), 4, 'app_activated')
  insert.run(localMs(2026, 6, 10, 11, 0), 5, 'app_activated')

  const tools = buildDaylensTools(db)
  const result = await (tools.get_day_overview as any).execute({ date }, {} as any)

  assert.deepEqual(result.machineStateSpans.map((span: { startTime: string; endTime: string }) => [span.startTime, span.endTime]), [
    ['09:00', '10:00'],
  ])
  assert.deepEqual(result.untrackedGaps.map((gap: { startTime: string; endTime: string }) => [gap.startTime, gap.endTime]), [
    ['10:05', '11:00'],
  ])

  const chunks = await (tools.get_time_chunks as any).execute({
    date,
    startTime: '08:00',
    endTime: '12:00',
    incrementMinutes: 60,
  }, {} as any)
  assert.equal(chunks.chunks.length, 4)
  assert.ok(chunks.chunks.every((chunk: { durationMinutes: number }) => chunk.durationMinutes === 60))
  assert.equal(chunks.chunks[1].gap.label, 'machine locked')
  assert.equal(chunks.chunks[2].gap.label, 'no data captured — possible tracking failure')
  db.close()
})

// ─── systemTools: git allowlist ─────────────────────────────────────────────

test('git tool rejects a subcommand off the read-only allowlist', async () => {
  const tools = buildSystemTools()
  const result = await (tools.git as any).execute(
    { repoPath: process.cwd(), subcommand: 'push', args: [] },
    {} as any,
  )
  assert.equal(result.found, false)
  assert.match(result.reason, /not on the read-only allowlist/)
})

test('git tool rejects a denylisted argument even on an allowed subcommand', async () => {
  const tools = buildSystemTools()
  const result = await (tools.git as any).execute(
    { repoPath: process.cwd(), subcommand: 'log', args: ['--output=x'] },
    {} as any,
  )
  assert.equal(result.found, false)
  assert.match(result.reason, /deny list/)
})

test('repository discovery scans Dev roots and ranks activity in range', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-repos-'))
  const active = path.join(home, 'Dev-Personal', 'active-project')
  const quiet = path.join(home, 'Dev-Work', 'quiet-project')
  for (const repo of [active, quiet]) {
    fs.mkdirSync(repo, { recursive: true })
    execFileSync('git', ['init', '-q', repo])
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test User'])
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid'])
    fs.writeFileSync(path.join(repo, 'file.txt'), repo)
    execFileSync('git', ['-C', repo, 'add', 'file.txt'])
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'Initial work'], {
      env: { ...process.env, GIT_AUTHOR_DATE: '2026-06-10T09:00:00Z', GIT_COMMITTER_DATE: '2026-06-10T09:00:00Z' },
    })
  }
  fs.writeFileSync(path.join(active, 'second.txt'), 'more')
  execFileSync('git', ['-C', active, 'add', 'second.txt'])
  execFileSync('git', ['-C', active, 'commit', '-q', '-m', 'Second change'], {
    env: { ...process.env, GIT_AUTHOR_DATE: '2026-06-10T10:00:00Z', GIT_COMMITTER_DATE: '2026-06-10T10:00:00Z' },
  })

  const tools = buildSystemTools({ homeDir: home })
  const result = await (tools.discover_repositories as any).execute(
    { startDate: '2026-06-10', endDate: '2026-06-10' },
    {} as any,
  )

  assert.equal(result.found, true)
  assert.equal(result.repositories[0].path, active)
  assert.equal(result.repositories[0].commitsInRange, 2)
  assert.ok(result.repositories.some((repo: { path: string }) => repo.path === quiet))
})

// ─── systemTools: visible-home path policy ──────────────────────────────────

function makePolicyHome(): { home: string; documents: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-home-'))
  const documents = path.join(home, 'Documents')
  fs.mkdirSync(documents, { recursive: true })
  return { home, documents }
}

test('read_file reads a visible home file and denies hidden, system, and outside paths', async () => {
  const { home, documents } = makePolicyHome()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-outside-'))
  fs.writeFileSync(path.join(documents, 'plan.md'), 'launch plan contents')
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true })
  fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY MATERIAL')
  fs.mkdirSync(path.join(home, 'Library'), { recursive: true })
  fs.writeFileSync(path.join(home, 'Library', 'cookies.txt'), 'session cookie')
  fs.writeFileSync(path.join(documents, '.env'), 'SECRET=1')
  fs.writeFileSync(path.join(outside, 'passwd.txt'), 'system data')

  const tools = buildSystemTools({ homeDir: home })
  const read = (input: { path: string }) => (tools.read_file as any).execute(input, {} as any)

  const visible = await read({ path: path.join(documents, 'plan.md') })
  assert.equal(visible.found, true)
  assert.equal(visible.content, 'launch plan contents')

  for (const denied of [
    path.join(home, '.ssh', 'id_ed25519'),
    path.join(home, 'Library', 'cookies.txt'),
    path.join(documents, '.env'),
    path.join(outside, 'passwd.txt'),
  ]) {
    const result = await read({ path: denied })
    assert.equal(result.found, false, `expected denial for ${denied}`)
    assert.equal(result.content, undefined)
  }
})

test('read_file denies a symlink inside a visible folder that escapes the home directory', async () => {
  const { home, documents } = makePolicyHome()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-escape-'))
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside secret')
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(documents, 'innocent.md'))

  const tools = buildSystemTools({ homeDir: home })
  const result = await (tools.read_file as any).execute({ path: path.join(documents, 'innocent.md') }, {} as any)
  assert.equal(result.found, false)
  assert.equal(result.content, undefined)
})

test('list_dir lists visible entries only and denies directories outside the home', async () => {
  const { home, documents } = makePolicyHome()
  fs.writeFileSync(path.join(documents, 'notes.md'), 'notes')
  fs.writeFileSync(path.join(documents, '.hidden-config'), 'secret')
  fs.mkdirSync(path.join(documents, 'node_modules'), { recursive: true })
  fs.mkdirSync(path.join(home, '.aws'), { recursive: true })

  const tools = buildSystemTools({ homeDir: home })
  const listDir = (input: { path: string }) => (tools.list_dir as any).execute(input, {} as any)

  const listed = await listDir({ path: documents })
  assert.equal(listed.found, true)
  const names = listed.entries.map((entry: { name: string }) => entry.name)
  assert.deepEqual(names, ['notes.md'])

  const homeListing = await listDir({ path: home })
  assert.equal(homeListing.found, true)
  assert.ok(!homeListing.entries.some((entry: { name: string }) => entry.name === '.aws'))

  const outside = await listDir({ path: fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-outside-dir-')) })
  assert.equal(outside.found, false)
})

test('git tool denies repositories outside the home and filesystem-reading arguments', async () => {
  const { home } = makePolicyHome()
  const repo = path.join(home, 'Dev-Test', 'project')
  fs.mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q', repo])

  const tools = buildSystemTools({ homeDir: home })
  const git = (input: { repoPath: string; subcommand: string; args?: string[] }) =>
    (tools.git as any).execute(input, {} as any)

  const inside = await git({ repoPath: repo, subcommand: 'status' })
  assert.equal(inside.found, true)

  const outside = await git({ repoPath: fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-outside-repo-')), subcommand: 'status' })
  assert.equal(outside.found, false)

  const noIndex = await git({ repoPath: repo, subcommand: 'diff', args: ['--no-index', '/etc/hosts', '/dev/null'] })
  assert.equal(noIndex.found, false)

  const gitDir = await git({ repoPath: repo, subcommand: 'log', args: ['--git-dir=/tmp/elsewhere/.git'] })
  assert.equal(gitDir.found, false)
})

test('file search never matches hidden files inside visible folders', async () => {
  const { home, documents } = makePolicyHome()
  fs.writeFileSync(path.join(documents, '.secrets.yaml'), 'credential material for the launch plan')
  fs.writeFileSync(path.join(home, '.netrc'), 'machine example login launch plan')
  fs.writeFileSync(path.join(documents, 'visible.md'), 'the launch plan overview')

  const tools = buildSystemTools({ homeDir: home })
  const byContent = await (tools.search_files as any).execute({ query: 'launch plan' }, {} as any)
  assert.equal(byContent.found, true)
  assert.ok(byContent.matches.every((match: { name: string }) => !match.name.startsWith('.')))

  const homeRoot = await (tools.search_files as any).execute({ query: 'launch plan', roots: [home] }, {} as any)
  assert.ok((homeRoot.matches ?? []).every((match: { name: string }) => !match.name.startsWith('.')))
})

test('git branch is forced to list mode and cannot create or delete branches', async () => {
  const { home } = makePolicyHome()
  const repo = path.join(home, 'Dev-Test', 'branch-project')
  fs.mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test User'])
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid'])
  fs.writeFileSync(path.join(repo, 'file.txt'), 'content')
  execFileSync('git', ['-C', repo, 'add', 'file.txt'])
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'Initial'])

  const tools = buildSystemTools({ homeDir: home })
  const git = (input: { repoPath: string; subcommand: string; args?: string[] }) =>
    (tools.git as any).execute(input, {} as any)

  await git({ repoPath: repo, subcommand: 'branch', args: ['sneaky-new-branch'] })
  const branches = execFileSync('git', ['-C', repo, 'branch'], { encoding: 'utf8' })
  assert.ok(!branches.includes('sneaky-new-branch'))

  const deleteAttempt = await git({ repoPath: repo, subcommand: 'branch', args: ['-D', 'main'] })
  assert.equal(deleteAttempt.found, false)
  assert.match(deleteAttempt.reason, /deny list/)
})

test('mcp server child environment inherits only launch essentials plus configured entries', async () => {
  process.env.DAYLENS_TEST_SECRET = 'sk-super-secret'
  try {
    const env = mcpChildEnv({ MY_SERVER_TOKEN: 'explicit' })
    assert.equal(env.DAYLENS_TEST_SECRET, undefined)
    assert.equal(env.MY_SERVER_TOKEN, 'explicit')
    assert.equal(env.PATH, process.env.PATH)
    assert.equal(env.HOME, process.env.HOME)
  } finally {
    delete process.env.DAYLENS_TEST_SECRET
  }
})

test('file search finds visible notes and excludes private system folders', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-search-'))
  const documents = path.join(home, 'Documents')
  const system = path.join(home, 'Library')
  fs.mkdirSync(documents, { recursive: true })
  fs.mkdirSync(system, { recursive: true })
  fs.writeFileSync(path.join(documents, 'weekly-notes.md'), 'The product review meeting covered launch readiness.')
  fs.writeFileSync(path.join(system, 'private-notes.md'), 'The product review meeting contains private system data.')

  const tools = buildSystemTools({ homeDir: home })
  const result = await (tools.search_files as any).execute({ query: 'product review meeting' }, {} as any)

  assert.equal(result.found, true)
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0].path, fs.realpathSync(path.join(documents, 'weekly-notes.md')))
  assert.ok(result.roots.every((root: string) => !root.includes('Library')))
})

// ─── interactionTools: create_artifact ──────────────────────────────────────

function makeInteractionDeps(artifactDir: string) {
  const artifacts: AIMessageArtifact[] = []
  const deps = {
    askUser: async () => { throw new Error('not used in this test') },
    artifactDir,
    onArtifact: (artifact: AIMessageArtifact) => { artifacts.push(artifact) },
  }
  return { deps, artifacts }
}

test('create_artifact writes a real CSV file and fires onArtifact with format csv', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-agent-tools-'))
  const { deps, artifacts } = makeInteractionDeps(tmpDir)
  const tools = buildInteractionTools(deps)

  const result = await (tools.create_artifact as any).execute(
    {
      title: 'YouTube July 2026',
      format: 'csv',
      columns: ['Title', 'Seconds'],
      rows: [['Video A', 120], ['Video B', 300]],
    },
    {} as any,
  )

  assert.equal(result.found, true)
  assert.ok(fs.existsSync(result.savedTo), 'the CSV file must actually exist on disk')
  const contents = fs.readFileSync(result.savedTo, 'utf8')
  assert.match(contents, /Title,Seconds/)
  assert.match(contents, /Video A,120/)
  assert.equal(artifacts.length, 1)
  assert.equal(artifacts[0].format, 'csv')
})

test('create_artifact writes a real non-empty xlsx file', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-agent-tools-'))
  const { deps, artifacts } = makeInteractionDeps(tmpDir)
  const tools = buildInteractionTools(deps)

  const result = await (tools.create_artifact as any).execute(
    {
      title: 'YouTube July 2026',
      format: 'xlsx',
      columns: ['Title', 'Seconds'],
      rows: [['Video A', 120], ['Video B', 300]],
    },
    {} as any,
  )

  assert.equal(result.found, true)
  const stat = await fsp.stat(result.savedTo)
  assert.ok(stat.size > 0, 'the xlsx file must be non-empty')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(result.savedTo)
  const sheet = workbook.worksheets[0]
  assert.ok(sheet, 'the workbook must have a sheet')
  assert.equal(sheet!.getRow(1).getCell(1).value, 'Title')
  assert.equal(artifacts.length, 1)
  assert.equal(artifacts[0].format, 'xlsx')
})

test('create_artifact rejects a markdown request with no content', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-agent-tools-'))
  const { deps, artifacts } = makeInteractionDeps(tmpDir)
  const tools = buildInteractionTools(deps)

  const result = await (tools.create_artifact as any).execute(
    { title: 'Empty report', format: 'markdown' },
    {} as any,
  )

  assert.equal(result.found, false)
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0)
  assert.equal(artifacts.length, 0, 'no artifact should be recorded when the tool declines')
})
