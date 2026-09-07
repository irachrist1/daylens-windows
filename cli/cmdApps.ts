// `daylens apps <date> [appId] [--json]`
//
// Mirrors GET_APP_SUMMARIES_FOR_DATE and GET_APP_DETAIL: a single day reads
// the same trusted-block partition as the Timeline, so the numbers here can
// never disagree with `daylens timeline` for the same date.

import type { HarnessContext } from './context'
import { c, emit, fmtDuration } from './render'

export async function appsForDate(ctx: HarnessContext, date: string, opts: { json: boolean }): Promise<void> {
  const { getAppSummariesForTimelineDay } = await import('../src/main/services/appsFacts')
  const summaries = getAppSummariesForTimelineDay(ctx.db, date, null)
  emit(summaries, opts.json, () => {
    console.log(c('bold', `Apps · ${date}`))
    if (summaries.length === 0) {
      console.log(c('gray', '(no app activity for this date)'))
      return
    }
    const total = summaries.reduce((sum, s) => sum + s.totalSeconds, 0)
    console.log(c('dim', `total ${fmtDuration(total)} across ${summaries.length} apps`))
    console.log('')
    for (const app of summaries) {
      const pct = total > 0 ? Math.round((app.totalSeconds / total) * 100) : 0
      console.log(`  ${fmtDuration(app.totalSeconds).padStart(7)}  ${String(pct).padStart(3)}%  ${c('bold', app.appName)} ${c('gray', `(${app.category})`)}`)
    }
  })
}

export async function appDetail(ctx: HarnessContext, appId: string, dateOrDays: string, opts: { json: boolean }): Promise<void> {
  const { getAppDetailProjection } = await import('../src/main/core/query/projections')
  const { resolveAppDetailAccount } = await import('../src/shared/appDetailAccount')
  const daysOrDate: number | string = /^\d+$/.test(dateOrDays) ? Number(dateOrDays) : dateOrDays
  const detail = getAppDetailProjection(ctx.db, appId, daysOrDate, null)
  emit(detail, opts.json, () => {
    console.log(c('bold', `${detail.displayName} · ${typeof daysOrDate === 'number' ? `last ${daysOrDate}d` : daysOrDate}`))
    console.log(c('dim', `total ${fmtDuration(detail.totalSeconds)} · ${detail.sessionCount} sessions`))
    const account = resolveAppDetailAccount(detail)
    console.log(c('bold', '\n  What you did there'))
    if (account) console.log(`  ${account}`)
    const breakdown = detail.activityBreakdown
    if (breakdown) {
      for (const group of breakdown.groups.slice(0, 12)) {
        console.log(`  ${fmtDuration(group.totalSeconds).padStart(7)}  ${group.label}`)
        for (const item of group.items.slice(0, 4)) {
          console.log(c('gray', `           ${fmtDuration(item.totalSeconds).padStart(7)}  ${item.displayTitle}`))
        }
      }
      if (breakdown.unattributedSeconds > 0) {
        console.log(c('gray', `  ${fmtDuration(breakdown.unattributedSeconds).padStart(7)}  (no page recorded)`))
      }
    } else if (detail.topArtifacts.length > 0) {
      for (const artifact of detail.topArtifacts.slice(0, 15)) {
        console.log(`  ${fmtDuration(artifact.totalSeconds).padStart(7)}  ${artifact.displayTitle}${artifact.subtitle ? c('gray', ` — ${artifact.subtitle}`) : ''}`)
      }
    }
  })
}

export async function appsList(ctx: HarnessContext, date: string, opts: { json: boolean }): Promise<void> {
  // Helper to find canonical app ids for `daylens apps <date> <appId>`.
  const { getAppSummariesForTimelineDay } = await import('../src/main/services/appsFacts')
  const summaries = getAppSummariesForTimelineDay(ctx.db, date, null)
  const rows = summaries.map((s) => ({ appId: s.canonicalAppId ?? s.bundleId, appName: s.appName }))
  emit(rows, opts.json, () => {
    for (const row of rows) console.log(`  ${row.appId}  ${c('dim', row.appName)}`)
  })
}
