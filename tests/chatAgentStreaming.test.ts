import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { runChatAgentTurn } from '../src/main/agent/chatAgent.ts'
import type { AIAgentStep } from '../src/shared/types.ts'

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

function response(chunks: unknown[]) {
  return { stream: simulateReadableStream({ chunks }) }
}

test('publishes tool activity and only the grounded final answer', async () => {
  const db = createProductionTestDatabase()
  let call = 0
  const model = new MockLanguageModelV3({
    doStream: async () => {
      call += 1
      if (call === 1) {
        return response([
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: 'I need to inspect Monday using get_day_overview.' },
          { type: 'text-end', id: 'text-1' },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'get_day_overview', input: '{"date":"2026-07-06"}' },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
        ] as never[])
      }
      if (call === 2) {
        return response([
          { type: 'text-start', id: 'text-2' },
          { type: 'text-delta', id: 'text-2', delta: 'Activity appeared at 9:37.' },
          { type: 'text-end', id: 'text-2' },
          { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
        ] as never[])
      }
      return response([
        { type: 'text-start', id: 'text-3' },
        { type: 'text-delta', id: 'text-3', delta: 'No activity was captured.' },
        { type: 'text-end', id: 'text-3' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
      ] as never[])
    },
  })
  const events: Array<{ delta: string; snapshot: string; status?: string; step?: AIAgentStep }> = []

  try {
    const result = await runChatAgentTurn('What happened Monday?', [], {
      db,
      config: { provider: 'anthropic', apiKey: null, model: 'test' },
      model,
      onStreamEvent: (event) => { events.push(event) },
      askUser: async () => '',
      artifactDir: fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-agent-')),
      now: new Date(2026, 6, 12, 12),
    })

    assert.equal(result.text, 'No activity was captured.')
    assert.equal(result.groundingRetried, true)

    // The tool call opens an active step (with the plain status line riding
    // alongside for backward compatibility), the result settles the SAME step
    // to done, and only then does the final grounded answer stream.
    assert.equal(events.length, 3)
    const [opened, settled, answer] = events
    assert.equal(opened.status, 'Reading 2026-07-06')
    assert.deepEqual(
      { ...opened, step: undefined },
      { delta: '', snapshot: '', status: 'Reading 2026-07-06', step: undefined },
    )
    assert.equal(opened.step?.id, 'call-1')
    assert.equal(opened.step?.label, 'Reading 2026-07-06')
    assert.equal(opened.step?.state, 'active')
    assert.ok(typeof opened.step?.startedAt === 'number' && opened.step.startedAt > 0)
    assert.equal(settled.status, undefined)
    assert.deepEqual(settled.step, { ...opened.step, state: 'done' })
    assert.deepEqual(answer, { delta: 'No activity was captured.', snapshot: 'No activity was captured.' })

    assert.ok(events.every((event) => !event.snapshot.includes('get_day_overview')))
    assert.ok(events.every((event) => !event.snapshot.includes('9:37')))
    // Step labels are the human one-liners — never tool names or payloads.
    assert.ok(events.every((event) => !(event.step?.label ?? '').includes('get_day_overview')))
    assert.ok(events.every((event) => !(event.step?.label ?? '').includes('9:37')))
  } finally {
    db.close()
  }
})

test('a failing tool settles its step as failed without leaking the error payload', async () => {
  const db = createProductionTestDatabase()
  let call = 0
  const model = new MockLanguageModelV3({
    doStream: async () => {
      call += 1
      if (call === 1) {
        return response([
          { type: 'tool-call', toolCallId: 'call-ask', toolName: 'ask_user', input: '{"question":"Which Monday?","options":["This week","Last week"]}' },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
        ] as never[])
      }
      return response([
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: 'I could not confirm which Monday you meant.' },
        { type: 'text-end', id: 'text-1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
      ] as never[])
    },
  })
  const events: Array<{ delta: string; snapshot: string; status?: string; step?: AIAgentStep }> = []
  const secretishError = 'internal-channel-token sk-boom-123'

  try {
    const result = await runChatAgentTurn('What happened Monday?', [], {
      db,
      config: { provider: 'anthropic', apiKey: null, model: 'test' },
      model,
      onStreamEvent: (event) => { events.push(event) },
      askUser: async () => { throw new Error(secretishError) },
      artifactDir: fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-agent-fail-')),
      now: new Date(2026, 6, 12, 12),
    })

    const stepEvents = events.filter((event) => event.step).map((event) => event.step as AIAgentStep)
    assert.deepEqual(stepEvents.map((step) => step.state), ['active', 'failed'])
    assert.equal(stepEvents[0].id, stepEvents[1].id)
    assert.equal(stepEvents[0].label, 'Asking you')
    assert.equal(stepEvents[1].label, 'Asking you')
    // The failure is recorded on the persisted trace so history can rebuild
    // the trail honestly — but the error payload never reaches a label.
    assert.equal(result.toolTrace.length, 1)
    assert.equal(result.toolTrace[0].tool, 'ask_user')
    assert.equal(result.toolTrace[0].failed, true)
    assert.ok(events.every((event) => !(event.step?.label ?? '').includes('sk-boom-123')))
    assert.ok(events.every((event) => !(event.status ?? '').includes('sk-boom-123')))
  } finally {
    db.close()
  }
})

test('step labels never carry raw tool arguments such as file paths', async () => {
  const db = createProductionTestDatabase()
  let call = 0
  const model = new MockLanguageModelV3({
    doStream: async () => {
      call += 1
      if (call === 1) {
        return response([
          { type: 'tool-call', toolCallId: 'call-read', toolName: 'read_file', input: '{"path":"/home/someone/.ssh/id_rsa","reason":"check keys"}' },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
        ] as never[])
      }
      return response([
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: 'I was not able to read that file.' },
        { type: 'text-end', id: 'text-1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
      ] as never[])
    },
  })
  const events: Array<{ delta: string; snapshot: string; status?: string; step?: AIAgentStep }> = []

  try {
    await runChatAgentTurn('Can you check my ssh key file?', [], {
      db,
      config: { provider: 'anthropic', apiKey: null, model: 'test' },
      model,
      onStreamEvent: (event) => { events.push(event) },
      askUser: async () => 'Deny',
      artifactDir: fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-agent-leak-')),
      now: new Date(2026, 6, 12, 12),
    })

    const labels = events.flatMap((event) => [event.status ?? '', event.step?.label ?? ''])
    assert.ok(labels.some((label) => label === 'Reading a file'))
    for (const label of labels) {
      assert.ok(!label.includes('id_rsa'), `label leaked the path: ${label}`)
      assert.ok(!label.includes('/home/someone'), `label leaked the path: ${label}`)
    }
  } finally {
    db.close()
  }
})

test('consulting get_time_chunks does not replace the answer unless increments were asked for', async () => {
  const db = createProductionTestDatabase()
  const makeModel = () => {
    let call = 0
    return new MockLanguageModelV3({
      doStream: async () => {
        call += 1
        if (call === 1) {
          return response([
            { type: 'tool-call', toolCallId: 'call-chunks', toolName: 'get_time_chunks', input: '{"date":"2026-07-06","incrementMinutes":60}' },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
          ] as never[])
        }
        return response([
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: 'The longest run was Cursor from 09:00.' },
          { type: 'text-end', id: 'text-1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
        ] as never[])
      },
    })
  }
  try {
    const research = await runChatAgentTurn('What was my longest focus block Monday?', [], {
      db,
      config: { provider: 'anthropic', apiKey: null, model: 'test' },
      model: makeModel(),
      askUser: async () => '',
      artifactDir: fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-agent-chunks-')),
      now: new Date(2026, 6, 12, 12),
    })
    // No increments asked for: the model's prose answer survives even though
    // get_time_chunks was consulted.
    assert.equal(research.text, 'The longest run was Cursor from 09:00.')

    const increments = await runChatAgentTurn('Break Monday into 60-minute chunks', [], {
      db,
      config: { provider: 'anthropic', apiKey: null, model: 'test' },
      model: makeModel(),
      askUser: async () => '',
      artifactDir: fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-agent-chunks2-')),
      now: new Date(2026, 6, 12, 12),
    })
    // Increments asked for: the deterministic table takes over.
    assert.ok(increments.text.includes('60-minute chunks'), `expected chunk table, got: ${increments.text.slice(0, 120)}`)
  } finally {
    db.close()
  }
})

test('creates a requested spreadsheet when the model gathered rows but skipped the artifact call', async () => {
  const db = createProductionTestDatabase()
  const visitTime = new Date(2026, 6, 6, 9).getTime()
  // Page time reconciles against the browser's own foreground time, so the
  // visit needs its owning browser session to count.
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, capture_source, capture_version
    ) VALUES ('browser', 'Browser', ?, ?, 120, 'browsing', 0, 'test', 1)
  `).run(visitTime, visitTime + 120_000)
  db.prepare(`
    INSERT INTO website_visits (
      domain, page_title, url, visit_time, visit_time_us, duration_sec,
      browser_bundle_id, source
    ) VALUES ('media.example', 'Product review', 'https://media.example/watch?v=Abc_123-xyz', ?, ?, 120, 'browser', 'history')
  `).run(visitTime, visitTime * 1000)
  let call = 0
  const model = new MockLanguageModelV3({
    doStream: async () => {
      call += 1
      if (call === 1) {
        return response([
          { type: 'tool-call', toolCallId: 'call-pages', toolName: 'list_page_visits', input: '{"startDate":"2026-07-01","endDate":"2026-07-12"}' },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
        ] as never[])
      }
      return response([
        { type: 'text-start', id: 'text-export' },
        { type: 'text-delta', id: 'text-export', delta: 'Your spreadsheet is ready.' },
        { type: 'text-end', id: 'text-export' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
      ] as never[])
    },
  })
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-agent-export-'))

  try {
    const result = await runChatAgentTurn('Give me an Excel of my page activity this month.', [], {
      db,
      config: { provider: 'anthropic', apiKey: null, model: 'test' },
      model,
      askUser: async () => '',
      artifactDir,
      now: new Date(2026, 6, 12, 12),
    })
    assert.equal(result.artifacts.length, 1)
    assert.equal(result.artifacts[0].format, 'xlsx')
    assert.ok(fs.existsSync(result.artifacts[0].path))
  } finally {
    db.close()
    fs.rmSync(artifactDir, { recursive: true, force: true })
  }
})
