// `daylens timeline <date> [--week|--month] [--json] [--evidence]`
//
// Prints exactly what the renderer receives: the same projection call the
// GET_TIMELINE_DAY / GET_WEEKLY_SUMMARY / GET_TIMELINE_RANGE_BLOCKS IPC
// handlers make, with a null live session (historical dates have none).

import type { HarnessContext } from './context'
import { c, emit, fmtDuration, fmtTime } from './render'

export async function timelineDay(ctx: HarnessContext, date: string, opts: { json: boolean; evidence: boolean }): Promise<void> {
  const { getTimelineDayProjection } = await import('../src/main/core/query/projections')
  // The RENDERER's label function (Timeline.tsx uses userVisibleBlockLabel),
  // not the main-process userVisibleLabelForBlock — they disagree on ~44% of
  // real blocks, and this surface must show exactly what the user sees.
  const { userVisibleBlockLabel } = await import('../src/shared/blockLabel')
  const payload = getTimelineDayProjection(ctx.db, date, null, { materialize: false, analysis: false })
  emit(payload, opts.json, () => {
    console.log(c('bold', `Timeline · ${date}`))
    console.log(c('dim', `total ${fmtDuration(payload.totalSeconds)} · focus ${fmtDuration(payload.focusSeconds ?? 0)} · ${payload.blocks.length} blocks · version ${payload.version}`))
    console.log('')
    if (payload.blocks.length === 0) {
      console.log(c('gray', '(no blocks — no captured activity for this date)'))
      return
    }
    let previousEnd: number | null = null
    for (const block of payload.blocks) {
      if (previousEnd !== null && block.startTime - previousEnd >= 45 * 60_000) {
        console.log(c('yellow', `  · · · ${fmtDuration((block.startTime - previousEnd) / 1000)} away from the computer · · ·`))
      }
      previousEnd = block.endTime
      const label = userVisibleBlockLabel(block)
      console.log(`${c('cyan', `${fmtTime(block.startTime)}–${fmtTime(block.endTime)}`)} ${c('dim', `(${fmtDuration((block.endTime - block.startTime) / 1000)})`)}  ${c('bold', label)}`)
      if (block.label?.narrative) console.log(c('dim', `    ${block.label.narrative}`))
      if (opts.evidence) {
        const apps = block.topApps.slice(0, 6).map((a) => `${a.appName} ${fmtDuration(a.totalSeconds)}`).join(', ')
        const pages = block.pageRefs.slice(0, 5).map((p) => p.pageTitle ?? p.displayTitle ?? p.domain).join(' | ')
        if (apps) console.log(c('gray', `    apps: ${apps}`))
        if (pages) console.log(c('gray', `    pages: ${pages}`))
      }
    }
  })
}

export async function timelineWeek(ctx: HarnessContext, endDate: string, opts: { json: boolean }): Promise<void> {
  const { getWeeklySummaryProjection } = await import('../src/main/core/query/projections')
  const summary = getWeeklySummaryProjection(ctx.db, endDate)
  emit(summary, opts.json, () => {
    console.log(c('bold', `Week ending ${endDate}`))
    console.log(c('dim', `tracked ${fmtDuration(summary.totalTrackedSeconds)} · focus ${fmtDuration(summary.totalFocusSeconds)} (${Math.round(summary.focusPct)}%)`))
    for (const day of summary.dailyBreakdown) {
      console.log(`  ${c('cyan', day.date)}  ${fmtDuration(day.totalSeconds).padStart(7)}  focus ${fmtDuration(day.focusSeconds)}`)
    }
    const top = summary.topApps.slice(0, 8).map((a) => `${a.appName} ${fmtDuration(a.totalSeconds)}`).join(', ')
    if (top) console.log(c('dim', `  top apps: ${top}`))
  })
}

export async function timelineMonth(ctx: HarnessContext, month: string, opts: { json: boolean }): Promise<void> {
  const { getTimelineRangeBlocks } = await import('../src/main/services/timelineCalendarRange')
  const [y, m] = month.split('-').map(Number)
  const from = `${month}-01`
  const lastDay = new Date(y, m, 0).getDate()
  const to = `${month}-${String(lastDay).padStart(2, '0')}`
  const days = getTimelineRangeBlocks(ctx.db, from, to)
  emit(days, opts.json, () => {
    console.log(c('bold', `Month · ${month}`))
    for (const day of days) {
      if (day.blocks.length === 0) continue
      const labels = day.blocks.slice(0, 3).map((b) => b.label).join(' · ')
      console.log(`  ${c('cyan', day.date)}  ${fmtDuration(day.activeSeconds).padStart(7)}  ${String(day.blocks.length).padStart(2)} blocks  ${c('dim', labels)}`)
    }
  })
}
