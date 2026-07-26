// The activity trail behind AI answers (issue #25): step accumulation for the
// live trail, collapse behavior so many steps never flood the chat, honest
// reconstruction from a persisted tool trace, the settle summary whose counts
// must equal the packet inspector's, and the no-leak guarantee on labels.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import {
  aggregateToolsConsulted,
  collapseTrail,
  liveTrailRows,
  statusForTool,
  stepsFromToolTrace,
  summarizeAgentTurn,
  upsertStep,
  TRAIL_COLLAPSE_LIMIT,
} from '../src/shared/agentTrail.ts'
import { toolsConsultedForMessage } from '../src/main/services/contextPacketInspection.ts'
import type { AIAgentStep } from '../src/shared/types.ts'

const step = (id: string, state: AIAgentStep['state'], label = `label ${id}`, startedAt = 100): AIAgentStep => (
  { id, label, state, startedAt }
)

test('upsertStep appends new steps and settles existing ones in place', () => {
  let steps: AIAgentStep[] = []
  steps = upsertStep(steps, step('a', 'active'))
  steps = upsertStep(steps, step('b', 'active'))
  assert.deepEqual(steps.map((s) => s.id), ['a', 'b'])

  // Settling "a" keeps its position and its original start time.
  steps = upsertStep(steps, { ...step('a', 'done'), startedAt: 999 })
  assert.deepEqual(steps.map((s) => [s.id, s.state]), [['a', 'done'], ['b', 'active']])
  assert.equal(steps[0].startedAt, 100)
})

test('liveTrailRows: status-only fallback, pass-through with an active row, composing row when all settled', () => {
  assert.deepEqual(liveTrailRows([], ''), [])
  assert.deepEqual(
    liveTrailRows([], 'Reading the day'),
    [{ id: 'status', label: 'Reading the day', state: 'active', startedAt: 0 }],
  )

  const running = [step('a', 'done'), step('b', 'active')]
  assert.deepEqual(liveTrailRows(running, 'x'), running)

  // Tools all settled but the answer has not streamed yet: the trail says the
  // model is composing instead of showing no in-progress row.
  const settled = [step('a', 'done'), step('b', 'failed')]
  const rows = liveTrailRows(settled, 'x')
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.slice(0, 2), settled)
  assert.equal(rows[2].state, 'active')
})

test('collapseTrail keeps the newest rows and folds the earlier ones', () => {
  const few = [step('a', 'done'), step('b', 'active')]
  assert.deepEqual(collapseTrail(few), { visible: few, hiddenCount: 0 })

  const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, index) => (
    step(id, index === 6 ? 'active' : 'done')
  ))
  const collapsed = collapseTrail(many)
  assert.equal(collapsed.visible.length, TRAIL_COLLAPSE_LIMIT)
  assert.equal(collapsed.hiddenCount, many.length - TRAIL_COLLAPSE_LIMIT)
  // The active row is always among the visible ones (it is the newest).
  assert.equal(collapsed.visible[collapsed.visible.length - 1].id, 'g')

  const expanded = collapseTrail(many, Number.POSITIVE_INFINITY)
  assert.deepEqual(expanded, { visible: many, hiddenCount: 0 })
})

test('stepsFromToolTrace rebuilds the trail with live labels and honest failure states', () => {
  const trace = [
    { tool: 'get_day_overview', input: { date: '2026-07-06' }, output: '{"found":true}' },
    { tool: 'search_history', input: { query: 'coursera' }, output: '{"found":true}' },
    { tool: 'read_file', input: { path: '/home/u/notes.md' }, output: '{"found":false,"reason":"boom"}', failed: true },
  ]
  const steps = stepsFromToolTrace(trace)
  assert.deepEqual(steps.map((s) => [s.label, s.state]), [
    ['Reading 2026-07-06', 'done'],
    ['Searching for "coursera"', 'done'],
    ['Reading a file', 'failed'],
  ])
  // Reconstructed labels never carry inputs or outputs.
  for (const s of steps) {
    assert.ok(!s.label.includes('/home/u/notes.md'))
    assert.ok(!s.label.includes('found'))
  }

  assert.deepEqual(stepsFromToolTrace(null), [])
  assert.deepEqual(stepsFromToolTrace(undefined), [])
  assert.deepEqual(stepsFromToolTrace([{ tool: 42, input: {}, output: '' } as never]), [])
})

test('statusForTool produces real phrases for every agent tool, including the escalation tools', () => {
  assert.equal(
    statusForTool('capture_screen', { reason: 'the active window has no title' }),
    'Looking at your screen — the active window has no title',
    'the capture reason is shown verbatim — the user always sees why the agent looked',
  )
  assert.equal(statusForTool('capture_screen', {}), 'Looking at your screen')

  assert.equal(
    statusForTool('run_command', { command: 'ls', reason: 'checking what is in the project folder' }),
    'Running ls — checking what is in the project folder',
  )
  assert.equal(statusForTool('run_command', {}), 'Running a command')
  // A command value that is not a bare binary name never reaches the label.
  assert.equal(
    statusForTool('run_command', { command: '/usr/bin/env FOO=1 evil' }),
    'Running a command',
  )

  assert.equal(statusForTool('export_week_excel', { weekStartDate: '2026-07-20' }), 'Building your weekly export')
  assert.equal(statusForTool('get_calendar_events', { date: '2026-07-20' }), 'Checking your calendar for 2026-07-20')
  assert.equal(statusForTool('get_git_activity', { date: '2026-07-20' }), 'Checking your commits for 2026-07-20')
  assert.equal(statusForTool('read_meeting_notes', {}), 'Looking through your meetings')
  assert.equal(statusForTool('read_meeting_notes', { meetingId: 'note:doc-1' }), 'Reading meeting notes')
  assert.equal(statusForTool('get_attribution', { entityName: 'ACME' }), 'Checking attributed work')
  assert.equal(statusForTool('list_clients', {}), 'Reading your client roster')

  // No agent tool falls through to the generic "Working" row anymore.
  const allAgentTools = [
    'get_moment', 'get_time_chunks', 'get_day_overview', 'search_history', 'list_page_visits',
    'get_app_usage', 'get_week_summary', 'get_calendar_events', 'get_git_activity',
    'read_meeting_notes', 'get_attribution', 'list_clients', 'discover_repositories',
    'search_files', 'git', 'read_file', 'list_dir', 'create_artifact', 'export_week_excel',
    'capture_screen', 'run_command', 'ask_user', 'propose_memory', 'propose_correction',
    'undo_correction', 'forget_memory',
  ]
  for (const tool of allAgentTools) {
    assert.notEqual(statusForTool(tool, {}), 'Working', `${tool} needs a real trail phrase`)
  }
})

test('statusForTool never leaks secrets, prompts, or payloads riding in tool arguments', () => {
  const poison = {
    date: '2026-07-06',
    query: 'coursera',
    appName: 'Slack',
    incrementMinutes: 30,
    path: '/home/u/.aws/credentials',
    content: '-----BEGIN PRIVATE KEY-----',
    apiKey: 'sk-ant-leak-4f9c2d',
    systemPrompt: 'You are the Daylens system prompt',
    payload: '{"rows":[["secret-cell"]]}',
  }
  const tools = [
    'get_moment', 'get_time_chunks', 'get_day_overview', 'search_history', 'list_page_visits',
    'get_app_usage', 'get_week_summary', 'get_calendar_events', 'get_git_activity',
    'read_meeting_notes', 'export_week_excel', 'run_command', 'capture_screen',
    'discover_repositories', 'search_files', 'git',
    'read_file', 'list_dir', 'create_artifact', 'ask_user', 'propose_memory',
    'mcp_notion_search', 'some_future_tool',
  ]
  for (const tool of tools) {
    const label = statusForTool(tool, poison)
    assert.ok(label.length > 0, `${tool} produced an empty label`)
    for (const leak of ['sk-ant-leak-4f9c2d', '/home/u/.aws/credentials', 'PRIVATE KEY', 'system prompt', 'secret-cell']) {
      assert.ok(!label.includes(leak), `${tool} label leaked "${leak}": ${label}`)
    }
  }
})

test('the settle summary reads "Used N sources · M files" and counts match the inspector aggregation', () => {
  const toolTrace = [
    { tool: 'get_day_overview', input: { date: '2026-07-06' }, output: '{}' },
    { tool: 'search_history', input: { query: 'coursera' }, output: '{}' },
    { tool: 'search_history', input: { query: 'studying' }, output: '{}' },
    { tool: 'get_app_usage', input: { appName: 'Chrome' }, output: '{}' },
    { tool: 'read_file', input: { path: '/home/u/roadmap.md' }, output: '{}' },
    { tool: 'ask_user', input: { question: 'Which one?' }, output: '{}' },
  ]
  const agent = {
    toolTrace,
    fileDisclosures: [
      { path: '/home/u/roadmap.md' },
      { path: '/home/u/roadmap.md' },
    ],
    citations: [],
  }
  const summary = summarizeAgentTurn(agent)
  assert.ok(summary)
  // ask_user interacts with the person; it is consulted but not a source.
  assert.equal(summary.sourceCount, 4)
  assert.equal(summary.fileCount, 1)
  assert.equal(summary.label, 'Used 4 sources · 1 file')

  // Consistency with the inspector: the summary derives from the SAME
  // aggregation the inspector's tools-consulted list uses on the persisted
  // message, so their counts cannot disagree.
  const db = createProductionTestDatabase()
  try {
    const conversationId = db.prepare(`INSERT INTO ai_conversations (messages, created_at) VALUES ('[]', ?)`)
      .run(Date.now()).lastInsertRowid as number
    const messageId = db.prepare(`
      INSERT INTO ai_messages (conversation_id, role, content, created_at, metadata_json)
      VALUES (?, 'assistant', 'answer', ?, ?)
    `).run(conversationId, Date.now(), JSON.stringify({ agent: { toolTrace, stepCount: 6 } })).lastInsertRowid as number

    const inspectorTools = toolsConsultedForMessage(db, messageId)
    assert.deepEqual(summary.toolsConsulted, inspectorTools)
    assert.deepEqual(aggregateToolsConsulted(toolTrace), inspectorTools)
  } finally {
    db.close()
  }
})

test('summary label degrades honestly when the turn touched less', () => {
  assert.equal(summarizeAgentTurn(null), null)
  assert.equal(summarizeAgentTurn(undefined), null)

  const filesOnly = summarizeAgentTurn({ toolTrace: [], fileDisclosures: [{ path: '/a' }], citations: [] })
  assert.equal(filesOnly?.label, 'Used 1 file')

  const oneSource = summarizeAgentTurn({
    toolTrace: [{ tool: 'get_week_summary', input: {}, output: '{}' }],
    fileDisclosures: [],
    citations: [],
  })
  assert.equal(oneSource?.label, 'Used 1 source')

  const packetOnly = summarizeAgentTurn({
    toolTrace: [],
    fileDisclosures: [],
    citations: [{ marker: 1, identity: 'block:1', kind: 'day_fact', statement: 'x' }],
  })
  assert.equal(packetOnly?.label, 'Answered from your day record')

  const nothing = summarizeAgentTurn({ toolTrace: [], fileDisclosures: [], citations: [] })
  assert.equal(nothing?.label, '')
})
