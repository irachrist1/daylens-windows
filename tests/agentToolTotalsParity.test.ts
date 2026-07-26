// Issue #21, cause 3: the app-level and page-level agent tools must answer
// from the same corrected ledger, and when a browser's page detail is
// genuinely thinner than its verified app time, both tools (and the context
// packet) say so explicitly instead of handing the model two irreconcilable
// figures.
import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { setTestDb, clearTestDb } from './support/database-stub.mjs'
import { buildDaylensTools } from '../src/main/agent/daylensTools.ts'
import { buildContextPacket } from '../src/main/services/contextPacket.ts'

const DIA_BUNDLE = 'company.thebrowser.dia'
const DATE = '2026-07-15'

function localMs(hour: number, minute = 0): number {
  return new Date(2026, 6, 15, hour, minute, 0, 0).getTime()
}

function seedDiaSession(db: Database.Database, startMs: number, endMs: number): void {
  db.prepare(`
    INSERT INTO app_sessions (bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, canonical_app_id, app_instance_id,
      capture_source, capture_version)
    VALUES (?, 'Dia', ?, ?, ?, 'browsing', 0, NULL, 'Dia', 'dia', ?, 'test', 1)
  `).run(DIA_BUNDLE, startMs, endMs, Math.round((endMs - startMs) / 1000), DIA_BUNDLE)
}

function seedCourseraVisit(db: Database.Database, visitMs: number): void {
  db.prepare(`
    INSERT INTO website_visits (domain, page_title, url, visit_time, visit_time_us, duration_sec,
      browser_bundle_id, canonical_browser_id, source)
    VALUES ('coursera.org', 'Supervised ML | Coursera', 'https://www.coursera.org/learn/ml', ?, ?, 30, ?, 'dia', 'chrome_history')
  `).run(visitMs, visitMs * 1000, DIA_BUNDLE)
}

test('app tool and page tool report the same browser time when history corroborates the page', async () => {
  const db = createProductionTestDatabase()
  const foregroundSeconds = Math.round((localMs(12, 42) - localMs(9, 0)) / 1000)
  seedDiaSession(db, localMs(9, 0), localMs(12, 42))
  seedCourseraVisit(db, localMs(9, 0))

  const tools = buildDaylensTools(db)
  const appUsage = await (tools.get_app_usage as any).execute(
    { appName: 'Dia', startDate: DATE, endDate: DATE },
    {} as any,
  )
  const pageVisits = await (tools.list_page_visits as any).execute(
    { startDate: DATE, endDate: DATE },
    {} as any,
  )

  assert.equal(appUsage.totalSeconds, foregroundSeconds)
  assert.equal(pageVisits.found, true)
  const pageTotal = pageVisits.pages.reduce((sum: number, page: { totalSeconds: number }) => sum + page.totalSeconds, 0)
  assert.equal(pageTotal, foregroundSeconds, 'page-level total must reconcile with the app total')
  assert.equal(appUsage.coverageNotes, undefined, 'full coverage needs no note')
  assert.equal(pageVisits.coverageNotes, undefined)
  db.close()
})

test('both tools carry the same honest note when page detail is thinner than app time', async () => {
  const db = createProductionTestDatabase()
  // Dia foreground for 3h42m with NO page rows at all — the browser without
  // tab access whose history yielded nothing (the owner's morning).
  seedDiaSession(db, localMs(9, 0), localMs(12, 42))

  const tools = buildDaylensTools(db)
  const appUsage = await (tools.get_app_usage as any).execute(
    { appName: 'Dia', startDate: DATE, endDate: DATE },
    {} as any,
  )
  const pageVisits = await (tools.list_page_visits as any).execute(
    { startDate: DATE, endDate: DATE },
    {} as any,
  )

  assert.equal(appUsage.totalSeconds, Math.round((localMs(12, 42) - localMs(9, 0)) / 1000))
  assert.ok(Array.isArray(appUsage.coverageNotes) && appUsage.coverageNotes.length === 1)
  assert.match(appUsage.coverageNotes[0], /Dia was in front for 3h 42m/)
  assert.match(appUsage.coverageNotes[0], /specific pages are recorded for 0m/)
  // The note is copied into prose verbatim, so it must obey the voice contract.
  assert.doesNotMatch(appUsage.coverageNotes[0], /—|foreground|page-level/)

  assert.equal(pageVisits.found, false)
  assert.ok(Array.isArray(pageVisits.coverageNotes) && pageVisits.coverageNotes.length === 1)
  assert.equal(pageVisits.coverageNotes[0], appUsage.coverageNotes[0], 'one note, one story, both tools')
  db.close()
})

test('the context packet discloses the page-coverage shortfall as a conflict', async () => {
  const db = createProductionTestDatabase()
  setTestDb(db)
  try {
    seedDiaSession(db, localMs(9, 0), localMs(12, 42))

    const packet = await buildContextPacket(db, {
      purpose: 'answer',
      question: `how long was I on coursera on ${DATE}?`,
      destination: 'test:model',
      now: new Date(2026, 6, 15, 13, 0, 0, 0),
    })

    const conflict = packet.conflicts.find((entry) => entry.kind === 'page_detail_below_app_time')
    assert.ok(conflict, 'the shortfall must surface in the packet conflicts')
    assert.equal(conflict.resolvedBy, 'foreground_time')
    assert.match(conflict.detail, /Dia was in front for 3h 42m/)
    assert.equal(conflict.identity, `browser:dia:${DATE}`)
  } finally {
    clearTestDb()
    db.close()
  }
})
