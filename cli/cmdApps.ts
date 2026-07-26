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
  const daysOrDate: number | string = /^\d+$/.test(dateOrDays) ? Number(dateOrDays) : dateOrDays
  const detail = getAppDetailProjection(ctx.db, appId, daysOrDate, null)
  emit(detail, opts.json, () => {
    console.log(c('bold', `${detail.displayName} · ${typeof daysOrDate === 'number' ? `last ${daysOrDate}d` : daysOrDate}`))
    console.log(c('dim', `total ${fmtDuration(detail.totalSeconds)} · ${detail.sessionCount} sessions`))
    if (detail.topArtifacts.length > 0) {
      console.log(c('bold', '\n  What happened inside:'))
      for (const artifact of detail.topArtifacts.slice(0, 15)) {
        console.log(`  ${fmtDuration(artifact.totalSeconds).padStart(7)}  ${artifact.displayTitle}${artifact.subtitle ? c('gray', ` — ${artifact.subtitle}`) : ''}`)
      }
    }
    const browser = detail.browserActivity
    if (browser) {
      console.log(c('bold', '\n  Browser time:'))
      for (const domain of (browser.domains ?? []).slice(0, 12)) {
        console.log(`  ${fmtDuration(domain.totalSeconds).padStart(7)}  ${domain.domain}`)
      }
      if (browser.unattributedSeconds > 0) {
        console.log(c('gray', `  ${fmtDuration(browser.unattributedSeconds).padStart(7)}  (no page recorded)`))
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
