import type Database from 'better-sqlite3'
import { resolveCanonicalApp } from '../../lib/appIdentity'
import type { AppCategory } from '@shared/types'

interface AppIdentityObservation {
  bundleId: string
  rawAppName: string
  appInstanceId?: string | null
  observedCategory?: AppCategory | null
  firstSeenAt: number
  lastSeenAt: number
}

export function upsertAppIdentityObservation(
  db: Database.Database,
  observation: AppIdentityObservation,
): void {
  const identity = resolveCanonicalApp(observation.bundleId, observation.rawAppName)
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
    observation.appInstanceId ?? identity.appInstanceId,
    observation.bundleId,
    observation.rawAppName,
    identity.canonicalAppId,
    identity.displayName,
    observation.observedCategory ?? identity.defaultCategory,
    observation.firstSeenAt,
    observation.lastSeenAt,
    JSON.stringify({
      observedCategory: observation.observedCategory ?? null,
    }),
  )
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
