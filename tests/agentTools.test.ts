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
import { putExternalSignal } from '../src/main/services/externalSignals.ts'
import { buildSystemTools } from '../src/main/agent/systemTools.ts'
import { addFileAccessGrant } from '../src/main/services/fileAccess.ts'
import { mcpChildEnv } from '../src/main/agent/mcpTools.ts'
import { buildExportTools, buildInteractionTools } from '../src/main/agent/interactionTools.ts'
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
  // Page time is a breakdown of the browser's own foreground time — visits
  // without an owning foreground browser session contribute no active time,
  // so the fixture needs Chrome frontmost while the visits ran.
  const insertSession = db.prepare(`
    INSERT INTO app_sessions (bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, canonical_app_id, app_instance_id,
      capture_source, capture_version)
    VALUES ('com.google.Chrome', 'Google Chrome', ?, ?, ?, 'browsing', 0, NULL, 'Google Chrome', 'chrome', 'com.google.Chrome', 'test', 1)
  `)
  insertSession.run(localMs(2026, 6, 10, 9, 0), localMs(2026, 6, 10, 9, 5), 300)
  insertSession.run(localMs(2026, 6, 10, 9, 30), localMs(2026, 6, 10, 9, 33), 180)
  const insertVisit = db.prepare(`
    INSERT INTO website_visits (
      domain, page_title, url, visit_time, visit_time_us, duration_sec,
      browser_bundle_id, canonical_browser_id, source
    ) VALUES (?, ?, ?, ?, ?, ?, 'com.google.Chrome', 'chrome', 'history')
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
  // The 10:05 activation is canonical evidence of observed foreground time,
  // so the chunk shows captured activity (with a stable unknown identity)
  // rather than claiming a tracking failure the events disprove.
  assert.ok(chunks.chunks[2].activity.length > 0, 'canonical evidence fills the 10-11 chunk')
  assert.ok(!chunks.chunks[2].gap, 'observed foreground time is not a gap')
  db.close()
})

// ─── daylensTools: calendar / Granola / git signals (DEV-241) ───────────────

function dateString(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function seedGranolaNote(
  db: Database.Database,
  note: { id: string; date: string; title: string; participants: string[]; noteLines: string[]; scheduledClock: string | null },
): void {
  const now = Date.now()
  db.prepare(`
    INSERT INTO connector_connections (connector_id, status, account_label, config_json, connected_at, updated_at)
    VALUES ('granola', 'connected', 'person@example.invalid', '{}', ?, ?)
    ON CONFLICT(connector_id) DO NOTHING
  `).run(now, now)
  db.prepare(`
    INSERT INTO connector_records (
      id, connector_id, source_record_id, kind, entity_id, date, effective_at,
      retrieved_at, sensitivity, permission_scope, envelope_json, created_at, updated_at
    ) VALUES (?, 'granola', ?, 'meeting_record', NULL, ?, ?, ?, 'personal', 'file:read', ?, ?, ?)
  `).run(
    note.id,
    `note:${note.id}`,
    note.date,
    new Date(`${note.date}T12:00:00`).getTime(),
    now,
    JSON.stringify({
      notesSignal: {
        date: note.date,
        title: note.title,
        participants: note.participants,
        actionItems: note.noteLines,
        scheduledClock: note.scheduledClock,
      },
    }),
    now,
    now,
  )
}

test('get_calendar_events answers a FUTURE date: tomorrow returns the stored events', async () => {
  const db = setupDb()
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const date = dateString(tomorrow)
  putExternalSignal(db, date, 'calendar', {
    events: [
      { title: 'Quarterly planning', startClock: '10:00', durationMinutes: 45, attendeeCount: 4 },
      { title: 'Design review', startClock: '2:30pm', durationMinutes: 30, attendeeCount: 2 },
    ],
  })

  const tools = buildDaylensTools(db)
  const result = await (tools.get_calendar_events as any).execute({ date }, {} as any)

  assert.equal(result.found, true)
  assert.equal(result.days.length, 1)
  assert.equal(result.days[0].date, date)
  assert.deepEqual(
    result.days[0].events.map((event: { title: string }) => event.title),
    ['Quarterly planning', 'Design review'],
  )
  // A future scheduled event has no captured evidence yet: calendar_only, never matched.
  assert.equal(result.days[0].meetingReport.calendarOnlyCount, 2)
  assert.equal(result.days[0].meetingReport.matchedCount, 0)
  db.close()
})

test('get_calendar_events spans a range and returns only days with a signal', async () => {
  const db = setupDb()
  putExternalSignal(db, '2026-06-10', 'calendar', {
    events: [{ title: 'Client sync', startClock: '9:00', durationMinutes: 30, attendeeCount: 3 }],
  })
  putExternalSignal(db, '2026-06-12', 'calendar', {
    events: [{ title: 'Retro', startClock: '16:00', durationMinutes: 60, attendeeCount: 5 }],
  })

  const tools = buildDaylensTools(db)
  const result = await (tools.get_calendar_events as any).execute(
    { date: '2026-06-10', endDate: '2026-06-12' },
    {} as any,
  )

  assert.equal(result.found, true)
  assert.deepEqual(result.days.map((day: { date: string }) => day.date), ['2026-06-10', '2026-06-12'])
  db.close()
})

test('get_calendar_events returns an explicit miss, never silence, for an empty date', async () => {
  const db = setupDb()
  const tools = buildDaylensTools(db)
  const result = await (tools.get_calendar_events as any).execute({ date: '2020-02-03' }, {} as any)
  assert.equal(result.found, false)
  assert.ok(typeof result.reason === 'string' && result.reason.includes('2020-02-03'))

  const badRange = await (tools.get_calendar_events as any).execute(
    { date: '2026-01-01', endDate: '2026-12-31' },
    {} as any,
  )
  assert.equal(badRange.found, false)
  assert.ok(typeof badRange.reason === 'string' && badRange.reason.length > 0)
  db.close()
})

test('get_meeting_notes reads a seeded Granola note by date and by query', async () => {
  const db = setupDb()
  seedGranolaNote(db, {
    id: 'granola-note-1',
    date: '2026-06-10',
    title: 'Product sync',
    participants: ['Ana', 'Ben'],
    noteLines: ['Ship the beta invite list', 'Ana owns the pricing page'],
    scheduledClock: '14:00',
  })
  seedGranolaNote(db, {
    id: 'granola-note-2',
    date: '2026-06-11',
    title: 'Board prep',
    participants: ['Chris'],
    noteLines: ['Draft the metrics slide'],
    scheduledClock: null,
  })

  const tools = buildDaylensTools(db)

  const byDate = await (tools.get_meeting_notes as any).execute({ date: '2026-06-10' }, {} as any)
  assert.equal(byDate.found, true)
  assert.equal(byDate.notes.length, 1)
  assert.equal(byDate.notes[0].title, 'Product sync')
  assert.deepEqual(byDate.notes[0].participants, ['Ana', 'Ben'])
  assert.ok(byDate.notes[0].noteLines.includes('Ship the beta invite list'), 'note contents must be readable')

  const byQuery = await (tools.get_meeting_notes as any).execute({ query: 'metrics slide' }, {} as any)
  assert.equal(byQuery.found, true)
  assert.equal(byQuery.notes.length, 1)
  assert.equal(byQuery.notes[0].title, 'Board prep')

  const noMatch = await (tools.get_meeting_notes as any).execute({ date: '2026-06-12' }, {} as any)
  assert.equal(noMatch.found, false)
  assert.match(noMatch.reason, /no meeting notes match/)
  db.close()
})

test('get_meeting_notes miss says Granola is not connected when it is not', async () => {
  const db = setupDb()
  const tools = buildDaylensTools(db)
  const result = await (tools.get_meeting_notes as any).execute({}, {} as any)
  assert.equal(result.found, false)
  assert.match(result.reason, /not connected/)
  db.close()
})

test('get_git_activity returns the stored signal and an explicit miss otherwise', async () => {
  const db = setupDb()
  putExternalSignal(db, '2026-06-10', 'git', {
    repos: [{
      repo: 'daylens',
      commitCount: 2,
      messages: ['Fix the calendar tool', 'Add meeting notes'],
      firstCommitClock: '9:12am',
      lastCommitClock: '4:40pm',
    }],
    totalCommits: 2,
    prs: [{ title: 'Chat calendar access', state: 'open', repo: 'daylens' }],
  })

  const tools = buildDaylensTools(db)
  const found = await (tools.get_git_activity as any).execute({ date: '2026-06-10' }, {} as any)
  assert.equal(found.found, true)
  assert.equal(found.totalCommits, 2)
  assert.equal(found.repos[0].repo, 'daylens')
  assert.equal(found.prs[0].state, 'open')

  const miss = await (tools.get_git_activity as any).execute({ date: '2020-02-03' }, {} as any)
  assert.equal(miss.found, false)
  assert.ok(typeof miss.reason === 'string' && miss.reason.includes('2020-02-03'))
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

test('read_file reads a granted visible home file and denies hidden, system, and outside paths', async () => {
  const { home, documents } = makePolicyHome()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-outside-'))
  fs.writeFileSync(path.join(documents, 'plan.md'), 'launch plan contents')
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true })
  fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY MATERIAL')
  fs.mkdirSync(path.join(home, 'Library'), { recursive: true })
  fs.writeFileSync(path.join(home, 'Library', 'cookies.txt'), 'session cookie')
  fs.writeFileSync(path.join(documents, '.env'), 'SECRET=1')
  fs.writeFileSync(path.join(outside, 'passwd.txt'), 'system data')

  // DEV-184: content reads need a model-readable grant above the path floor.
  const db = setupDb()
  addFileAccessGrant(db, { scopeKind: 'folder', path: home, state: 'model_readable' })
  const tools = buildSystemTools({
    db,
    homeDir: home,
    fileAccess: { db, destination: 'test:model' },
  })
  const read = (input: { path: string }) => (tools.read_file as any).execute(input, {} as any)

  const visible = await read({ path: path.join(documents, 'plan.md') })
  assert.equal(visible.found, true)
  assert.equal(visible.content, 'launch plan contents')

  // The floor denies hidden/system/outside paths even under a home-wide grant.
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
  db.close()
})

test('read_file without any grant is deny-by-default with an explicit permission miss', async () => {
  const { home, documents } = makePolicyHome()
  fs.writeFileSync(path.join(documents, 'plan.md'), 'launch plan contents')
  const db = setupDb()
  const tools = buildSystemTools({ db, homeDir: home, fileAccess: { db, destination: 'test:model' } })
  const result = await (tools.read_file as any).execute({ path: path.join(documents, 'plan.md') }, {} as any)
  assert.equal(result.found, false)
  assert.equal(result.permissionRequired, true)
  assert.equal(result.content, undefined)
  db.close()
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

  // Content matching requires a model-readable grant (DEV-184); the hidden
  // files stay invisible even under a home-wide grant.
  const db = setupDb()
  addFileAccessGrant(db, { scopeKind: 'folder', path: home, state: 'model_readable' })
  const tools = buildSystemTools({ db, homeDir: home, fileAccess: { db, destination: 'test:model' } })
  const byContent = await (tools.search_files as any).execute({ query: 'launch plan' }, {} as any)
  assert.equal(byContent.found, true)
  assert.ok(byContent.matches.every((match: { name: string }) => !match.name.startsWith('.')))

  const homeRoot = await (tools.search_files as any).execute({ query: 'launch plan', roots: [home] }, {} as any)
  assert.ok((homeRoot.matches ?? []).every((match: { name: string }) => !match.name.startsWith('.')))
  db.close()
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

  // Content matching requires a model-readable grant (DEV-184); Library is
  // outside the floor regardless of the grant.
  const db = setupDb()
  addFileAccessGrant(db, { scopeKind: 'folder', path: home, state: 'model_readable' })
  const tools = buildSystemTools({ db, homeDir: home, fileAccess: { db, destination: 'test:model' } })
  const result = await (tools.search_files as any).execute({ query: 'product review meeting' }, {} as any)

  assert.equal(result.found, true)
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0].path, fs.realpathSync(path.join(documents, 'weekly-notes.md')))
  assert.ok(result.roots.every((root: string) => !root.includes('Library')))
  db.close()
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

test('export_week_excel computes the workbook itself and registers the artifact', async () => {
  const db = setupDb()
  db.prepare(`
    INSERT INTO app_sessions (bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, canonical_app_id, app_instance_id,
      capture_source, capture_version)
    VALUES ('com.todesktop.230313mzl4w4u92', 'Cursor', ?, ?, ?, 'development', 1, NULL, 'Cursor', 'cursor', 'com.todesktop.230313mzl4w4u92', 'test', 1)
  `).run(localMs(2026, 6, 8, 9), localMs(2026, 6, 8, 13), 4 * 3600)

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-agent-tools-'))
  const { deps, artifacts } = makeInteractionDeps(tmpDir)
  const tools = buildExportTools(db, deps)

  // Any date inside the week works — it snaps to the Monday.
  const result = await (tools.export_week_excel as any).execute({ weekStartDate: '2026-06-10' }, {} as any)

  assert.equal(result.found, true)
  assert.equal(result.weekStart, '2026-06-08')
  assert.equal(result.filename, 'daylens-week-2026-06-08.xlsx')
  assert.ok(result.totalSeconds > 0, 'the tool must return computed totals, not blanks')
  assert.ok(fs.existsSync(result.savedTo))
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(result.savedTo)
  assert.ok(workbook.getWorksheet('Week summary'))
  assert.ok(workbook.getWorksheet('By app'))
  assert.equal(artifacts.length, 1)
  assert.equal(artifacts[0].format, 'xlsx')
  db.close()
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
