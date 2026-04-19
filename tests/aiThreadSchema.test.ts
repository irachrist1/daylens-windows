import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { ensureAIThreadSchema } from '../src/main/db/aiThreadSchema.ts'
import { deriveTitleFromMessage, isWeakThreadTitle } from '../src/main/lib/threadTitles.ts'

test('ensureAIThreadSchema repairs legacy ai_messages tables missing thread_id', () => {
  const db = new Database(':memory:')

  db.exec(`
    CREATE TABLE ai_conversations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      messages   TEXT    NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE ai_messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES ai_conversations(id),
      role            TEXT    NOT NULL CHECK(role IN ('user', 'assistant')),
      content         TEXT    NOT NULL,
      created_at      INTEGER NOT NULL,
      metadata_json   TEXT    NOT NULL DEFAULT '{}'
    );

    INSERT INTO ai_conversations (id, messages, created_at) VALUES (1, '[]', 1000);
    INSERT INTO ai_messages (conversation_id, role, content, created_at, metadata_json)
    VALUES
      (1, 'user', 'What did I do?', 1100, '{}'),
      (1, 'assistant', 'You worked on Daylens.', 1200, '{}');
  `)

  ensureAIThreadSchema(db)

  const columns = db.prepare(`PRAGMA table_info(ai_messages)`).all() as { name: string }[]
  assert.ok(columns.some((column) => column.name === 'thread_id'))

  const threads = db.prepare(`
    SELECT id, title, created_at, last_message_at, metadata_json
    FROM ai_threads
    ORDER BY id ASC
  `).all() as Array<{
    id: number
    title: string
    created_at: number
    last_message_at: number
    metadata_json: string
  }>
  assert.equal(threads.length, 1)
  assert.equal(threads[0].title, 'Imported chat')
  assert.equal(threads[0].created_at, 1100)
  assert.equal(threads[0].last_message_at, 1200)
  assert.match(threads[0].metadata_json, /legacyConversationId/)

  const rows = db.prepare(`
    SELECT id, thread_id
    FROM ai_messages
    ORDER BY created_at ASC, id ASC
  `).all() as Array<{ id: number; thread_id: number | null }>
  assert.equal(rows.length, 2)
  assert.ok(rows.every((row) => row.thread_id === threads[0].id))

  db.close()
})

test('thread titles prefer concise deterministic intent labels over prompt snippets', () => {
  assert.equal(
    deriveTitleFromMessage('Give me a short report I could share about what I did this week'),
    'Weekly Report',
  )
  assert.equal(
    deriveTitleFromMessage('Show me everything I touched for Project Atlas this week.'),
    'Project Atlas',
  )
})

test('weak titles stay detectable so they can be upgraded later without churning good ones', () => {
  assert.equal(isWeakThreadTitle('New chat'), true)
  assert.equal(isWeakThreadTitle('Give me a sho…'), true)
  assert.equal(isWeakThreadTitle('Weekly Report'), false)
  assert.equal(
    deriveTitleFromMessage('What did I read this week?', {
      weeklyBriefIntent: 'weekly_browsing_reading_brief',
    }),
    'Weekly Reading Recap',
  )
})
