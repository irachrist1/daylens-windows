// The chat agent's external-context tools (contextTools.ts): calendar and git
// through the same stored external signals the wrap reads, and Granola meeting
// notes through the same cache reader the context packet uses — with the
// granolaAccessEnabled policy gate enforced in the tool, outside the model.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { __resetSettings, __setSettings } from './support/settings-stub.mjs'
import { buildContextTools } from '../src/main/agent/contextTools.ts'

const DATE = '2026-07-20'

function setupDb(): Database.Database {
  return createProductionTestDatabase()
}

function putSignal(db: Database.Database, date: string, source: string, payload: unknown): void {
  db.prepare(`
    INSERT INTO external_signals (date, source, payload_json, captured_at)
    VALUES (?, ?, ?, ?)
  `).run(date, source, JSON.stringify(payload), Date.now())
}

function connectGranola(db: Database.Database, cachePath: string): void {
  db.prepare(`
    INSERT INTO connector_connections (connector_id, status, config_json, connected_at, updated_at)
    VALUES ('granola', 'connected', ?, ?, ?)
  `).run(JSON.stringify({ cachePath }), Date.now(), Date.now())
}

function insertMeetingRecord(db: Database.Database, id: string, title: string, date: string): void {
  db.prepare(`
    INSERT INTO connector_records (
      id, connector_id, source_record_id, kind, date, effective_at,
      retrieved_at, sensitivity, permission_scope, envelope_json, created_at, updated_at
    ) VALUES (?, 'granola', ?, 'meeting_record', ?, ?, ?, 'personal', 'meetings', ?, ?, ?)
  `).run(
    `cr_${id}`,
    `note:${id}`,
    date,
    new Date(`${date}T10:00:00`).getTime(),
    Date.now(),
    JSON.stringify({ entity: { title } }),
    Date.now(),
    Date.now(),
  )
}

function writeGranolaCache(documents: unknown[], transcripts: Record<string, unknown> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-granola-'))
  const cachePath = path.join(dir, 'cache-v3.json')
  fs.writeFileSync(cachePath, JSON.stringify({ cache: JSON.stringify({ state: { documents, transcripts } }) }))
  return cachePath
}

// Fresh collection must never run in hermetic tests — stored signals only.
const HERMETIC = { allowCollect: false }

test('get_calendar_events returns the stored day signal with the meeting report shape', async () => {
  const db = setupDb()
  putSignal(db, DATE, 'calendar', {
    events: [{ title: 'Design sync', startClock: '10:00am', durationMinutes: 30, attendeeCount: 4 }],
  })
  const tools = buildContextTools(db, HERMETIC)
  const result = await (tools.get_calendar_events as any).execute({ date: DATE }, {} as any)
  assert.equal(result.found, true)
  assert.equal(result.date, DATE)
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0].title, 'Design sync')
  assert.ok('meetingReport' in result, 'the day-level meeting resolution rides the result')
  db.close()
})

test('get_calendar_events misses honestly when neither source has anything', async () => {
  const db = setupDb()
  const tools = buildContextTools(db, HERMETIC)
  const result = await (tools.get_calendar_events as any).execute({ date: DATE }, {} as any)
  assert.equal(result.found, false)
  assert.match(result.reason, /No calendar events/)
  db.close()
})

test('get_git_activity returns the stored day signal and misses honestly otherwise', async () => {
  const db = setupDb()
  putSignal(db, DATE, 'git', {
    repos: [{ name: 'daylens', commits: [{ subject: 'Fix the eval gate', timestamp: Date.now() }] }],
    totalCommits: 1,
    prs: [],
  })
  const tools = buildContextTools(db, HERMETIC)
  const hit = await (tools.get_git_activity as any).execute({ date: DATE }, {} as any)
  assert.equal(hit.found, true)
  assert.equal(hit.totalCommits, 1)
  assert.equal(hit.repos[0].name, 'daylens')

  const miss = await (tools.get_git_activity as any).execute({ date: '2026-07-21' }, {} as any)
  assert.equal(miss.found, false)
  assert.match(miss.reason, /No git activity/)
  db.close()
})

test('read_meeting_notes lists recent meetings and reads one meeting\'s structured notes', async () => {
  const db = setupDb()
  const cachePath = writeGranolaCache([
    { id: 'doc-1', title: 'Client kickoff', notes_markdown: '# Kickoff\n- agreed on the June scope\n- next step: send the SOW' },
    { id: 'doc-2', title: 'Weekly standup', notes_plain: '' },
  ], {
    'doc-2': [{ text: 'We said the release slips one week.' }],
  })
  connectGranola(db, cachePath)
  insertMeetingRecord(db, 'doc-1', 'Client kickoff', DATE)
  insertMeetingRecord(db, 'doc-2', 'Weekly standup', '2026-07-21')

  const tools = buildContextTools(db, HERMETIC)

  const listing = await (tools.read_meeting_notes as any).execute({}, {} as any)
  assert.equal(listing.found, true)
  assert.equal(listing.meetings.length, 2)
  assert.deepEqual(
    listing.meetings.map((m: { title: string }) => m.title).sort(),
    ['Client kickoff', 'Weekly standup'],
  )

  const scoped = await (tools.read_meeting_notes as any).execute({ startDate: DATE, endDate: DATE }, {} as any)
  assert.equal(scoped.meetings.length, 1)
  assert.equal(scoped.meetings[0].title, 'Client kickoff')

  const notes = await (tools.read_meeting_notes as any).execute({ meetingId: scoped.meetings[0].meetingId }, {} as any)
  assert.equal(notes.found, true)
  assert.equal(notes.source, 'notes')
  assert.match(notes.content, /agreed on the June scope/)

  // A meeting without structured notes falls back to its transcript.
  const transcript = await (tools.read_meeting_notes as any).execute({ meetingId: 'doc-2' }, {} as any)
  assert.equal(transcript.found, true)
  assert.equal(transcript.source, 'transcript')
  assert.match(transcript.content, /release slips one week/)
  db.close()
})

test('read_meeting_notes refuses honestly when the Granola access switch is off', async () => {
  const db = setupDb()
  const cachePath = writeGranolaCache([{ id: 'doc-1', title: 'Client kickoff', notes_markdown: 'notes' }])
  connectGranola(db, cachePath)
  insertMeetingRecord(db, 'doc-1', 'Client kickoff', DATE)
  __setSettings({ granolaAccessEnabled: false })
  try {
    const tools = buildContextTools(db, HERMETIC)
    const result = await (tools.read_meeting_notes as any).execute({}, {} as any)
    assert.equal(result.found, false)
    assert.match(result.reason, /Settings/)

    const read = await (tools.read_meeting_notes as any).execute({ meetingId: 'doc-1' }, {} as any)
    assert.equal(read.found, false, 'the gate covers reads, not just listings')
  } finally {
    __resetSettings()
    db.close()
  }
})

test('read_meeting_notes misses honestly when Granola is not connected', async () => {
  const db = setupDb()
  const tools = buildContextTools(db, HERMETIC)
  const result = await (tools.read_meeting_notes as any).execute({}, {} as any)
  assert.equal(result.found, false)
  assert.match(result.reason, /not connected/)
  db.close()
})
