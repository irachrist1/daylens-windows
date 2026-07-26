// The eval harness grades answers against the per-scenario trace file. A turn
// that calls tools but records nothing into the trace makes every real fact
// look fabricated to the judge — so the agent loop must mirror its tool
// results, step turns, and the rendered context packet into the recorder.
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { runChatAgentTurn } from '../src/main/agent/chatAgent.ts'
import { maybeStartTrace, setCurrentTrace, type TraceRecord } from '../src/main/ai/trace.ts'

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

function response(chunks: unknown[]) {
  return { stream: simulateReadableStream({ chunks }) }
}

test('a chat agent turn records tool results and step turns into the current trace', async () => {
  const db = createProductionTestDatabase()
  const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-trace-'))
  const previousTraceDir = process.env.DAYLENS_AI_TRACE_DIR
  process.env.DAYLENS_AI_TRACE_DIR = traceDir
  const recorder = maybeStartTrace({ scenarioId: 'trace_wiring_test' })
  assert.ok(recorder, 'recorder must start when DAYLENS_AI_TRACE_DIR is set')

  let call = 0
  const model = new MockLanguageModelV3({
    doStream: async () => {
      call += 1
      if (call === 1) {
        return response([
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'get_day_overview', input: '{"date":"2026-07-06"}' },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
        ] as never[])
      }
      return response([
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: 'No activity was captured.' },
        { type: 'text-end', id: 'text-1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
      ] as never[])
    },
  })

  try {
    const result = await runChatAgentTurn('What happened Monday?', [], {
      db,
      config: { provider: 'anthropic', apiKey: null, model: 'test' },
      model,
      askUser: async () => '',
      artifactDir: fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-agent-trace-')),
      now: new Date(2026, 6, 12, 12),
    })
    recorder.finish(result.text)

    const tracePath = path.join(traceDir, 'trace_wiring_test.json')
    assert.ok(fs.existsSync(tracePath), 'trace file must be written')
    const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8')) as TraceRecord

    const toolResults = trace.events.filter((e) => e.kind === 'tool_result')
    assert.equal(toolResults.length, 1)
    const toolEvent = toolResults[0] as Extract<TraceRecord['events'][number], { kind: 'tool_result' }>
    assert.equal(toolEvent.name, 'get_day_overview')
    assert.ok(JSON.stringify(toolEvent.input).includes('2026-07-06'))
    assert.notEqual(toolEvent.output, undefined)

    const turns = trace.events.filter((e) => e.kind === 'turn')
    assert.equal(turns.length, 2, 'one turn event per finish-step')
    const toolTurn = turns[0] as Extract<TraceRecord['events'][number], { kind: 'turn' }>
    assert.equal(toolTurn.toolUses.length, 1)
    assert.equal(toolTurn.toolUses[0].name, 'get_day_overview')
    const answerTurn = turns[1] as Extract<TraceRecord['events'][number], { kind: 'turn' }>
    assert.equal(answerTurn.text, 'No activity was captured.')

    // The rendered context packet rides the trace as authoritative evidence.
    const packets = trace.events.filter((e) => e.kind === 'context_packet')
    assert.equal(packets.length, 1)
    const packet = packets[0] as Extract<TraceRecord['events'][number], { kind: 'context_packet' }>
    assert.ok(packet.rendered.includes('Context packet'))

    assert.equal(trace.totals.toolCallCount, 1)
    assert.equal(trace.totals.turnCount, 2)
  } finally {
    setCurrentTrace(null)
    if (previousTraceDir === undefined) delete process.env.DAYLENS_AI_TRACE_DIR
    else process.env.DAYLENS_AI_TRACE_DIR = previousTraceDir
    db.close()
    fs.rmSync(traceDir, { recursive: true, force: true })
  }
})
