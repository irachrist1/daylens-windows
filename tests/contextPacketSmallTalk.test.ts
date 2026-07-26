// Context scales with the question (DEV-244): a pure greeting or courtesy
// turn attaches NOTHING — no packet is assembled, nothing is recorded in the
// disclosure ledger, and the model prompt carries no day record. A real
// question still gets full assembly. The gate is deterministic and
// conservative: one token outside the small-talk lexicon means full assembly.
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { runChatAgentTurn } from '../src/main/agent/chatAgent.ts'
import { isSmallTalkTurn } from '../src/main/services/contextPacket.ts'
import { indexMemoryForDay } from '../src/main/services/memoryIndex.ts'
import type { AIChatWorkingContext } from '../src/shared/types.ts'
import type Database from 'better-sqlite3'

const DATE = '2026-04-22'
const NOW = new Date(2026, 3, 23, 12, 0, 0, 0)

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

function answerModel(text: string, onCall?: (options: { prompt: unknown }) => void): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async (options) => {
      onCall?.(options as { prompt: unknown })
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 'answer-1' },
            { type: 'text-delta', id: 'answer-1', delta: text },
            { type: 'text-end', id: 'answer-1' },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
          ] as never[],
        }),
      }
    },
  })
}

function insertSession(db: Database.Database, title: string): void {
  const startTime = new Date(2026, 3, 22, 9, 0, 0, 0).getTime()
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, capture_source, capture_version
    ) VALUES ('com.mitchellh.ghostty', 'Ghostty', ?, ?, 2700, 'development', 1, ?, 'Ghostty', 'test', 1)
  `).run(startTime, startTime + 45 * 60_000, title)
}

function agentDeps(db: Database.Database, model: MockLanguageModelV3, onStreamEvent?: (event: { context?: AIChatWorkingContext }) => void) {
  return {
    db,
    config: { provider: 'anthropic' as const, apiKey: null, model: 'test' },
    model,
    onStreamEvent,
    askUser: async () => '',
    artifactDir: fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-smalltalk-')),
    now: NOW,
  }
}

test('isSmallTalkTurn: greetings and courtesies gate; anything question-shaped does not', () => {
  const smallTalk = ['hi', 'Hello!', 'hey there', 'Good morning', 'thanks!', 'thank you so much', 'ok cool', "what's up", 'how are you?', 'bye']
  for (const message of smallTalk) {
    assert.equal(isSmallTalkTurn(message), true, `"${message}" is small talk`)
  }
  const realQuestions = [
    'hi, what did I do yesterday?',
    'What happened Monday?',
    'how much time did I spend in Figma?',
    `Summarize ${DATE}`,
    'thanks — now show me my meetings',
    'good morning, brief me on today',
  ]
  for (const message of realQuestions) {
    assert.equal(isSmallTalkTurn(message), false, `"${message}" is a real question`)
  }
  // Empty input is not a greeting; the safe default is full assembly.
  assert.equal(isSmallTalkTurn(''), false)
  assert.equal(isSmallTalkTurn('   '), false)
})

test('a greeting attaches no packet items: nothing assembled, nothing recorded, nothing in the prompt', async () => {
  const db = createProductionTestDatabase()
  insertSession(db, 'Refactoring the retrieval planner')
  indexMemoryForDay(db, DATE)

  const prompts: string[] = []
  const contexts: AIChatWorkingContext[] = []
  const model = answerModel('Hi! Ready when you are.', (options) => prompts.push(JSON.stringify(options.prompt)))

  const result = await runChatAgentTurn('hi', [], agentDeps(db, model, (event) => {
    if (event.context) contexts.push(event.context)
  }))
  try {
    assert.equal(result.contextPacketId, null, 'no packet id is claimed for a greeting')
    const rows = (db.prepare('SELECT COUNT(*) AS c FROM context_packets').get() as { c: number }).c
    assert.equal(rows, 0, 'nothing lands in the disclosure ledger')
    for (const prompt of prompts) {
      assert.ok(!prompt.includes('Context packet'), 'the prompt carries no packet')
      assert.ok(!prompt.includes('Refactoring the retrieval planner'), 'no day record leaks into a greeting')
    }
    // The progress panel is told honestly that nothing attached.
    assert.equal(contexts.length, 1)
    assert.equal(contexts[0].itemCount, 0)
    assert.deepEqual(contexts[0].dates, [])
    assert.deepEqual(contexts[0].readablePaths, [])
    assert.ok(result.durationMs >= 0, 'the turn still records how long it worked')
  } finally {
    db.close()
  }
})

test('a real question on the same state still assembles and records the packet', async () => {
  const db = createProductionTestDatabase()
  insertSession(db, 'Refactoring the retrieval planner')
  indexMemoryForDay(db, DATE)

  const prompts: string[] = []
  const contexts: AIChatWorkingContext[] = []
  const model = answerModel('The planner refactor led the day [C1].', (options) => prompts.push(JSON.stringify(options.prompt)))

  const result = await runChatAgentTurn(
    `What retrieval planner work happened on ${DATE}?`,
    [],
    agentDeps(db, model, (event) => { if (event.context) contexts.push(event.context) }),
  )
  try {
    assert.ok(result.contextPacketId, 'a real question records its packet')
    const rows = (db.prepare('SELECT COUNT(*) AS c FROM context_packets').get() as { c: number }).c
    assert.equal(rows, 1)
    assert.match(prompts[0], /Context packet ctx_/)
    assert.equal(contexts.length, 1)
    assert.ok(contexts[0].itemCount > 0, 'the working context reports the attached items')
    assert.deepEqual(contexts[0].dates, [DATE])
  } finally {
    db.close()
  }
})
