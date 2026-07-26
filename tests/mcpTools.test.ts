// MCP tool results must cross the SAME two privacy boundaries as every
// built-in tool result before they return toward the model: the
// tracking-exclusion filter and the secret sanitizer. An external server's
// output never enters the loop raw.
import test from 'node:test'
import assert from 'node:assert/strict'
import type { ToolSet } from 'ai'
import { __resetSettings, __setSettings } from './support/settings-stub.mjs'
import { guardMcpToolResult, wrapMcpToolsWithGuards } from '../src/main/agent/mcpTools.ts'

test.beforeEach(() => {
  __resetSettings()
})

test('guardMcpToolResult strips secrets from every string field, nested included', () => {
  const guarded = guardMcpToolResult({
    summary: 'the deploy token is sk-ant-api03-abcdefghijklmnopqrstuvwx',
    nested: {
      rows: ['a slack token xoxb-1234567890-abcdefghij rides along', 'plain text stays'],
    },
  }) as { summary: string; nested: { rows: string[] } }
  assert.ok(!guarded.summary.includes('sk-ant-'), 'API keys never reach the model')
  assert.ok(!guarded.nested.rows[0].includes('xoxb-'), 'nested strings are sanitized too')
  assert.equal(guarded.nested.rows[1], 'plain text stays')
})

test('guardMcpToolResult drops records for tracking-excluded apps', () => {
  __setSettings({ trackingControlsEnabled: true, trackingExcludedApps: ['Signal'] })
  const guarded = guardMcpToolResult({
    items: [
      { appName: 'Signal', note: 'private conversation' },
      { appName: 'Terminal', note: 'build log' },
    ],
  }) as { items: Array<{ appName: string }> }
  assert.equal(guarded.items.length, 1, 'the excluded app record is dropped')
  assert.equal(guarded.items[0].appName, 'Terminal')
})

test('wrapMcpToolsWithGuards guards each tool execute() and leaves execute-less defs untouched', async () => {
  __setSettings({ trackingControlsEnabled: true, trackingExcludedApps: ['Signal'] })
  const seen: unknown[] = []
  const tools = {
    fetch_stuff: {
      description: 'a fake MCP tool',
      execute: async (input: unknown) => {
        seen.push(input)
        return {
          token: 'a github pat ghp_abcdefghijklmnopqrstuvwxyz012345 leaked',
          sessions: [{ appName: 'Signal', title: 'do not ship' }, { appName: 'Notes', title: 'fine' }],
        }
      },
    },
    schema_only: { description: 'no execute' },
  } as unknown as ToolSet

  const wrapped = wrapMcpToolsWithGuards(tools)
  assert.equal(wrapped.schema_only, tools.schema_only, 'defs without execute pass through')

  const result = await (wrapped.fetch_stuff as any).execute({ q: 'x' }, {}) as {
    token: string
    sessions: Array<{ appName: string }>
  }
  assert.deepEqual(seen, [{ q: 'x' }], 'the original execute still receives its input')
  assert.ok(!result.token.includes('ghp_'), 'secrets are sanitized on the way out')
  assert.equal(result.sessions.length, 1, 'excluded-app records are filtered')
  assert.equal(result.sessions[0].appName, 'Notes')
})
