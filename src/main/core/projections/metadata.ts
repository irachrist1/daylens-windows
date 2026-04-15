import type Database from 'better-sqlite3'
import type { DerivedStateComponent } from '@shared/core'
import { DERIVED_STATE_COMPONENT_VERSIONS, DERIVED_STATE_RESET_COMPONENTS } from '../domain/versioning'
import { resolveCanonicalApp, resolveCanonicalBrowser, normalizeUrlForStorage, pageKeyForUrl } from '../../lib/appIdentity'

function resetDerivedState(db: Database.Database, reason: string): void {
  // app_profile_cache was removed in migration v14.
  db.exec(`
    DELETE FROM artifact_mentions;
    DELETE FROM artifacts;
    DELETE FROM workflow_occurrences;
    DELETE FROM workflow_signatures;
    DELETE FROM timeline_block_labels;
    DELETE FROM timeline_block_members;
    DELETE FROM timeline_blocks;
    DELETE FROM work_context_observations;
  `)

  db.prepare(`
    INSERT INTO rebuild_jobs (
      id,
      scope,
      reason,
      started_at,
      finished_at,
      status,
      metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    `rebuild_${Date.now()}`,
    'derived_state',
    reason,
    Date.now(),
    Date.now(),
    'completed',
    JSON.stringify({ resetDerivedState: true }),
  )
}

export function syncDerivedStateMetadata(db: Database.Database): void {
  const rows = db.prepare(`
    SELECT component, version
    FROM derived_state_versions
  `).all() as Array<{ component: DerivedStateComponent; version: string }>

  // If the table is empty this is a fresh install or fresh table from the v13 migration.
  // Do NOT treat an empty registry as "all versions changed" — that would nuke derived
  // state on every fresh install. Just populate the versions and return.
  if (rows.length === 0) {
    const upsert = db.prepare(`
      INSERT INTO derived_state_versions (component, version, rebuild_required, notes, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(component) DO UPDATE SET
        version = excluded.version,
        rebuild_required = excluded.rebuild_required,
        notes = excluded.notes,
        updated_at = excluded.updated_at
    `)
    const now = Date.now()
    const tx = db.transaction(() => {
      for (const [component, version] of Object.entries(DERIVED_STATE_COMPONENT_VERSIONS)) {
        upsert.run(component, version, 0, 'initial population', now)
      }
    })
    tx()
    return
  }

  const current = new Map(rows.map((row) => [row.component, row.version]))
  const changed = Object.entries(DERIVED_STATE_COMPONENT_VERSIONS)
    .filter(([component, version]) => current.get(component as DerivedStateComponent) !== version)
    .map(([component]) => component as DerivedStateComponent)

  if (changed.some((component) => DERIVED_STATE_RESET_COMPONENTS.has(component))) {
    resetDerivedState(db, `Derived state version changed: ${changed.join(', ')}`)
  }

  const upsert = db.prepare(`
    INSERT INTO derived_state_versions (
      component,
      version,
      rebuild_required,
      notes,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(component) DO UPDATE SET
      version = excluded.version,
      rebuild_required = excluded.rebuild_required,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `)

  const now = Date.now()
  const tx = db.transaction(() => {
    for (const [component, version] of Object.entries(DERIVED_STATE_COMPONENT_VERSIONS)) {
      upsert.run(
        component,
        version,
        0,
        changed.includes(component as DerivedStateComponent) ? 'auto-synced on startup' : null,
        now,
      )
    }
  })

  tx()
}

export function repairStoredIdentityColumns(db: Database.Database): void {
  const sessionRows = db.prepare(`
    SELECT id, bundle_id, app_name
    FROM app_sessions
  `).all() as Array<{
    id: number
    bundle_id: string
    app_name: string
  }>

  const updateSession = db.prepare(`
    UPDATE app_sessions
    SET raw_app_name = ?,
        canonical_app_id = ?,
        app_instance_id = ?,
        capture_source = COALESCE(capture_source, 'foreground_poll'),
        capture_version = COALESCE(capture_version, 1)
    WHERE id = ?
  `)

  const visitRows = db.prepare(`
    SELECT id, browser_bundle_id, url
    FROM website_visits
  `).all() as Array<{
    id: number
    browser_bundle_id: string | null
    url: string | null
  }>

  const updateVisit = db.prepare(`
    UPDATE website_visits
    SET canonical_browser_id = ?,
        browser_profile_id = ?,
        normalized_url = ?,
        page_key = ?
    WHERE id = ?
  `)

  const tx = db.transaction(() => {
    for (const row of sessionRows) {
      const identity = resolveCanonicalApp(row.bundle_id, row.app_name)
      updateSession.run(
        identity.rawAppName,
        identity.canonicalAppId,
        identity.appInstanceId,
        row.id,
      )
    }

    for (const row of visitRows) {
      const browserIdentity = resolveCanonicalBrowser(row.browser_bundle_id)
      updateVisit.run(
        browserIdentity.canonicalBrowserId,
        browserIdentity.browserProfileId,
        normalizeUrlForStorage(row.url),
        pageKeyForUrl(row.url),
        row.id,
      )
    }
  })

  tx()
}
