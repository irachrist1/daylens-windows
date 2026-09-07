// The deterministic week Excel export. The workbook is computed here, from the
// same corrected day payloads the Timeline renders — the model never types the
// numbers. Sheet 1 is the per-day week summary with a totals row; sheet 2 is
// the by-app rollup whose total equals sheet 1's week total by construction.
import { createRequire } from 'node:module'
import type ExcelJS from 'exceljs'
import type Database from 'better-sqlite3'
import { blockActiveSeconds } from '@shared/blockDuration'
import type { DayTimelinePayload, TimelineGapSegment } from '@shared/types'
import { localDateString } from '../lib/localDate'
import { getTimelineDayPayload, userVisibleLabelForBlock } from './workBlocks'



const nodeRequire = createRequire(__filename)

// exceljs is the heaviest module in the main process (~170ms of require) and
// it is only ever needed when someone exports a workbook. Load it then.
let excelJsModule: typeof import('exceljs') | null = null
function excelJs(): typeof import('exceljs') {
  if (!excelJsModule) {
    excelJsModule = nodeRequire('exceljs') as typeof import('exceljs')
  }
  return excelJsModule
}

export interface WeeklyExportDay {
  date: string
  weekday: string
  activeSeconds: number
  topApps: { appName: string; seconds: number }[]
  topSites: { domain: string; seconds: number }[]
  projects: string[]
  notes: string
  gaps: { kind: string; seconds: number }[]
}

export interface WeeklyExportData {
  weekStart: string
  weekEnd: string
  totalSeconds: number
  days: WeeklyExportDay[]
  apps: { appName: string; seconds: number }[]
}

const DAY_MS = 24 * 60 * 60 * 1000
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MIN_GAP_REPORT_SEC = 5 * 60

function dayStart(date: string): Date {
  return new Date(`${date}T00:00:00`)
}

/** Snap any date in the target week to that week's Monday. */
export function mondayOf(date: string): string {
  const parsed = dayStart(date)
  const offset = (parsed.getDay() + 6) % 7
  return localDateString(new Date(parsed.getTime() - offset * DAY_MS))
}

export function weeklyExportFilename(weekStart: string, weekEnd = weekEndFromMonday(weekStart)): string {
  const endDay = weekEnd.slice(8)
  return `Daylens-week-${weekStart}-to-${endDay}.xlsx`
}

function weekEndFromMonday(weekStart: string): string {
  return localDateString(new Date(dayStart(weekStart).getTime() + 6 * DAY_MS))
}

function dayProjects(payload: DayTimelinePayload): string[] {
  return (payload.dayEntities ?? [])
    .filter((entity) => entity.type === 'project' || entity.type === 'client')
    .sort((left, right) => right.seconds - left.seconds)
    .map((entity) => entity.name)
    .filter((name) => name.trim().length > 0)
    .slice(0, 3)
}

function dayNotes(payload: DayTimelinePayload): string {
  const labels = payload.blocks
    .map((block) => userVisibleLabelForBlock(block))
    .filter((label) => label.trim().length > 0)
    .filter((label, index, all) => all.findIndex((other) => other.toLowerCase() === label.toLowerCase()) === index)
    .slice(0, 3)
  return labels.join(' · ')
}

function formatHoursMinutes(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.round((total % 3600) / 60)
  if (hours === 0) return `${minutes}m`
  return `${hours}h ${String(minutes).padStart(2, '0')}m`
}

const GAP_LABELS: Record<string, string> = {
  idle_gap: 'idle',
  away: 'away',
  machine_off: 'off',
  asleep: 'asleep',
  locked: 'locked',
  idle: 'idle',
  passive: 'passive',
  paused: 'paused',
  untracked: 'untracked',
}

export function collectWeeklyExportData(db: Database.Database, weekStartDate: string): WeeklyExportData {
  const weekStart = mondayOf(weekStartDate)
  const weekStartMs = dayStart(weekStart).getTime()
  const weekEnd = localDateString(new Date(weekStartMs + 6 * DAY_MS))

  const days: WeeklyExportDay[] = []
  // Fractional per-app milliseconds accumulate across the week and round once
  // at the end, so the by-app sheet can reconcile to the week total exactly.
  const weekAppMs = new Map<string, number>()
  let totalSeconds = 0

  for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
    const dateMs = weekStartMs + dayIndex * DAY_MS
    const date = localDateString(new Date(dateMs))
    const payload = getTimelineDayPayload(db, date, null)
    const dayActiveSeconds = Math.round(payload.totalSeconds)
    totalSeconds += dayActiveSeconds

    // Per-app seconds from the same block partition the day total counts.
    // blockActiveSeconds clamps a block's summed sessions to its wall span,
    // so session contributions are scaled into the clamped figure — the app
    // rollup then sums to the day total instead of overshooting it.
    const dayAppMs = new Map<string, number>()
    for (const block of payload.blocks) {
      const activeMs = blockActiveSeconds(block) * 1000
      const sessions = block.sessions ?? []
      const summedMs = sessions.reduce((sum, session) => sum + Math.max(0, session.durationSeconds) * 1000, 0)
      if (summedMs > 0) {
        const scale = activeMs / summedMs
        for (const session of sessions) {
          const appMs = Math.max(0, session.durationSeconds) * 1000 * scale
          dayAppMs.set(session.appName, (dayAppMs.get(session.appName) ?? 0) + appMs)
        }
      } else if (block.topApps.length > 0) {
        const appShareMs = activeMs / block.topApps.length
        for (const app of block.topApps) {
          dayAppMs.set(app.appName, (dayAppMs.get(app.appName) ?? 0) + appShareMs)
        }
      } else {
        dayAppMs.set('No app recorded', (dayAppMs.get('No app recorded') ?? 0) + activeMs)
      }
    }
    for (const [appName, ms] of dayAppMs) {
      weekAppMs.set(appName, (weekAppMs.get(appName) ?? 0) + ms)
    }

    const gapSeconds = new Map<string, number>()
    for (const segment of payload.segments) {
      if (segment.kind === 'work_block') continue
      const gap = segment as TimelineGapSegment
      const seconds = Math.max(0, Math.round((gap.endTime - gap.startTime) / 1000))
      if (seconds <= 0) continue
      const label = GAP_LABELS[gap.kind] ?? gap.kind
      gapSeconds.set(label, (gapSeconds.get(label) ?? 0) + seconds)
    }

    days.push({
      date,
      weekday: WEEKDAYS[new Date(dateMs).getDay()],
      activeSeconds: dayActiveSeconds,
      topApps: [...dayAppMs.entries()]
        .map(([appName, ms]) => ({ appName, seconds: Math.round(ms / 1000) }))
        .filter((app) => app.seconds > 0)
        .sort((a, b) => b.seconds - a.seconds)
        .slice(0, 4),
      topSites: payload.websites
        .slice(0, 3)
        .map((site) => ({ domain: site.domain, seconds: site.totalSeconds })),
      projects: dayProjects(payload),
      notes: dayNotes(payload),
      gaps: [...gapSeconds.entries()]
        .map(([kind, seconds]) => ({ kind, seconds }))
        .filter((gap) => gap.seconds >= MIN_GAP_REPORT_SEC)
        .sort((a, b) => b.seconds - a.seconds),
    })
  }

  const apps = [...weekAppMs.entries()]
    .map(([appName, ms]) => ({ appName, ms }))
    .sort((a, b) => b.ms - a.ms)
    .map(({ appName, ms }) => ({ appName, seconds: Math.round(ms / 1000) }))
    .filter((app) => app.seconds > 0)
  // Rounding residual lands on the largest app so the by-app sheet's total is
  // exactly the week total the Timeline shows.
  const appSum = apps.reduce((sum, app) => sum + app.seconds, 0)
  if (apps.length > 0 && appSum !== totalSeconds) {
    apps[0].seconds += totalSeconds - appSum
  }

  return { weekStart, weekEnd, totalSeconds, days, apps }
}

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } }
const TOTALS_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1D5DB' } }
const STRIPE_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } }

function styleHeaderRow(row: ExcelJS.Row): void {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  row.eachCell((cell) => { cell.fill = HEADER_FILL })
}

function styleTotalsRow(row: ExcelJS.Row): void {
  row.font = { bold: true }
  row.eachCell((cell) => { cell.fill = TOTALS_FILL })
}

function stripeRow(row: ExcelJS.Row, index: number): void {
  if (index % 2 === 1) row.eachCell((cell) => { cell.fill = STRIPE_FILL })
}

export async function writeWeeklyWorkbook(data: WeeklyExportData, filePath: string): Promise<void> {
  const workbook = new (excelJs().Workbook)()

  const summary = workbook.addWorksheet('Week summary')
  summary.columns = [
    { header: 'Day', key: 'day', width: 12 },
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Active time', key: 'active', width: 12 },
    { header: 'Top apps', key: 'apps', width: 44 },
    { header: 'Top sites', key: 'sites', width: 36 },
    { header: 'Project/client', key: 'projects', width: 28 },
    { header: 'Notes', key: 'notes', width: 48 },
    { header: 'Gaps & absences', key: 'gaps', width: 32 },
  ]
  styleHeaderRow(summary.getRow(1))
  data.days.forEach((day, index) => {
    const row = summary.addRow({
      day: day.weekday,
      date: day.date,
      active: formatHoursMinutes(day.activeSeconds),
      apps: day.topApps.map((app) => `${app.appName} ${formatHoursMinutes(app.seconds)}`).join(' · '),
      sites: day.topSites.map((site) => `${site.domain} ${formatHoursMinutes(site.seconds)}`).join(' · '),
      projects: day.projects.join(' · '),
      notes: day.notes,
      gaps: day.gaps.map((gap) => `${gap.kind} ${formatHoursMinutes(gap.seconds)}`).join(' · '),
    })
    stripeRow(row, index)
  })
  const weekTopApps = data.apps.slice(0, 5).map((app) => app.appName).join(' · ')
  styleTotalsRow(summary.addRow({
    day: 'Week',
    date: `${data.weekStart} – ${data.weekEnd}`,
    active: formatHoursMinutes(data.totalSeconds),
    apps: weekTopApps,
    sites: '',
    projects: '',
    notes: '',
    gaps: '',
  }))

  const byApp = workbook.addWorksheet('By app')
  byApp.columns = [
    { header: 'App', key: 'app', width: 36 },
    { header: 'Time', key: 'time', width: 12 },
    { header: 'Share', key: 'share', width: 10 },
  ]
  styleHeaderRow(byApp.getRow(1))
  data.apps.forEach((app, index) => {
    const row = byApp.addRow({
      app: app.appName,
      time: formatHoursMinutes(app.seconds),
      share: data.totalSeconds > 0 ? `${Math.round((app.seconds / data.totalSeconds) * 100)}%` : '0%',
    })
    stripeRow(row, index)
  })
  styleTotalsRow(byApp.addRow({
    app: 'Week total',
    time: formatHoursMinutes(data.totalSeconds),
    share: data.totalSeconds > 0 ? '100%' : '0%',
  }))

  await workbook.xlsx.writeFile(filePath)
}
