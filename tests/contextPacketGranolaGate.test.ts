// DEV-193 regression: the context packet's Granola transcript excerpts must
// honor the SAME granolaAccessEnabled policy switch the read_meeting_notes
// tool enforces. Off means no meeting content ships in any prompt — the
// packet path was bypassing the setting entirely.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { __resetSettings, __setSettings } from './support/settings-stub.mjs'
import { buildContextPacket } from '../src/main/services/contextPacket.ts'

const DATE = '2026-07-20'
const QUESTION = `show me the transcript of the kickoff meeting on ${DATE}`

function connectGranola(db: Database.Database, cachePath: string): void {
  db.prepare(`
    INSERT INTO connector_connections (connector_id, status, config_json, connected_at, updated_at)
    VALUES ('granola', 'connected', ?, ?, ?)
  `).run(JSON.stringify({ cachePath }), Date.now(), Date.now())
}

function insertMeetingRecord(db: Database.Database, id: string, title: string): void {
  db.prepare(`
    INSERT INTO connector_records (
      id, connector_id, source_record_id, kind, date, effective_at,
      retrieved_at, sensitivity, permission_scope, envelope_json, created_at, updated_at
    ) VALUES (?, 'granola', ?, 'meeting_record', ?, ?, ?, 'personal', 'meetings', ?, ?, ?)
  `).run(
    `cr_${id}`,
    `note:${id}`,
    DATE,
    new Date(`${DATE}T10:00:00`).getTime(),
    Date.now(),
    JSON.stringify({ entity: { title } }),
    Date.now(),
    Date.now(),
  )
}

function seedGranolaTranscript(db: Database.Database): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-granola-gate-'))
  const cachePath = path.join(dir, 'cache-v3.json')
  fs.writeFileSync(cachePath, JSON.stringify({
    cache: JSON.stringify({
      state: {
        documents: [{ id: 'doc-1', title: 'Client kickoff' }],
        transcripts: { 'doc-1': 'We agreed on the June scope and the SOW goes out Friday.' },
      },
    }),
  }))
  connectGranola(db, cachePath)
  insertMeetingRecord(db, 'doc-1', 'Client kickoff')
}

function transcriptItems(packet: { items: Array<{ identity: string }> }) {
  return packet.items.filter((item) => item.identity.startsWith('transcript:granola:'))
}

test('a transcript-shaped question discloses the excerpt while Granola access is on', async () => {
  __resetSettings()
  const db = createProductionTestDatabase()
  seedGranolaTranscript(db)
  try {
    const packet = await buildContextPacket(db, { purpose: 'answer', question: QUESTION, destination: 'test:model' })
    const items = transcriptItems(packet)
    assert.equal(items.length, 1, 'the transcript excerpt rides the packet when the switch is on')
  } finally {
    __resetSettings()
    db.close()
  }
})

test('granolaAccessEnabled off keeps transcript excerpts out of the packet entirely', async () => {
  __resetSettings()
  const db = createProductionTestDatabase()
  seedGranolaTranscript(db)
  __setSettings({ granolaAccessEnabled: false })
  try {
    const packet = await buildContextPacket(db, { purpose: 'answer', question: QUESTION, destination: 'test:model' })
    assert.equal(transcriptItems(packet).length, 0, 'a disabled switch must gate the packet path too')
    const statements = packet.items.map((item) => item.statement).join('\n')
    assert.ok(!statements.includes('June scope'), 'no transcript text may leak through another item')
  } finally {
    __resetSettings()
    db.close()
  }
})
