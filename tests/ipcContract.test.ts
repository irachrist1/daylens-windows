// IPC contract — the main↔renderer seam that no unit test guards.
//
// The renderer can only reach the main process through channels exposed by the
// preload bridge (src/preload/index.ts) and answered by ipcMain.handle(...) in
// the main process. Every other test in this repo runs one side in isolation,
// so a renamed or missing channel — which silently breaks a whole feature in
// the real app — passes everything and ships. This test closes that gap:
//
//   1. Boot smoke + contract parity: register every importable handler group
//      against a recording ipcMain (this alone is a real boot smoke — the
//      registrations must not throw), collect the actual channel strings, add
//      the handful registered inline in index.ts / updater (which can't be
//      imported without booting the app), and assert the renderer never invokes
//      a channel nobody handles. Reading channels at runtime — rather than
//      grepping for them — means channel aliases (e.g. SEARCH_CHANNELS) resolve
//      to their true values, so the test fails only on a real wiring break.
//
//   2. Behavioural smoke: call the core db/search/focus handlers over a seeded
//      real-world DB and assert real response shapes — exercising the full
//      IPC → service → query → DB path the renderer actually depends on.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC } from '../src/shared/types.ts'
import { ipcRecord } from './support/electron-stub.mjs'
import { setTestDb } from './support/database-stub.mjs'
import { setupRealWorldDb, REAL_WORLD_DATE, localMs } from './support/realWorldActivityFixture.ts'
import { registerDbHandlers } from '../src/main/ipc/db.handlers.ts'
import { registerErrorHandlers } from '../src/main/ipc/errors.handlers.ts'
import { registerDebugHandlers } from '../src/main/ipc/debug.handlers.ts'
import { registerFocusHandlers } from '../src/main/ipc/focus.handlers.ts'
import { registerAIHandlers } from '../src/main/ipc/ai.handlers.ts'
import { registerSettingsHandlers } from '../src/main/ipc/settings.handlers.ts'
import { registerBillingHandlers } from '../src/main/ipc/billing.handlers.ts'
import { registerIntercomHandlers } from '../src/main/ipc/intercom.handlers.ts'
import { registerNotificationHandlers } from '../src/main/ipc/notifications.handlers.ts'
import { registerSearchHandlers } from '../src/main/ipc/search.handlers.ts'
import { registerSyncHandlers } from '../src/main/ipc/sync.handlers.ts'
import { registerDistractionAlerterHandlers } from '../src/main/services/distractionAlerter.ts'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// These run on app.whenReady() inside index.ts and can't be imported without
// booting the app, so the renderer-facing ones are grepped from source instead.
const REGISTER_FNS: Array<[string, () => void]> = [
  ['db', registerDbHandlers],
  ['errors', registerErrorHandlers],
  ['debug', registerDebugHandlers],
  ['focus', registerFocusHandlers],
  ['ai', registerAIHandlers],
  ['settings', registerSettingsHandlers],
  ['billing', registerBillingHandlers],
  ['intercom', registerIntercomHandlers],
  ['notifications', registerNotificationHandlers],
  ['search', registerSearchHandlers],
  ['sync', registerSyncHandlers],
  ['distractionAlerter', registerDistractionAlerterHandlers],
]

// A seeded DB stays configured for the whole file so any background sweep a
// handler module schedules on import (e.g. aiService) finds a real DB instead
// of logging noise. The runner gives each file its own process, so this never
// leaks into another test.
const sharedDb = setupRealWorldDb()
setTestDb(sharedDb)

// Resolve a channel expression captured from source — an `IPC.GROUP.NAME`
// reference (looked up in the real registry) or a quoted string literal — to its
// concrete channel string. Returns null for anything dynamic we can't resolve.
function resolveChannel(token: string): string | null {
  const trimmed = token.trim()
  const literal = trimmed.match(/^['"`](.*)['"`]$/)
  if (literal) return literal[1]
  if (trimmed.startsWith('IPC.')) {
    let cursor: unknown = IPC
    for (const part of trimmed.split('.').slice(1)) {
      cursor = (cursor as Record<string, unknown> | undefined)?.[part]
    }
    return typeof cursor === 'string' ? cursor : null
  }
  return null
}

function channelsMatching(source: string, pattern: RegExp): string[] {
  const out: string[] = []
  for (const match of source.matchAll(pattern)) {
    const channel = resolveChannel(match[1])
    if (channel) out.push(channel)
  }
  return out
}

test('boot smoke: every handler group registers without throwing', () => {
  ipcRecord.reset()
  for (const [name, register] of REGISTER_FNS) {
    assert.doesNotThrow(register, `${name} handlers failed to register`)
  }
  assert.ok(ipcRecord.handlers.size > 40, `expected many registered channels, got ${ipcRecord.handlers.size}`)
})

test('contract: every channel the renderer invokes has a handler in the main process', () => {
  // Handled channels: the runtime registrations above (true channel strings,
  // alias-safe) plus the few registered inline in index.ts / updater.ts.
  const handled = new Set<string>(ipcRecord.handlers.keys())
  for (const rel of ['src/main/index.ts', 'src/main/services/updater.ts']) {
    const source = fs.readFileSync(path.join(projectRoot, rel), 'utf8')
    for (const channel of channelsMatching(source, /ipcMain\.handle(?:Once)?\(\s*([^,)\n]+)/g)) {
      handled.add(channel)
    }
  }

  // Invoked channels: everything the preload bridge can call.
  const preloadSource = fs.readFileSync(path.join(projectRoot, 'src/preload/index.ts'), 'utf8')
  const invoked = new Set(channelsMatching(preloadSource, /ipcRenderer\.invoke\(\s*([^,)\n]+)/g))
  assert.ok(invoked.size > 30, `expected the preload bridge to invoke many channels, found ${invoked.size}`)

  const missing = [...invoked].filter((channel) => !handled.has(channel)).sort()
  assert.deepEqual(
    missing,
    [],
    `the renderer invokes ${missing.length} channel(s) with no ipcMain.handle: ${missing.join(', ')}`,
  )
})

test('behaviour: core handlers answer over a seeded real-world DB', async () => {
  const call = async (channel: string, ...args: unknown[]) => {
    const handler = ipcRecord.handlers.get(channel)
    assert.ok(handler, `no handler registered for ${channel}`)
    return handler({} as never, ...args)
  }

  // Timeline day: the renderer's primary read. Comes back as the seeded day
  // with reconstructed blocks and tracked time.
  const day = await call(IPC.DB.GET_TIMELINE_DAY, REAL_WORLD_DATE)
  assert.equal(day.date, REAL_WORLD_DATE)
  assert.ok(Array.isArray(day.blocks) && day.blocks.length > 0, 'timeline day should have reconstructed blocks')
  assert.ok(day.totalSeconds > 0, 'timeline day should report tracked time')

  // App summaries for the day: drives the apps view.
  const apps = await call(IPC.DB.GET_APP_SUMMARIES_FOR_DATE, REAL_WORLD_DATE)
  assert.ok(Array.isArray(apps) && apps.length > 0, 'app summaries should be non-empty')
  assert.ok(apps.every((a: { appName?: unknown }) => typeof a.appName === 'string'), 'each app summary needs an appName')

  // Recap range: drives the multi-day recap. Same payload shape as a single day.
  const recap = await call(IPC.DB.GET_RECAP_RANGE, [REAL_WORLD_DATE])
  assert.ok(Array.isArray(recap) && recap.length === 1, 'recap range should return one payload per date')
  assert.equal(recap[0].date, REAL_WORLD_DATE)

  // Search over the day: window-title match returns the coding session. Search
  // channels live in their own SEARCH_CHANNELS constant, not the IPC registry,
  // and the preload bridge invokes them as literals — call the same literal.
  const results = await call('search:all', { query: 'timeline', opts: { startDate: REAL_WORLD_DATE, endDate: REAL_WORLD_DATE, limit: 10 } })
  assert.ok(Array.isArray(results) && results.some((r: { type?: unknown }) => r.type === 'session'), 'search should find the coding session')

  // Focus range query: drives the focus surface. Returns the day's sessions.
  const from = localMs(REAL_WORLD_DATE, 0)
  const sessions = await call(IPC.FOCUS.GET_BY_DATE_RANGE, from, from + 86_400_000)
  assert.ok(Array.isArray(sessions), 'focus range query should return an array of sessions')
})
