import {
  REMOTE_CONTRACT_VERSION,
  type ArtifactRollup,
  type EntityRollup,
  type RecapSummaryLite,
  type RemoteSyncPayload,
  type SyncedDaySummary,
  type WorkBlockSummary,
  type WorkspaceLivePresence,
} from '@daylens/remote-contract'
import type { DaySnapshotV2 as LocalDaySnapshotV2 } from '@shared/snapshot'
import { localDateString, localDayBounds } from '../lib/localDate'
import { getDb } from './database'
import { exportSnapshot } from './snapshotExporter'
import {
  getCurrentPresenceState,
  getCurrentSession,
  getLastMeaningfulCaptureAt,
} from './tracking'
import { resolveCanonicalApp } from '../lib/appIdentity'

function scopedBlockId(deviceId: string, blockId: string): string {
  return `${deviceId}:${blockId}`
}

function scopedArtifactId(deviceId: string, artifactId: string): string {
  return `${deviceId}:${artifactId}`
}

function normalizeEntitySlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

function scopedEntityId(entity: EntityRollup): string {
  const normalizedLabel = normalizeEntitySlug(entity.label)
  return `${entity.kind}:${normalizedLabel || entity.id}`
}

function rewriteWorkBlock(deviceId: string, block: WorkBlockSummary): WorkBlockSummary {
  return {
    ...block,
    id: scopedBlockId(deviceId, block.id),
    artifactIds: [],
    topPages: block.topPages.map((page) => ({
      domain: page.domain,
      label: page.domain,
      seconds: page.seconds,
    })),
  }
}

function rewriteArtifact(deviceId: string, artifact: ArtifactRollup): ArtifactRollup {
  return {
    ...artifact,
    id: scopedArtifactId(deviceId, artifact.id),
    threadId: artifact.threadId ? `${deviceId}:${artifact.threadId}` : null,
  }
}

function rewriteEntity(entity: EntityRollup): EntityRollup {
  return {
    ...entity,
    id: scopedEntityId(entity),
  }
}

function formatDuration(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.round(seconds))
  const hours = Math.floor(wholeSeconds / 3600)
  const minutes = Math.floor((wholeSeconds % 3600) / 60)
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function buildSafeRecap(
  snapshot: LocalDaySnapshotV2,
  workBlocks: WorkBlockSummary[],
  artifacts: ArtifactRollup[],
): SyncedDaySummary['recap'] {
  const topWorkstreams = snapshot.topWorkstreams
    .filter((workstream) => workstream.label.trim().length > 0)
    .slice(0, 3)
    .map((workstream) => workstream.label)

  const chapters: RecapSummaryLite['chapters'] = []
  const workstreamText = topWorkstreams.length > 0
    ? topWorkstreams.join(', ')
    : 'no clearly named workstreams yet'

  chapters.push({
    id: 'headline',
    eyebrow: 'Timeline',
    title: 'What the synced day shows',
    body: `Tracked ${formatDuration(snapshot.focusSeconds)} across ${workBlocks.length} synced work blocks. Main workstreams: ${workstreamText}.`,
  })

  chapters.push({
    id: 'focus',
    eyebrow: 'Focus',
    title: 'Focus score',
    body: `Focus score was ${snapshot.focusScoreV2.score}/100 with ${workBlocks.length} visible work blocks in the remote proof surface.`,
  })

  if (artifacts.length > 0) {
    chapters.push({
      id: 'artifacts',
      eyebrow: 'Artifacts',
      title: 'Approved synced artifacts',
      body: `Remote artifacts are limited to approved Daylens artifact records. ${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'} were available for this day.`,
    })
  }

  return {
    day: {
      headline: `Tracked ${formatDuration(snapshot.focusSeconds)} across ${workBlocks.length} synced work blocks.`,
      chapters,
      metrics: [
        {
          label: 'Focus time',
          value: formatDuration(snapshot.focusSeconds),
          detail: `${workBlocks.length} synced work blocks`,
        },
        {
          label: 'Focus score',
          value: `${snapshot.focusScoreV2.score}/100`,
          detail: `${artifacts.length} approved artifact${artifacts.length === 1 ? '' : 's'}`,
        },
      ],
      changeSummary: snapshot.coverage.coverageNote ?? '',
      promptChips: [
        'What was I working on most today?',
        'Summarize the visible work blocks for this day.',
      ],
      hasData: workBlocks.length > 0,
    },
    week: null,
    month: null,
  }
}

function loadArtifactRollupsForDate(dateStr: string, deviceId: string): ArtifactRollup[] {
  const [fromMs, toMs] = localDayBounds(dateStr)
  const db = getDb()
  const rows = db.prepare(`
    SELECT
      a.id AS id,
      a.kind AS kind,
      a.title AS title,
      a.byte_size AS byteSize,
      a.created_at AS createdAt,
      t.metadata_json AS threadMetadata
    FROM ai_artifacts a
    LEFT JOIN ai_threads t ON t.id = a.thread_id
    WHERE a.created_at >= ? AND a.created_at < ?
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT 24
  `).all(fromMs, toMs) as Array<{
    id: number
    kind: ArtifactRollup['kind']
    title: string
    byteSize: number
    createdAt: number
    threadMetadata: string | null
  }>

  return rows.map((row) => {
    let workspaceThreadId: string | null = null
    if (row.threadMetadata) {
      try {
        const parsed = JSON.parse(row.threadMetadata) as { workspaceThreadId?: unknown }
        workspaceThreadId = typeof parsed.workspaceThreadId === 'string' ? parsed.workspaceThreadId : null
      } catch {
        workspaceThreadId = null
      }
    }

    return rewriteArtifact(deviceId, {
      id: `ai_artifact_${row.id}`,
      kind: row.kind,
      title: row.title,
      byteSize: row.byteSize,
      generatedAt: new Date(row.createdAt).toISOString(),
      threadId: workspaceThreadId,
    })
  })
}

export function buildRemoteSyncPayloadFromSnapshot(
  snapshot: LocalDaySnapshotV2,
  deviceId: string,
  options?: { artifacts?: ArtifactRollup[] },
): RemoteSyncPayload {
  const workBlocks = snapshot.workBlocks.map((block) => rewriteWorkBlock(deviceId, block))
  const entities = snapshot.entities.map(rewriteEntity)
  const artifacts = options?.artifacts ?? []
  const boundaryHidden =
    snapshot.workBlocks.some((block) =>
      block.artifactIds.length > 0 || block.topPages.some((page) => Boolean(page.label) && page.label !== page.domain)
    )
    || snapshot.standoutArtifacts.length > 0
  const privacyFiltered = snapshot.privacyFiltered || boundaryHidden
  const recap = buildSafeRecap(snapshot, workBlocks, artifacts)

  return {
    contractVersion: REMOTE_CONTRACT_VERSION,
    deviceId,
    localDate: snapshot.date,
    generatedAt: snapshot.generatedAt,
    daySummary: buildDaySummary(
      {
        ...snapshot,
        recap,
        privacyFiltered,
      },
      workBlocks,
      entities,
      artifacts,
    ),
    workBlocks,
    entities,
    artifacts,
  }
}

function buildDaySummary(
  snapshot: LocalDaySnapshotV2 & {
    recap: SyncedDaySummary['recap']
    privacyFiltered: boolean
  },
  workBlocks: WorkBlockSummary[],
  entities: EntityRollup[],
  artifacts: ArtifactRollup[],
): SyncedDaySummary {
  const latestWorkBlock = [...workBlocks]
    .sort((left, right) => right.endAt.localeCompare(left.endAt))
    .at(0)

  return {
    contractVersion: REMOTE_CONTRACT_VERSION,
    deviceId: snapshot.deviceId,
    localDate: snapshot.date,
    generatedAt: snapshot.generatedAt,
    isPartialDay: snapshot.isPartialDay,
    focusScore: snapshot.focusScore,
    focusSeconds: snapshot.focusSeconds,
    focusScoreV2: snapshot.focusScoreV2 ?? null,
    recap: snapshot.recap,
    coverage: snapshot.coverage,
    topWorkstreams: snapshot.topWorkstreams,
    latestWorkBlockId: latestWorkBlock?.id ?? null,
    workBlockCount: workBlocks.length,
    entityCount: entities.length,
    artifactCount: artifacts.length,
    privacyFiltered: snapshot.privacyFiltered,
  }
}

export function buildRemoteSyncPayload(dateStr: string, deviceId: string): RemoteSyncPayload {
  const snapshot = exportSnapshot(dateStr, deviceId)
  const artifacts = loadArtifactRollupsForDate(dateStr, deviceId)
  return buildRemoteSyncPayloadFromSnapshot(snapshot, deviceId, { artifacts })
}

export function buildWorkspaceLivePresence(deviceId: string): WorkspaceLivePresence {
  const now = Date.now()
  const liveSession = getCurrentSession()
  const safeAppName = liveSession
    ? resolveCanonicalApp(liveSession.bundleId, liveSession.appName).displayName || liveSession.appName
    : null

  return {
    contractVersion: REMOTE_CONTRACT_VERSION,
    deviceId,
    localDate: localDateString(),
    state: getCurrentPresenceState(),
    heartbeatAt: now,
    capturedAt: now,
    lastMeaningfulCaptureAt: getLastMeaningfulCaptureAt() ?? now,
    currentBlockLabel: safeAppName,
    currentCategory: liveSession?.category ?? null,
    currentAppKey: liveSession?.canonicalAppId ?? liveSession?.bundleId ?? null,
    currentFocusSeconds: liveSession
      ? Math.max(0, Math.round((now - liveSession.startTime) / 1_000))
      : null,
  }
}
