import type Database from 'better-sqlite3'
import { resolveCanonicalApp } from '../../lib/appIdentity'
import type { AppCategory } from '@shared/types'

export interface AppIdentityMetadata {
  observedCategory?: AppCategory | null
  executablePath?: string | null
  uwpPackageFamily?: string | null
  activeWindowIconBase64?: string | null
  activeWindowIconMime?: string | null
  activeWindowIconCapturedAt?: number | null
}

interface AppIdentityObservation extends AppIdentityMetadata {
  bundleId: string
  rawAppName: string
  appInstanceId?: string | null
  firstSeenAt: number
  lastSeenAt: number
}

export interface AppIdentityRecord {
  appInstanceId: string
  bundleId: string
  rawAppName: string
  canonicalAppId: string | null
  displayName: string
  defaultCategory: AppCategory | null
  firstSeenAt: number
  lastSeenAt: number
  metadata: AppIdentityMetadata
}

function parseAppIdentityMetadata(rawValue: string | null | undefined): AppIdentityMetadata {
  if (!rawValue) return {}
  try {
    const parsed = JSON.parse(rawValue) as AppIdentityMetadata | null
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function normalizeMetadataValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function mergeMetadata(
  existing: AppIdentityMetadata,
  observation: AppIdentityObservation,
): AppIdentityMetadata {
  const nextIconBase64 = normalizeMetadataValue(observation.activeWindowIconBase64)
  return {
    observedCategory: observation.observedCategory ?? existing.observedCategory ?? null,
    executablePath: normalizeMetadataValue(observation.executablePath) ?? existing.executablePath ?? null,
    uwpPackageFamily: normalizeMetadataValue(observation.uwpPackageFamily) ?? existing.uwpPackageFamily ?? null,
    activeWindowIconBase64: nextIconBase64 ?? existing.activeWindowIconBase64 ?? null,
    activeWindowIconMime: normalizeMetadataValue(observation.activeWindowIconMime)
      ?? (nextIconBase64 ? 'image/png' : null)
      ?? existing.activeWindowIconMime
      ?? null,
    activeWindowIconCapturedAt: nextIconBase64
      ? observation.lastSeenAt
      : existing.activeWindowIconCapturedAt ?? null,
  }
}

function parseRow(row: {
  app_instance_id: string
  bundle_id: string
  raw_app_name: string
  canonical_app_id: string | null
  display_name: string
  default_category: AppCategory | null
  first_seen_at: number
  last_seen_at: number
  metadata_json: string
}): AppIdentityRecord {
  return {
    appInstanceId: row.app_instance_id,
    bundleId: row.bundle_id,
    rawAppName: row.raw_app_name,
    canonicalAppId: row.canonical_app_id,
    displayName: row.display_name,
    defaultCategory: row.default_category,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    metadata: parseAppIdentityMetadata(row.metadata_json),
  }
}

export function upsertAppIdentityObservation(
  db: Database.Database,
  observation: AppIdentityObservation,
): void {
  const identity = resolveCanonicalApp(observation.bundleId, observation.rawAppName)
  const appInstanceId = observation.appInstanceId ?? identity.appInstanceId
  const existingRow = db.prepare(`
    SELECT metadata_json
    FROM app_identities
    WHERE app_instance_id = ?
    LIMIT 1
  `).get(appInstanceId) as { metadata_json: string } | undefined
  const metadata = mergeMetadata(
    parseAppIdentityMetadata(existingRow?.metadata_json),
    observation,
  )
  db.prepare(`
    INSERT INTO app_identities (
      app_instance_id,
      bundle_id,
      raw_app_name,
      canonical_app_id,
      display_name,
      default_category,
      first_seen_at,
      last_seen_at,
      metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(app_instance_id) DO UPDATE SET
      raw_app_name = excluded.raw_app_name,
      canonical_app_id = excluded.canonical_app_id,
      display_name = excluded.display_name,
      default_category = excluded.default_category,
      last_seen_at = excluded.last_seen_at,
      metadata_json = excluded.metadata_json
  `).run(
    appInstanceId,
    observation.bundleId,
    observation.rawAppName,
    identity.canonicalAppId,
    identity.displayName,
    observation.observedCategory ?? identity.defaultCategory,
    observation.firstSeenAt,
    observation.lastSeenAt,
    JSON.stringify(metadata),
  )
}

export function getLatestAppIdentity(
  db: Database.Database,
  query: {
    appInstanceId?: string | null
    bundleId?: string | null
    canonicalAppId?: string | null
    appName?: string | null
  },
): AppIdentityRecord | null {
  const appInstanceId = query.appInstanceId?.trim() || null
  const bundleId = query.bundleId?.trim() || null
  const canonicalAppId = query.canonicalAppId?.trim() || null
  const appName = query.appName?.trim().toLowerCase() || null
  if (!appInstanceId && !bundleId && !canonicalAppId && !appName) return null

  const rows = db.prepare(`
    SELECT
      app_instance_id,
      bundle_id,
      raw_app_name,
      canonical_app_id,
      display_name,
      default_category,
      first_seen_at,
      last_seen_at,
      metadata_json
    FROM app_identities
    WHERE (? IS NOT NULL AND app_instance_id = ?)
      OR (? IS NOT NULL AND bundle_id = ?)
      OR (? IS NOT NULL AND canonical_app_id = ?)
      OR (? IS NOT NULL AND LOWER(display_name) = ?)
      OR (? IS NOT NULL AND LOWER(raw_app_name) = ?)
    ORDER BY last_seen_at DESC
    LIMIT 12
  `).all(
    appInstanceId, appInstanceId,
    bundleId, bundleId,
    canonicalAppId, canonicalAppId,
    appName, appName,
    appName, appName,
  ) as Array<{
    app_instance_id: string
    bundle_id: string
    raw_app_name: string
    canonical_app_id: string | null
    display_name: string
    default_category: AppCategory | null
    first_seen_at: number
    last_seen_at: number
    metadata_json: string
  }>

  if (rows.length === 0) return null

  const ranked = rows
    .map((row) => {
      let score = row.last_seen_at
      if (appInstanceId && row.app_instance_id === appInstanceId) score += 4_000_000_000_000
      if (bundleId && row.bundle_id === bundleId) score += 3_000_000_000_000
      if (canonicalAppId && row.canonical_app_id === canonicalAppId) score += 2_000_000_000_000
      if (appName && row.display_name.toLowerCase() === appName) score += 500_000_000_000
      if (appName && row.raw_app_name.toLowerCase() === appName) score += 250_000_000_000
      return { row, score }
    })
    .sort((left, right) => right.score - left.score)

  return parseRow(ranked[0].row)
}

export function repairStoredAppIdentityObservations(db: Database.Database): void {
  const rows = db.prepare(`
    SELECT
      bundle_id,
      COALESCE(raw_app_name, app_name) AS raw_app_name,
      COALESCE(app_instance_id, bundle_id) AS app_instance_id,
      category,
      MIN(start_time) AS first_seen_at,
      MAX(COALESCE(end_time, start_time + duration_sec * 1000)) AS last_seen_at
    FROM app_sessions
    GROUP BY bundle_id, COALESCE(raw_app_name, app_name), COALESCE(app_instance_id, bundle_id), category
  `).all() as Array<{
    bundle_id: string
    raw_app_name: string
    app_instance_id: string
    category: AppCategory
    first_seen_at: number
    last_seen_at: number
  }>

  const tx = db.transaction(() => {
    for (const row of rows) {
      upsertAppIdentityObservation(db, {
        bundleId: row.bundle_id,
        rawAppName: row.raw_app_name,
        appInstanceId: row.app_instance_id,
        observedCategory: row.category,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
      })
    }
  })

  tx()
}
