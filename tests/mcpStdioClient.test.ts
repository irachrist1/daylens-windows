// The Daylens MCP server as an external client actually meets it: a real stdio
// handshake against the real subprocess, launched exactly the way the Settings
// snippet tells a client to launch it.
//
// Everything else in the MCP suite calls the dispatcher in-process, which cannot
// catch a broken loader path, a module the subprocess cannot resolve, a startup
// throw, or a manifest that fails MCP schema validation. Those are the failures
// a person meets as "Daylens is not responding" in Claude Desktop.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATE = '2026-07-15'

function localMs(hour: number, minute = 0): number {
  return new Date(2026, 6, 15, hour, minute, 0, 0).getTime()
}

function seed(db: Database.Database): void {
  db.prepare(`
    INSERT INTO app_sessions (bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, canonical_app_id, app_instance_id,
      capture_source, capture_version)
    VALUES ('company.thebrowser.dia', 'Dia', ?, ?, ?, 'browsing', 0, 'Supervised ML', 'Dia', 'dia', 'company.thebrowser.dia', 'test', 1)
  `).run(localMs(9, 0), localMs(11, 0), 7_200)
  db.prepare(`
    INSERT INTO website_visits (domain, page_title, url, visit_time, visit_time_us, duration_sec,
      browser_bundle_id, canonical_browser_id, source)
    VALUES ('coursera.org', 'Supervised ML | Coursera', 'https://www.coursera.org/learn/ml', ?, ?, 3600, 'company.thebrowser.dia', 'dia', 'chrome_history')
  `).run(localMs(9, 0), localMs(9, 0) * 1000)
}

function stagedDatabase(): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-mcp-stdio-'))
  const dbPath = path.join(dir, 'daylens.sqlite')
  const db = createProductionTestDatabase(dbPath)
  seed(db)
  db.close()
  return { dir, dbPath }
}

async function connect(dbPath: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '--loader',
      `file://${path.join(projectRoot, 'packages', 'mcp-server', 'loader.mjs')}`,
      path.join(projectRoot, 'packages', 'mcp-server', 'src', 'index.ts'),
    ],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      DAYLENS_DB_PATH: dbPath,
      DAYLENS_TRACKING_CONTROLS_ENABLED: '0',
      DAYLENS_TRACKING_EXCLUDED_APPS: '[]',
      DAYLENS_TRACKING_EXCLUDED_SITES: '[]',
    },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'daylens-stdio-test', version: '1.0.0' })
  await client.connect(transport)
  return { client, close: async () => { await client.close() } }
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('')
}

test('an external client lists the read surface and calls it over stdio', async () => {
  const { dir, dbPath } = stagedDatabase()
  const { client, close } = await connect(dbPath)
  try {
    const listed = await client.listTools()
    const names = listed.tools.map((tool) => tool.name)
    assert.ok(names.includes('getDaySummary'), 'the day summary must be reachable from a real client')
    assert.ok(names.includes('getMoment'), 'the moment reader is part of the canonical surface')
    assert.ok(names.includes('listPageVisits'))
    assert.ok(names.includes('describeReadSurface'))

    const summary = await client.callTool({ name: 'getDaySummary', arguments: { date: DATE } })
    const parsed = JSON.parse(textOf(summary as { content: Array<{ type: string; text?: string }> }))
    assert.equal(parsed.date, DATE)

    // A tool that carries real numbers, so the wire is proved to move data and
    // not just a well-formed empty shell.
    const usage = await client.callTool({
      name: 'getAppUsage',
      arguments: { appName: 'Dia', startDate: DATE, endDate: DATE },
    })
    const usageResult = JSON.parse(textOf(usage as { content: Array<{ type: string; text?: string }> }))
    assert.equal(usageResult.totalSeconds, 7_200)

    const pages = await client.callTool({
      name: 'listPageVisits',
      arguments: { startDate: DATE, endDate: DATE },
    })
    const pageResult = JSON.parse(textOf(pages as { content: Array<{ type: string; text?: string }> }))
    assert.equal(pageResult.found, true)
    assert.equal(pageResult.pages[0].domain, 'coursera.org')
  } finally {
    await close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an external client is told why an unavailable capability is unavailable', async () => {
  const { dir, dbPath } = stagedDatabase()
  const { client, close } = await connect(dbPath)
  try {
    const described = await client.callTool({ name: 'describeReadSurface', arguments: {} })
    const report = JSON.parse(textOf(described as { content: Array<{ type: string; text?: string }> }))
    const gap = report.unavailable.find((entry: { id: string }) => entry.id === 'getTimeChunks')
    assert.ok(gap, 'the surface description must name the gap rather than omit it')
    assert.match(gap.reason, /getMoment/)

    const denied = await client.callTool({ name: 'getTimeChunks', arguments: { date: DATE, incrementMinutes: 30 } })
    assert.equal((denied as { isError?: boolean }).isError, true)
    assert.match(textOf(denied as { content: Array<{ type: string; text?: string }> }), /not available/)
  } finally {
    await close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
