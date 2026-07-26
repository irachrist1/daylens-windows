// Build a compact, judge-readable summary of the real DB so the LLM judge can
// detect hallucinations. Intentionally small — the judge does not need
// minute-by-minute granularity, just "what entities and durations exist."

import { getDb } from '../../src/main/services/database'
import { listClients } from '../../src/main/core/query/attributionResolvers'
import { getTimelineDayPayload } from '../../src/main/services/workBlocks'
import type { WorkContextBlock } from '../../src/shared/types'

function ymd(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function secondsToHm(seconds: number): string {
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export interface GroundTruth {
  today: string
  yesterday: string
  clients: Array<{ id: string; name: string; projectCount: number }>
  todayBlocks: Array<{
    label: string
    start: string
    end: string
    minutes: number
    topApps: string[]
    topArtifacts: string[]
    topPages: string[]
  }>
  yesterdayBlocks: Array<{
    label: string
    start: string
    end: string
    minutes: number
    topApps: string[]
  }>
  weekDays: Array<{
    date: string
    blockCount: number
    totalSeconds: number
    focusSeconds: number
    topApps: Array<{ app: string; minutes: number }>
    topDomains: Array<{ domain: string; minutes: number }>
  }>
  todayTotalSeconds: number
  todayFocusSeconds: number
}

export function gatherGroundTruth(): GroundTruth {
  const db = getDb()
  const today = ymd(new Date())
  const yesterdayDate = new Date()
  yesterdayDate.setDate(yesterdayDate.getDate() - 1)
  const yesterday = ymd(yesterdayDate)

  const clients = listClients(db)
  const todayPayload = getTimelineDayPayload(db, today)
  const yesterdayPayload = getTimelineDayPayload(db, yesterday)

  const fmtTime = (ms: number): string => {
    const d = new Date(ms)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  const labelText = (b: WorkContextBlock): string => {
    if (b.label && typeof b.label === 'object') {
      const obj = b.label as { value?: string; text?: string }
      return obj.value ?? obj.text ?? b.aiLabel ?? b.ruleBasedLabel ?? '(unlabeled)'
    }
    return b.aiLabel ?? b.ruleBasedLabel ?? '(unlabeled)'
  }

  const blockSummary = (b: WorkContextBlock) => ({
    label: labelText(b),
    start: fmtTime(b.startTime),
    end: fmtTime(b.endTime),
    minutes: Math.round((b.endTime - b.startTime) / 60000),
    topApps: (b.topApps ?? []).slice(0, 5).map((a) => a.appName ?? '?'),
    topArtifacts: (b.topArtifacts ?? []).slice(0, 5).map((a: any) => a.name ?? a.title ?? a.path ?? '?'),
    topPages: (b.pageRefs ?? []).slice(0, 5).map((p: any) => p.title ?? p.url ?? '?'),
  })

  // Roll up the previous 7 days so the judge can fairly grade
  // "this week" questions without false hallucination flags.
  const weekDays: GroundTruth['weekDays'] = []
  for (let i = 0; i < 7; i += 1) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const dayStr = ymd(d)
    const payload = getTimelineDayPayload(db, dayStr)
    const appTotals = new Map<string, number>()
    for (const s of payload.sessions) {
      appTotals.set(s.appName, (appTotals.get(s.appName) ?? 0) + s.durationSeconds)
    }
    const domainTotals = new Map<string, number>()
    for (const w of payload.websites) {
      domainTotals.set(w.domain, (domainTotals.get(w.domain) ?? 0) + (w.totalSeconds ?? 0))
    }
    weekDays.push({
      date: dayStr,
      blockCount: payload.blocks.length,
      totalSeconds: payload.totalSeconds,
      focusSeconds: payload.focusSeconds ?? 0,
      topApps: [...appTotals.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([app, sec]) => ({ app, minutes: Math.round(sec / 60) })),
      topDomains: [...domainTotals.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([domain, sec]) => ({ domain, minutes: Math.round(sec / 60) })),
    })
  }

  return {
    today,
    yesterday,
    clients,
    todayBlocks: todayPayload.blocks.slice(0, 20).map(blockSummary),
    yesterdayBlocks: yesterdayPayload.blocks.slice(0, 20).map((b) => {
      const s = blockSummary(b)
      return { label: s.label, start: s.start, end: s.end, minutes: s.minutes, topApps: s.topApps }
    }),
    weekDays,
    todayTotalSeconds: todayPayload.totalSeconds,
    todayFocusSeconds: todayPayload.focusSeconds ?? 0,
  }
}

export function renderGroundTruthForJudge(gt: GroundTruth): string {
  const lines: string[] = []
  lines.push(`Today: ${gt.today}`)
  lines.push(`Today total tracked: ${secondsToHm(gt.todayTotalSeconds)} (focus ${secondsToHm(gt.todayFocusSeconds)})`)
  lines.push('')
  lines.push(`Clients table (${gt.clients.length} active):`)
  if (gt.clients.length === 0) {
    lines.push('  (none)')
  } else {
    for (const c of gt.clients) {
      lines.push(`  - ${c.name} (${c.projectCount} active projects)`)
    }
  }
  lines.push('')
  lines.push(`Today's (${gt.today}) blocks (${gt.todayBlocks.length}) — they describe ${gt.today} ONLY; never apply them to a question about any other date:`)
  for (const b of gt.todayBlocks) {
    const apps = b.topApps.length ? ` apps=${b.topApps.join(',')}` : ''
    const arts = b.topArtifacts.length ? ` artifacts=${b.topArtifacts.join('|')}` : ''
    const pages = b.topPages.length ? ` pages=${b.topPages.join('|')}` : ''
    lines.push(`  - ${b.start}-${b.end} (${b.minutes}m) "${b.label}"${apps}${arts}${pages}`)
  }
  lines.push('')
  lines.push(`Yesterday's (${gt.yesterday}) blocks (${gt.yesterdayBlocks.length}) — ${gt.yesterday} ONLY; never apply them to any other date:`)
  for (const b of gt.yesterdayBlocks) {
    const apps = b.topApps.length ? ` apps=${b.topApps.join(',')}` : ''
    lines.push(`  - ${b.start}-${b.end} (${b.minutes}m) "${b.label}"${apps}`)
  }
  lines.push('')
  lines.push('Past 7 days roll-up (per-day totals, top apps, top domains):')
  for (const d of gt.weekDays) {
    lines.push(`  ${d.date} — ${d.blockCount} blocks, ${secondsToHm(d.totalSeconds)} total (focus ${secondsToHm(d.focusSeconds)})`)
    if (d.topApps.length) {
      lines.push(`    apps: ${d.topApps.map((a) => `${a.app}=${a.minutes}m`).join(', ')}`)
    }
    if (d.topDomains.length) {
      lines.push(`    domains: ${d.topDomains.map((x) => `${x.domain}=${x.minutes}m`).join(', ')}`)
    }
  }
  return lines.join('\n')
}
