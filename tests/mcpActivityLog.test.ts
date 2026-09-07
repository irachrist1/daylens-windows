import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  mcpActivityLogPath,
  parseMcpActivityLine,
  readMcpActivity,
  recordMcpActivity,
  stripSecrets,
} from '../src/shared/mcpActivityLog.ts'

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('mcpActivityLogPath sits next to the database', () => {
  assert.equal(
    mcpActivityLogPath('/Users/alex/Library/Application Support/Daylens Desktop/daylens.sqlite'),
    '/Users/alex/Library/Application Support/Daylens Desktop/mcp-activity.jsonl',
  )
})

test('recordMcpActivity appends one JSON line and readMcpActivity returns it', () => {
  const dir = tempDir('daylens-mcp-activity-')
  const logPath = path.join(dir, 'mcp-activity.jsonl')
  recordMcpActivity(logPath, {
    tool: 'getDaySummary',
    arguments: { date: '2026-07-15' },
    ok: true,
    timestamp: '2026-07-15T12:00:00.000Z',
  })
  recordMcpActivity(logPath, {
    tool: 'getTimeChunks',
    arguments: { date: '2026-07-15' },
    ok: false,
    error: 'getTimeChunks is not available through the Daylens MCP server.',
    timestamp: '2026-07-15T12:00:01.000Z',
  })

  const entries = readMcpActivity(logPath)
  assert.equal(entries.length, 2)
  assert.equal(entries[0]?.tool, 'getDaySummary')
  assert.equal(entries[0]?.ok, true)
  assert.deepEqual(entries[0]?.arguments, { date: '2026-07-15' })
  assert.equal(entries[0]?.error, undefined)
  assert.equal(entries[1]?.tool, 'getTimeChunks')
  assert.equal(entries[1]?.ok, false)
  assert.match(entries[1]?.error ?? '', /not available/)

  const raw = fs.readFileSync(logPath, 'utf8')
  assert.ok(!raw.includes('"result"'))
  assert.equal(raw.trim().split('\n').length, 2)
})

test('readMcpActivity returns [] when the sidecar is missing', () => {
  const dir = tempDir('daylens-mcp-activity-missing-')
  assert.deepEqual(readMcpActivity(path.join(dir, 'mcp-activity.jsonl')), [])
})

test('readMcpActivity skips malformed lines and keeps valid ones', () => {
  const dir = tempDir('daylens-mcp-activity-malformed-')
  const logPath = path.join(dir, 'mcp-activity.jsonl')
  fs.writeFileSync(logPath, [
    '{ this is not json',
    JSON.stringify({ tool: 'getDaySummary', timestamp: '2026-07-15T12:00:00.000Z', arguments: { date: '2026-07-15' }, ok: true }),
    '',
    JSON.stringify({ timestamp: '2026-07-15T12:00:01.000Z', ok: true }),
  ].join('\n'))

  const entries = readMcpActivity(logPath)
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.tool, 'getDaySummary')
})

test('parseMcpActivityLine rejects empty or incomplete rows', () => {
  assert.equal(parseMcpActivityLine(''), null)
  assert.equal(parseMcpActivityLine('{"ok":true}'), null)
  assert.ok(parseMcpActivityLine(JSON.stringify({ tool: 'getDaySummary', ok: true })))
})

test('stripSecrets redacts secret keys and credential-shaped values', () => {
  const stripped = stripSecrets({
    date: '2026-07-15',
    apiKey: 'sk-ant-secret-value-should-not-leak',
    nested: {
      authorization: 'Bearer abc',
      note: 'plain text',
    },
    token: 'lin_api_abcdefghij',
  }) as Record<string, unknown>
  const nested = stripped.nested as Record<string, unknown>
  assert.equal(stripped.date, '2026-07-15')
  assert.equal(stripped.apiKey, '[redacted]')
  assert.equal(stripped.token, '[redacted]')
  assert.equal(nested.authorization, '[redacted]')
  assert.equal(nested.note, 'plain text')

  const recordedDir = tempDir('daylens-mcp-activity-secret-')
  const logPath = path.join(recordedDir, 'mcp-activity.jsonl')
  recordMcpActivity(logPath, {
    tool: 'custom',
    arguments: { api_key: 'sk-abcdefghijklmnopqrstuvwxyz012345', date: '2026-07-15' },
    ok: true,
  })
  const raw = fs.readFileSync(logPath, 'utf8')
  assert.ok(!raw.includes('sk-abcdefghijklmnopqrstuvwxyz012345'))
  assert.ok(raw.includes('[redacted]'))
  assert.ok(raw.includes('2026-07-15'))
})

test('concurrent appends keep one complete JSON object per line', () => {
  const dir = tempDir('daylens-mcp-activity-concurrent-')
  const logPath = path.join(dir, 'mcp-activity.jsonl')
  for (let i = 0; i < 20; i++) {
    recordMcpActivity(logPath, {
      tool: `tool-${i}`,
      arguments: { i },
      ok: true,
      timestamp: `2026-07-15T12:00:${String(i).padStart(2, '0')}.000Z`,
    })
  }
  const entries = readMcpActivity(logPath)
  assert.equal(entries.length, 20)
  assert.deepEqual(new Set(entries.map((entry) => entry.tool)).size, 20)
})
