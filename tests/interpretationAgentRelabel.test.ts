// The interpretation-agent relabel (DEV-206, agent-runtime-and-context.md
// §Agent roles): flag-gated agent turns for low-confidence blocks inside
// analyzeTimelineDay, with the deterministic pipeline as the floor and
// evaluateInterpretationRun as the write gate. Hermetic: the model is the AI
// SDK mock, the settings and database are the stub loader's.
import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { setTestDb, clearTestDb } from './support/database-stub.mjs'
import { __resetSettings, __setSettings, setApiKey } from './support/settings-stub.mjs'
import { materializeTimelineDayProjection } from '../src/main/core/query/projections.ts'
import { analyzeTimelineDay } from '../src/main/services/analyzeDay.ts'
import { listContextPackets } from '../src/main/services/contextPacket.ts'
import {
  parseInterpretationAgentInsight,
  runInterpretationAgentRelabel,
} from '../src/main/services/interpretationAgent.ts'
import type { InterpretationAgentInsight } from '../src/main/services/interpretationAgent.ts'

const TEST_DATE = '2026-04-22'

function localMs(hour: number, minute = 0): number {
  return new Date(2026, 3, 22, hour, minute, 0, 0).getTime()
}

// Three categories interleaved in short runs: no category reaches a 0.4
// share and no run is sustained, so the engine forms ONE 'mixed' block with
// confidence 'low' (label confidence 0.45) — exactly the block the agent
// pass is scoped to. Verified against confidenceForCandidate's rules.
function seedLowConfidenceCluster(db: Database.Database, hour: number): void {
  const insert = (app: string, bundle: string, startMinute: number, category: string) => {
    const startTime = localMs(hour, startMinute)
    db.prepare(`
      INSERT INTO app_sessions (
        bundle_id, app_name, start_time, end_time, duration_sec,
        category, is_focused, window_title, raw_app_name, capture_source, capture_version
      ) VALUES (?, ?, ?, ?, 240, ?, 1, '', ?, 'test', 1)
    `).run(bundle, app, startTime, startTime + 4 * 60_000, category, app)
  }
  insert('Notes', 'com.apple.Notes', 0, 'productivity')
  insert('Slack', 'com.tinyspeck.slackmacgap', 4, 'communication')
  insert('Terminal', 'com.apple.Terminal', 8, 'development')
  insert('Notes', 'com.apple.Notes', 12, 'productivity')
  insert('Slack', 'com.tinyspeck.slackmacgap', 16, 'communication')
  insert('Terminal', 'com.apple.Terminal', 20, 'development')
}

function seedLowConfidenceDay(db: Database.Database): void {
  seedLowConfidenceCluster(db, 9)
}

function persistedLabels(db: Database.Database): string[] {
  return materializeTimelineDayProjection(db, TEST_DATE, null)
    .blocks.filter((block) => !block.isLive)
    .map((block) => block.label.current)
}

function lowConfidenceBlockCount(db: Database.Database): number {
  return materializeTimelineDayProjection(db, TEST_DATE, null)
    .blocks.filter((block) => !block.isLive
      && (block.confidence === 'low' || block.label.confidence < 0.58)).length
}

const mockUsage = {
  inputTokens: { total: 40, noCache: 40, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
}

function response(chunks: unknown[]) {
  return { stream: simulateReadableStream({ chunks }) }
}

test('flag off: the agent is never consulted and the direct relabel runs unchanged', async () => {
  const db = createProductionTestDatabase()
  seedLowConfidenceDay(db)
  __setSettings({ interpretationAgentEnabled: false })
  assert.ok(lowConfidenceBlockCount(db) >= 1, 'seed must produce a low-confidence block')

  let agentCalls = 0
  let directCalls = 0
  try {
    const result = await analyzeTimelineDay(db, TEST_DATE, {
      triggerSource: 'background',
      regroupPlan: async () => null,
      blockInsight: async () => {
        directCalls += 1
        return { label: 'Reviewing team updates', narrative: 'Steady coordination work.' }
      },
      agentBlockInsight: async () => {
        agentCalls += 1
        throw new Error('the interpretation agent must not run while the flag is off')
      },
    })

    assert.equal(agentCalls, 0, 'flag off means the agent path is never consulted')
    assert.ok(directCalls >= 1, 'the direct relabel still names the block')
    assert.ok(result.relabeled >= 1)
    assert.ok(persistedLabels(db).includes('Reviewing team updates'))
    assert.equal(
      listContextPackets(db, { exchangeKind: 'day_analysis' }).length,
      0,
      'flag off never records an interpret packet',
    )
  } finally {
    __resetSettings()
    db.close()
  }
})

test('flag on: packet recording must succeed before the provider is called', async () => {
  for (const recordingFailure of ['unavailable', 'insert failure'] as const) {
    const db = createProductionTestDatabase()
    seedLowConfidenceDay(db)
    setTestDb(db)
    __setSettings({ interpretationAgentEnabled: true, aiProvider: 'anthropic', aiChatProvider: 'anthropic' })
    await setApiKey('anthropic', 'test-key')
    if (recordingFailure === 'unavailable') {
      db.exec('DROP TABLE context_packets')
    } else {
      db.exec(`
        CREATE TRIGGER fail_interpret_packet_insert
        BEFORE INSERT ON context_packets
        BEGIN
          SELECT RAISE(ABORT, 'forced packet insert failure');
        END
      `)
    }

    let modelCalls = 0
    let directCalls = 0
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1
        return response([])
      },
    })
    try {
      await assert.rejects(
        analyzeTimelineDay(db, TEST_DATE, {
          triggerSource: 'background',
          regroupPlan: async () => null,
          blockInsight: async () => {
            directCalls += 1
            return { label: 'Reviewing team updates', narrative: 'Direct path.' }
          },
          agentBlockInsight: (block, opts) =>
            runInterpretationAgentRelabel(db, block, { ...opts, model, allowCollect: false }),
        }),
        /could not record what it was about to send/,
        `${recordingFailure} must surface the blocked manual analysis`,
      )

      assert.equal(modelCalls, 0, `${recordingFailure} must prevent remote interpretation`)
      assert.equal(directCalls, 0, `${recordingFailure} keeps the deterministic label instead of making another remote call`)
    } finally {
      __resetSettings()
      clearTestDb()
      db.close()
    }
  }
})

test('flag on: a valid agent label (after a tool call) lands with source ai and a metered usage row', async () => {
  const db = createProductionTestDatabase()
  seedLowConfidenceDay(db)
  setTestDb(db)
  __setSettings({ interpretationAgentEnabled: true, aiProvider: 'anthropic', aiChatProvider: 'anthropic' })
  await setApiKey('anthropic', 'test-key')

  let modelCall = 0
  const model = new MockLanguageModelV3({
    doStream: async () => {
      modelCall += 1
      if (modelCall === 1) {
        return response([
          { type: 'text-start', id: 'draft-1' },
          {
            type: 'text-delta',
            id: 'draft-1',
            delta: JSON.stringify({
              label: 'Drafting an early guess',
              narrative: 'This draft precedes the tool result.',
            }),
          },
          { type: 'text-end', id: 'draft-1' },
          {
            type: 'tool-call',
            toolCallId: 'ctx-1',
            toolName: 'get_window_title_context',
            input: JSON.stringify({ date: TEST_DATE, appName: 'Slack' }),
          },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: mockUsage },
        ] as never[])
      }
      return response([
        { type: 'text-start', id: 'answer-1' },
        {
          type: 'text-delta',
          id: 'answer-1',
          delta: JSON.stringify({
            label: 'Coordinating a release across tools',
            narrative: 'Short hops between notes, chat, and the terminal around one release effort.',
            confidence: 0.74,
            reasoning: 'Window titles and chat context point at one coordinated effort.',
          }),
        },
        { type: 'text-end', id: 'answer-1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: mockUsage },
      ] as never[])
    },
  })

  let directCalls = 0
  try {
    const result = await analyzeTimelineDay(db, TEST_DATE, {
      triggerSource: 'background',
      regroupPlan: async () => null,
      blockInsight: async () => {
        directCalls += 1
        return { label: 'Reviewing team updates', narrative: 'Direct path.' }
      },
      agentBlockInsight: (block, opts) =>
        runInterpretationAgentRelabel(db, block, { ...opts, model, allowCollect: false }),
    })

    assert.ok(modelCall >= 2, 'the agent loop ran a tool step before answering')
    assert.ok(result.relabeled >= 1)

    const payload = materializeTimelineDayProjection(db, TEST_DATE, null)
    const labeled = payload.blocks.find((block) => block.label.current === 'Coordinating a release across tools')
    assert.ok(labeled, 'the agent label persisted on the block')
    assert.equal(labeled.label.source, 'ai')
    assert.equal(directCalls, 0, 'the low-confidence block was handled by the agent, not the direct path')

    const packets = listContextPackets(db, { exchangeKind: 'day_analysis', scopeKey: TEST_DATE })
    assert.ok(packets.length >= 1, 'the turn recorded an interpret-purpose context packet before the model ran')
    assert.equal(packets[0]?.packet.purpose, 'interpret')
    const toolNames = new Set(packets[0]?.packet.tools.map((tool) => tool.name))
    assert.ok(toolNames.has('get_window_title_context'))
    assert.ok(toolNames.has('get_calendar_events'))
    assert.ok(toolNames.has('lookup_entity'))
    assert.ok(!toolNames.has('capture_screen'), 'historical relabel packets do not advertise live screen capture')

    // Usage metering: the turn wrote one interpretation_agent row (DEV-228
    // lanes) — the tool loop is never invisible to Usage.
    const usageRows = db.prepare(
      `SELECT job_type, success, input_tokens FROM ai_usage_events WHERE job_type = 'interpretation_agent'`,
    ).all() as Array<{ job_type: string; success: number; input_tokens: number | null }>
    assert.equal(usageRows.length, 1)
    assert.equal(usageRows[0].success, 1)
    assert.ok((usageRows[0].input_tokens ?? 0) > 0)
  } finally {
    __resetSettings()
    clearTestDb()
    db.close()
  }
})

test('flag on: an invariant-violating agent pass is discarded and the deterministic result stands', async () => {
  const db = createProductionTestDatabase()
  seedLowConfidenceDay(db)
  __setSettings({ interpretationAgentEnabled: true })

  let directCalls = 0
  try {
    const result = await analyzeTimelineDay(db, TEST_DATE, {
      triggerSource: 'background',
      regroupPlan: async () => null,
      blockInsight: async () => {
        directCalls += 1
        return { label: 'Reviewing team updates', narrative: 'Direct path.' }
      },
      // A raw-artifact label ("handoff.md") is discarded per block by the
      // findRawArtifactLeak gate before the eval runs — the block falls back
      // to the direct relabel and the leaking label never persists.
      agentBlockInsight: async (): Promise<InterpretationAgentInsight> => ({
        label: 'Editing handoff.md notes',
        narrative: 'Raw artifact leak.',
        confidence: 0.9,
        reasoning: null,
        toolsUsed: [],
      }),
    })

    assert.ok(directCalls >= 1, 'the discarded block fell back to the direct relabel')
    assert.ok(result.relabeled >= 1)
    const labels = persistedLabels(db)
    assert.ok(labels.includes('Reviewing team updates'), 'the deterministic label stands')
    assert.ok(!labels.some((label) => label.includes('handoff.md')), 'the violating agent label never persisted')
  } finally {
    __resetSettings()
    db.close()
  }
})

// One-shot mock model that answers with the given insight JSON directly.
function answerModel(insight: Record<string, unknown>): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => response([
      { type: 'text-start', id: 'answer-1' },
      { type: 'text-delta', id: 'answer-1', delta: JSON.stringify(insight) },
      { type: 'text-end', id: 'answer-1' },
      { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: mockUsage },
    ] as never[]),
  })
}

async function runVoiceGateCase(insight: Record<string, unknown>): Promise<{
  directCalls: number
  labels: string[]
  failureReasons: string[]
  db: Database.Database
}> {
  const db = createProductionTestDatabase()
  seedLowConfidenceDay(db)
  setTestDb(db)
  __setSettings({ interpretationAgentEnabled: true, aiProvider: 'anthropic', aiChatProvider: 'anthropic' })
  await setApiKey('anthropic', 'test-key')
  let directCalls = 0
  await analyzeTimelineDay(db, TEST_DATE, {
    triggerSource: 'background',
    regroupPlan: async () => null,
    blockInsight: async () => {
      directCalls += 1
      return { label: 'Reviewing team updates', narrative: 'Direct path.' }
    },
    agentBlockInsight: (block, opts) =>
      runInterpretationAgentRelabel(db, block, { ...opts, model: answerModel(insight), allowCollect: false }),
  })
  const failureReasons = (db.prepare(
    `SELECT failure_reason FROM ai_usage_events WHERE job_type = 'interpretation_agent' AND success = 0`,
  ).all() as Array<{ failure_reason: string | null }>).map((row) => row.failure_reason ?? '')
  return { directCalls, labels: persistedLabels(db), failureReasons, db }
}

test('a bare app name is held to the label-voice contract: the agent fails and the block falls back', async () => {
  try {
    // "Slack" is one of the block's own app names — software, not an activity.
    const { directCalls, labels, failureReasons, db } = await runVoiceGateCase({
      label: 'Slack',
      narrative: 'Messaging in Slack.',
      confidence: 0.9,
    })
    assert.ok(directCalls >= 1, 'the rejected block fell back to the direct relabel')
    assert.ok(!labels.includes('Slack'), 'the bare app name never persisted')
    assert.ok(labels.includes('Reviewing team updates'))
    assert.ok(
      failureReasons.some((reason) => /label rejected/.test(reason)),
      'the rejection is metered as an agent failure',
    )
    db.close()
  } finally {
    __resetSettings()
    clearTestDb()
  }
})

test('a tool-surface label behind a verb lead is rejected at generation time and the block falls back', async () => {
  try {
    // "Working on Cursor Agents" passes the bare-subject guard (verb lead)
    // and the voice invariants; the shared work-name-guard object check must
    // still reject it before it ever persists.
    const { directCalls, labels, failureReasons, db } = await runVoiceGateCase({
      label: 'Working on Cursor Agents',
      narrative: 'Time in the agent panel.',
      confidence: 0.9,
    })
    assert.ok(directCalls >= 1, 'the rejected block fell back to the direct relabel')
    assert.ok(!labels.includes('Working on Cursor Agents'), 'the tool-surface label never persisted')
    assert.ok(labels.includes('Reviewing team updates'))
    assert.ok(
      failureReasons.some((reason) => /label rejected/.test(reason)),
      'the rejection is metered as an agent failure',
    )
    db.close()
  } finally {
    __resetSettings()
    clearTestDb()
  }
})

test('an over-long label fails the same bound the direct path enforces and the block falls back', async () => {
  try {
    const longLabel = `Reviewing ${'very '.repeat(25)}long coordination work` // > 90 chars, > 12 words
    const { directCalls, labels, db } = await runVoiceGateCase({
      label: longLabel,
      narrative: 'Too long.',
      confidence: 0.9,
    })
    assert.ok(directCalls >= 1, 'the rejected block fell back to the direct relabel')
    assert.ok(!labels.includes(longLabel), 'the over-long label never persisted')
    assert.ok(labels.includes('Reviewing team updates'))
    db.close()
  } finally {
    __resetSettings()
    clearTestDb()
  }
})

test('parseInterpretationAgentInsight hard-caps runaway labels before any validation', () => {
  const runaway = JSON.stringify({ label: 'x'.repeat(2600), narrative: 'n' })
  assert.equal(parseInterpretationAgentInsight(runaway), null, 'a 2600-char label is never accepted')
  const boundary = JSON.stringify({ label: 'y'.repeat(201), narrative: 'n' })
  assert.equal(parseInterpretationAgentInsight(boundary), null, 'anything past 200 chars is refused at parse time')
  const fine = parseInterpretationAgentInsight(JSON.stringify({ label: 'Reviewing team updates', narrative: 'n' }))
  assert.equal(fine?.label, 'Reviewing team updates')
})

test('the gate is per block: one leaking label is discarded alone while a clean sibling label persists', async () => {
  const db = createProductionTestDatabase()
  // Two low-confidence blocks, hours apart, so ONE agent pass carries two
  // proposals: a leaking one (morning) and a clean one (afternoon).
  seedLowConfidenceCluster(db, 9)
  seedLowConfidenceCluster(db, 14)
  __setSettings({ interpretationAgentEnabled: true })
  const noon = localMs(12)

  let directCalls = 0
  try {
    const result = await analyzeTimelineDay(db, TEST_DATE, {
      triggerSource: 'background',
      regroupPlan: async () => null,
      blockInsight: async () => {
        directCalls += 1
        return { label: 'Reviewing team updates', narrative: 'Direct path.' }
      },
      agentBlockInsight: async (block): Promise<InterpretationAgentInsight> => (
        block.startTime < noon
          ? { label: 'Editing handoff.md notes', narrative: 'Leak.', confidence: 0.9, reasoning: null, toolsUsed: [] }
          : { label: 'Coordinating a release across tools', narrative: 'Clean.', confidence: 0.8, reasoning: null, toolsUsed: [] }
      ),
    })

    const labels = persistedLabels(db)
    assert.ok(labels.includes('Coordinating a release across tools'), 'the clean agent label persisted')
    assert.ok(!labels.some((label) => label.includes('handoff.md')), 'the leaking label never persisted')
    assert.ok(labels.includes('Reviewing team updates'), 'the leaking block fell back to the direct relabel')
    assert.ok(directCalls >= 1, 'exactly the discarded block reached the direct path')
    assert.ok(result.relabeled >= 2, 'both blocks ended the run named')
  } finally {
    __resetSettings()
    db.close()
  }
})

test('flag on: an agent throw falls back per block to the direct relabel', async () => {
  const db = createProductionTestDatabase()
  seedLowConfidenceDay(db)
  __setSettings({ interpretationAgentEnabled: true })

  let agentCalls = 0
  let directCalls = 0
  try {
    const result = await analyzeTimelineDay(db, TEST_DATE, {
      triggerSource: 'background',
      regroupPlan: async () => null,
      blockInsight: async () => {
        directCalls += 1
        return { label: 'Reviewing team updates', narrative: 'Direct path.' }
      },
      agentBlockInsight: async () => {
        agentCalls += 1
        throw new Error('provider timeout')
      },
    })

    assert.ok(agentCalls >= 1, 'the agent was attempted for the low-confidence block')
    assert.ok(directCalls >= 1, 'the block fell back to the direct relabel')
    assert.ok(result.relabeled >= 1)
    assert.ok(persistedLabels(db).includes('Reviewing team updates'))
    assert.equal(result.failures.length, 0, 'a per-block agent failure is a fallback, not a run failure')
  } finally {
    __resetSettings()
    db.close()
  }
})
