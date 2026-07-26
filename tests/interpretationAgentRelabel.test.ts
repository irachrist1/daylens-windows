// The interpretation-agent relabel (DEV-206, agent-runtime-and-context.md
// §Agent roles): flag-gated agent turns for low-confidence blocks inside
// analyzeTimelineDay, with the deterministic pipeline as the floor and
// evaluateInterpretationRun as the write gate. Hermetic: the model is the AI
// SDK mock, the settings and database are the stub loader's.
import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { MockLanguageModelV3 } from 'ai/test'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { setTestDb, clearTestDb } from './support/database-stub.mjs'
import { __resetSettings, __setSettings, setApiKey } from './support/settings-stub.mjs'
import { materializeTimelineDayProjection } from '../src/main/core/query/projections.ts'
import { analyzeTimelineDay } from '../src/main/services/analyzeDay.ts'
import { runInterpretationAgentRelabel } from '../src/main/services/interpretationAgent.ts'
import type { InterpretationAgentInsight } from '../src/main/services/interpretationAgent.ts'

const TEST_DATE = '2026-04-22'

function localMs(hour: number, minute = 0): number {
  return new Date(2026, 3, 22, hour, minute, 0, 0).getTime()
}

// Three categories interleaved in short runs: no category reaches a 0.4
// share and no run is sustained, so the engine forms ONE 'mixed' block with
// confidence 'low' (label confidence 0.45) — exactly the block the agent
// pass is scoped to. Verified against confidenceForCandidate's rules.
function seedLowConfidenceDay(db: Database.Database): void {
  const insert = (app: string, bundle: string, startMinute: number, category: string) => {
    const startTime = localMs(9, startMinute)
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

test('flag off: the agent is never consulted and the direct relabel runs unchanged', async () => {
  const db = createProductionTestDatabase()
  seedLowConfidenceDay(db)
  assert.ok(lowConfidenceBlockCount(db) >= 1, 'seed must produce a low-confidence block')

  let agentCalls = 0
  let directCalls = 0
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
  db.close()
})

test('flag on: a valid agent label (after a tool call) lands with source ai and a metered usage row', async () => {
  const db = createProductionTestDatabase()
  seedLowConfidenceDay(db)
  setTestDb(db)
  __setSettings({ interpretationAgentEnabled: true, aiProvider: 'anthropic', aiChatProvider: 'anthropic' })
  await setApiKey('anthropic', 'test-key')

  let modelCall = 0
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      modelCall += 1
      if (modelCall === 1) {
        return {
          content: [{
            type: 'tool-call' as const,
            toolCallId: 'ctx-1',
            toolName: 'get_window_title_context',
            input: JSON.stringify({ date: TEST_DATE, appName: 'Slack' }),
          }],
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: mockUsage,
          warnings: [],
        }
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            label: 'Coordinating a release across tools',
            narrative: 'Short hops between notes, chat, and the terminal around one release effort.',
            confidence: 0.74,
            reasoning: 'Window titles and chat context point at one coordinated effort.',
          }),
        }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: mockUsage,
        warnings: [],
      }
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
      // A raw-artifact label ("handoff.md") violates the label-unusable
      // invariant — the eval gate must throw the whole agent pass away.
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
