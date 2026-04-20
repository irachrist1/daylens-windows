import type Database from 'better-sqlite3'
import type { AssistantEvidenceBlock, AssistantEvidencePack } from '@shared/core'
import { inferWorkIntent } from '../../../shared/workIntent'
import { getAppSummariesForRange, getFocusSessionsForDateRange, getWebsiteSummariesForRange } from '../../db/queries'
import { localDayBounds } from '../../lib/localDate'
import { getAppDetailPayload, getTimelineDayPayload, getWorkflowSummaries, userVisibleLabelForBlock } from '../../services/workBlocks'

function blockEvidence(block: ReturnType<typeof getTimelineDayPayload>['blocks'][number]): AssistantEvidenceBlock {
  return {
    id: block.id,
    label: userVisibleLabelForBlock(block),
    startTime: block.startTime,
    endTime: block.endTime,
    dominantCategory: block.dominantCategory,
    workIntent: inferWorkIntent(block),
    topApps: block.topApps.slice(0, 4).map((app) => app.appName),
    topSites: block.websites.slice(0, 4).map((site) => site.domain),
    topArtifacts: block.topArtifacts.slice(0, 4).map((artifact) => artifact.displayTitle),
    focusOverlapSeconds: block.focusOverlap.totalSeconds,
  }
}

export function buildAssistantEvidencePack(
  db: Database.Database,
  dateStr: string,
): AssistantEvidencePack {
  const [fromMs, toMs] = localDayBounds(dateStr)
  const dayPayload = getTimelineDayPayload(db, dateStr, null)
  const topApps = getAppSummariesForRange(db, fromMs, toMs).slice(0, 8)
  const topWebsites = getWebsiteSummariesForRange(db, fromMs, toMs).slice(0, 8)
  const focusSessions = getFocusSessionsForDateRange(db, fromMs, toMs).slice(0, 8)
  const workflows = getWorkflowSummaries(db, 14).slice(0, 8)
  const appSpotlights = topApps
    .slice(0, 3)
    .map((app) => getAppDetailPayload(db, app.canonicalAppId ?? app.bundleId, 7, null))

  return {
    generatedAt: Date.now(),
    date: dateStr,
    totals: {
      trackedSeconds: dayPayload.totalSeconds,
      focusSeconds: dayPayload.focusSeconds,
      focusPct: dayPayload.focusPct,
      appCount: dayPayload.appCount,
      siteCount: dayPayload.siteCount,
    },
    topApps,
    topWebsites,
    timeline: {
      date: dayPayload.date,
      computedAt: dayPayload.computedAt,
      version: dayPayload.version,
      blocks: dayPayload.blocks
        .filter((block) => (block.endTime - block.startTime) >= 3 * 60_000)
        .slice(0, 12)
        .map(blockEvidence),
    },
    workflows,
    focusSessions,
    appSpotlights,
    caveats: [
      'Raw app sessions are reliable; derived blocks and attributions are rebuildable projections.',
      'Website evidence comes from local browser history and may undercount background tabs.',
      'When evidence is ambiguous, assistant responses should use confidence language rather than invent specifics.',
    ],
  }
}
