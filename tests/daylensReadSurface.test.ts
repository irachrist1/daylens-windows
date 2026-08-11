// WO-15 / REQ-MCP-007: one canonical Daylens read surface.
//
// The catalogue in src/main/services/daylensReadSurface.ts is only worth having
// if it cannot drift from the two surfaces it describes. These tests fail in
// both directions: when an executor or the chat tool set gains or loses a tool
// without a matching catalogue entry, and when the catalogue claims a tool that
// no surface actually publishes. A capability that a path cannot serve must say
// why — silence is the failure mode this whole work order exists to remove.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { buildDaylensTools } from '../src/main/agent/daylensTools.ts'
import { buildContextTools } from '../src/main/agent/contextTools.ts'
import { WRAPPED_TOOL_NAMES } from '../src/main/services/wrappedTools.ts'
import {
  DAYLENS_READ_CAPABILITIES,
  EXECUTOR_TOOL_IDS,
  capabilitiesForPath,
  capabilityByToolName,
  isPublished,
  readSurfaceReport,
  unavailableForPath,
} from '../src/main/services/daylensReadSurface.ts'
import { mcpToolManifest } from '../packages/mcp-server/src/tools.ts'
import { DESCRIBE_READ_SURFACE_TOOL, describeMcpReadSurface } from '../packages/mcp-server/src/dispatch.ts'

function chatToolNames(): string[] {
  const db = createProductionTestDatabase()
  try {
    return [...Object.keys(buildDaylensTools(db)), ...Object.keys(buildContextTools(db))].sort()
  } finally {
    db.close()
  }
}

test('every executor tool name is declared as a capability', () => {
  const declared = new Set(DAYLENS_READ_CAPABILITIES.map((capability) => capability.id))
  for (const name of Object.keys(EXECUTOR_TOOL_IDS)) {
    assert.ok(
      declared.has(name),
      `${name} is dispatched by an executor but is not declared in DAYLENS_READ_CAPABILITIES. `
      + 'Declare it with a per-path status before either surface publishes it.',
    )
  }
  // The wrapped union is the one that changes most often; assert it explicitly
  // rather than relying on the record above staying in step with it.
  for (const name of WRAPPED_TOOL_NAMES) {
    const capability = DAYLENS_READ_CAPABILITIES.find((entry) => entry.id === name)
    assert.ok(capability, `wrapped tool ${name} has no capability declaration`)
    assert.equal(capability.executor, 'wrapped', `${name} is a wrapped tool but is declared as ${capability.executor}`)
  }
})

test('capability ids are unique and every capability is published somewhere', () => {
  const seen = new Set<string>()
  for (const capability of DAYLENS_READ_CAPABILITIES) {
    assert.ok(!seen.has(capability.id), `duplicate capability id ${capability.id}`)
    seen.add(capability.id)
    const published = isPublished(capability.paths.mcp) || isPublished(capability.paths.chat)
    assert.ok(published, `${capability.id} is unavailable on every path, so it is not a capability`)
  }
})

test('every unavailable path carries a usable reason', () => {
  for (const path of ['mcp', 'chat'] as const) {
    for (const entry of unavailableForPath(path)) {
      assert.ok(
        entry.reason.trim().length > 20,
        `${entry.id} is unavailable on ${path} without explaining why`,
      )
    }
  }
})

test('the chat tool set and the catalogue agree in both directions', () => {
  const chatTools = chatToolNames()
  const claimed = capabilitiesForPath('chat').map((capability) => {
    const status = capability.paths.chat
    return isPublished(status) ? status.toolName : ''
  })

  for (const toolName of claimed) {
    assert.ok(
      chatTools.includes(toolName),
      `the catalogue publishes ${toolName} on the chat path but the chat tool set has no such tool`,
    )
  }
  for (const toolName of chatTools) {
    assert.ok(
      claimed.includes(toolName),
      `the chat tool set publishes ${toolName} with no capability declaration. `
      + 'Adding a tool to one surface requires one compatibility review: declare it in '
      + 'src/main/services/daylensReadSurface.ts with its status on the MCP path.',
    )
  }
})

test('the MCP manifest is exactly the catalogue projection plus the surface description', () => {
  const manifest = mcpToolManifest().map((tool) => tool.name).sort()
  const expected = [
    ...capabilitiesForPath('mcp').map((capability) => {
      const status = capability.paths.mcp
      return isPublished(status) ? status.toolName : ''
    }),
    DESCRIBE_READ_SURFACE_TOOL,
  ].sort()
  assert.deepEqual(manifest, expected)

  for (const tool of mcpToolManifest()) {
    assert.ok(tool.description.length > 40, `${tool.name} needs a description a model can route on`)
    assert.equal(tool.input_schema.type, 'object')
  }
})

test('describeReadSurface names every capability this path cannot serve', () => {
  const report = describeMcpReadSurface()
  assert.equal(report.path, 'mcp')

  const unavailable = unavailableForPath('mcp')
  assert.ok(unavailable.length > 0, 'the fixture for this test is the real gap list; it should not be empty')
  assert.deepEqual(
    report.unavailable.map((entry) => entry.id).sort(),
    unavailable.map((entry) => entry.id).sort(),
  )
  for (const entry of report.unavailable) {
    assert.ok(entry.reason.length > 0)
  }

  // Every published capability is reachable by the name it is published under.
  for (const entry of report.available) {
    assert.ok(capabilityByToolName('mcp', entry.toolName), `${entry.toolName} is reported but not resolvable`)
  }
})

test('the chat surface report is derivable from the same catalogue', () => {
  const report = readSurfaceReport('chat')
  assert.equal(report.path, 'chat')
  assert.equal(report.available.length, capabilitiesForPath('chat').length)
  assert.equal(report.available.length + report.unavailable.length, DAYLENS_READ_CAPABILITIES.length)
})
