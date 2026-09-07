// Issue #21, cause 4: the week Excel export is computed, not typed by the
// model. The workbook's numbers must equal the canonical weekly query — the
// same corrected day payloads the Timeline renders — and the by-app sheet
// must total to exactly the same week figure as the summary sheet.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import {
  collectWeeklyExportData,
  mondayOf,
  weeklyExportFilename,
  writeWeeklyWorkbook,
} from '../src/main/services/weeklyExport.ts'
import { getTimelineDayPayload } from '../src/main/services/workBlocks.ts'

function localMs(day: number, hour: number, minute = 0): number {
  return new Date(2026, 6, day, hour, minute, 0, 0).getTime()
}

function seedSession(
  db: Database.Database,
  bundleId: string,
  appName: string,
  category: string,
  startMs: number,
  endMs: number,
): void {
  db.prepare(`
    INSERT INTO app_sessions (bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, canonical_app_id, app_instance_id,
      capture_source, capture_version)
    VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, 'test', 1)
  `).run(
    bundleId, appName, startMs, endMs, Math.round((endMs - startMs) / 1000),
    category, appName, appName.toLowerCase(), bundleId,
  )
}

function seedWeek(db: Database.Database): void {
  // Monday: a long Cursor block and some Dia.
  seedSession(db, 'com.todesktop.230313mzl4w4u92', 'Cursor', 'development', localMs(13, 9), localMs(13, 13))
  seedSession(db, 'company.thebrowser.dia', 'Dia', 'browsing', localMs(13, 14), localMs(13, 16))
  // Wednesday: Notion.
  seedSession(db, 'notion.id', 'Notion', 'writing', localMs(15, 10), localMs(15, 12, 30))
  // Saturday: a short Dia sitting.
  seedSession(db, 'company.thebrowser.dia', 'Dia', 'browsing', localMs(18, 11), localMs(18, 11, 45))
}

test('mondayOf snaps any weekday to that week\'s Monday', () => {
  assert.equal(mondayOf('2026-07-13'), '2026-07-13')
  assert.equal(mondayOf('2026-07-15'), '2026-07-13')
  assert.equal(mondayOf('2026-07-19'), '2026-07-13')
})

test('the weekly export data equals the canonical per-day Timeline totals', () => {
  const db = createProductionTestDatabase()
  seedWeek(db)

  const data = collectWeeklyExportData(db, '2026-07-15')
  assert.equal(data.weekStart, '2026-07-13')
  assert.equal(data.weekEnd, '2026-07-19')

  let expectedTotal = 0
  for (let day = 13; day <= 19; day++) {
    const payload = getTimelineDayPayload(db, `2026-07-${day}`, null)
    expectedTotal += Math.round(payload.totalSeconds)
    const exportDay = data.days.find((entry) => entry.date === `2026-07-${day}`)
    assert.ok(exportDay)
    assert.equal(exportDay.activeSeconds, Math.round(payload.totalSeconds), `day total must match Timeline for 2026-07-${day}`)
  }
  assert.equal(data.totalSeconds, expectedTotal)
  assert.ok(data.totalSeconds > 0, 'the fixture week must have tracked time')

  // The by-app rollup reconciles exactly to the same week total.
  const appSum = data.apps.reduce((sum, app) => sum + app.seconds, 0)
  assert.equal(appSum, data.totalSeconds)
  assert.ok(data.apps.some((app) => app.appName === 'Cursor'))
  assert.ok(data.apps.some((app) => app.appName === 'Dia'))
  db.close()
})

test('the workbook on disk carries the same totals on both sheets', async () => {
  const db = createProductionTestDatabase()
  seedWeek(db)
  const data = collectWeeklyExportData(db, '2026-07-13')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-week-'))
  const filename = weeklyExportFilename(data.weekStart)
  assert.equal(filename, 'Daylens-week-2026-07-13-to-19.xlsx')
  const filePath = path.join(dir, filename)
  await writeWeeklyWorkbook(data, filePath)

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filePath)

  const summary = workbook.getWorksheet('Week summary')
  assert.ok(summary)
  assert.equal(summary.getRow(1).getCell(1).value, 'Day')
  assert.equal(summary.getRow(1).getCell(6).value, 'Project/client')
  assert.equal(summary.getRow(1).getCell(7).value, 'Notes')
  // Header + 7 day rows + totals row.
  assert.equal(summary.actualRowCount, 9)
  const totalsRow = summary.getRow(9)
  assert.equal(totalsRow.getCell(1).value, 'Week')

  const formatTotal = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.round((seconds % 3600) / 60)
    return hours === 0 ? `${minutes}m` : `${hours}h ${String(minutes).padStart(2, '0')}m`
  }
  assert.equal(totalsRow.getCell(3).value, formatTotal(data.totalSeconds))

  const byApp = workbook.getWorksheet('By app')
  assert.ok(byApp)
  const lastRow = byApp.getRow(byApp.actualRowCount)
  assert.equal(lastRow.getCell(1).value, 'Week total')
  assert.equal(lastRow.getCell(2).value, formatTotal(data.totalSeconds), 'sheet 2 total must equal sheet 1 week total')

  fs.rmSync(dir, { recursive: true, force: true })
  db.close()
})
