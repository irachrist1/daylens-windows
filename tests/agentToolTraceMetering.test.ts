// Q9 tasks 5+6: a chat turn that uses the NEW agent tools (calendar / git
// signal / meeting notes / run_command) persists a tool trace naming them —
// so the activity trail can reconstruct real phrases for the answer — and the
// chat lane still meters the turn (one ai_usage_events chat_answer row)
// regardless of which tools ran. Driven end-to-end through sendMessage, the
// one chat entrypoint, with the fixture model seam.
import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { setTestDb, clearTestDb } from './support/database-stub.mjs'
import { __resetSettings, __setSettings, setApiKey } from './support/settings-stub.mjs'
import { sendMessage } from '../src/main/jobs/aiService.ts'
import { indexMemoryForDay } from '../src/main/services/memoryIndex.ts'
import { stepsFromToolTrace } from '../src/shared/agentTrail.ts'

const DATE = '2026-07-20'

const usage = {
  inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 },
}

function response(chunks: unknown[]) {
  return { stream: simulateReadableStream({ chunks }) }
}

function seedCalendarSignal(db: Database.Database): void {
  db.prepare(`
    INSERT INTO external_signals (date, source, payload_json, captured_at)
    VALUES (?, 'calendar', ?, ?)
  `).run(DATE, JSON.stringify({
    events: [{ title: 'Design sync', startClock: '10:00am', durationMinutes: 30, attendeeCount: 4 }],
  }), Date.now())
  db.prepare(`
    INSERT INTO external_signals (date, source, payload_json, captured_at)
    VALUES (?, 'git', ?, ?)
  `).run(DATE, JSON.stringify({ repos: [], totalCommits: 0, prs: [] }), Date.now())
}

test('a turn using the new tools persists a toolTrace naming them, reconstructs trail phrases, and meters the chat lane', async () => {
  const db = createProductionTestDatabase()
  seedCalendarSignal(db)
  indexMemoryForDay(db, DATE)

  let call = 0
  const model = new MockLanguageModelV3({
    doStream: async () => {
      call += 1
      if (call === 1) {
        return response([
          { type: 'tool-call', toolCallId: 'cal-1', toolName: 'get_calendar_events', input: `{"date":"${DATE}"}` },
          { type: 'tool-call', toolCallId: 'git-1', toolName: 'get_git_activity', input: `{"date":"${DATE}"}` },
          { type: 'tool-call', toolCallId: 'notes-1', toolName: 'read_meeting_notes', input: '{}' },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
        ] as never[])
      }
      return response([
        { type: 'text-start', id: 'answer-1' },
        { type: 'text-delta', id: 'answer-1', delta: 'One meeting that day: Design sync at 10:00am, 30 minutes.' },
        { type: 'text-end', id: 'answer-1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
      ] as never[])
    },
  })

  setTestDb(db)
  __setSettings({ aiProvider: 'anthropic', aiChatProvider: 'anthropic' })
  await setApiKey('anthropic', 'test-key')
  try {
    const result = await sendMessage(
      { message: `What meetings did I have on ${DATE}?`, threadId: null, clientRequestId: 'q9-trace-1' },
      { model },
    )

    // The PERSISTED trace names every new tool the turn called.
    const trace = result.assistantMessage.agent?.toolTrace ?? []
    const toolsCalled = trace.map((entry) => entry.tool)
    assert.ok(toolsCalled.includes('get_calendar_events'), `trace names get_calendar_events (got: ${toolsCalled.join(', ')})`)
    assert.ok(toolsCalled.includes('get_git_activity'), 'trace names get_git_activity')
    assert.ok(toolsCalled.includes('read_meeting_notes'), 'trace names read_meeting_notes')

    // The same trace round-trips from the database row and reconstructs real
    // trail phrases — no "Working" fallback for the new tools.
    const stored = db.prepare(
      'SELECT metadata_json FROM ai_messages WHERE id = ?',
    ).get(result.assistantMessage.id) as { metadata_json: string }
    const persistedTrace = (JSON.parse(stored.metadata_json).agent?.toolTrace ?? []) as Array<{ tool: string; input: unknown; output: string }>
    assert.deepEqual(persistedTrace.map((entry) => entry.tool), toolsCalled)
    const labels = stepsFromToolTrace(persistedTrace).map((step) => step.label)
    assert.ok(labels.includes(`Checking your calendar for ${DATE}`), `real phrase for calendar (got: ${labels.join(' | ')})`)
    assert.ok(labels.includes(`Checking your commits for ${DATE}`))
    assert.ok(labels.includes('Looking through your meetings'))
    assert.ok(!labels.includes('Working'), 'no generic fallback row for the new tools')

    // Metering: the chat lane recorded exactly one chat_answer usage event
    // for the turn — tools or not, the turn is metered like every AI feature.
    const meterRows = db.prepare(
      `SELECT job_type, screen, success, input_tokens, output_tokens FROM ai_usage_events WHERE job_type = 'chat_answer'`,
    ).all() as Array<{ job_type: string; screen: string; success: number; input_tokens: number | null; output_tokens: number | null }>
    assert.equal(meterRows.length, 1, 'one chat_answer usage row per turn')
    assert.equal(meterRows[0].screen, 'ai_chat')
    assert.equal(meterRows[0].success, 1)
    assert.ok((meterRows[0].input_tokens ?? 0) > 0, 'summed per-turn usage rides the row')
    assert.ok((meterRows[0].output_tokens ?? 0) > 0)
  } finally {
    __resetSettings()
    clearTestDb()
    db.close()
  }
})
