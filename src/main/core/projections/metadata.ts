import type Database from 'better-sqlite3'
import type { DerivedStateComponent } from '@shared/core'
import { DERIVED_STATE_COMPONENT_VERSIONS, DERIVED_STATE_RESET_COMPONENTS } from '../domain/versioning'
import { resolveCanonicalApp, resolveCanonicalBrowser, normalizeUrlForStorage, pageKeyForUrl } from '../../lib/appIdentity'
import { hasMaintenanceRun, markMaintenanceRun } from '../../db/maintenance'
import { bumpRangeFactsEvidenceEpoch } from '../query/rangeFactsCache'

const IDENTITY_COLUMNS_REPAIR_KEY = 'identity_columns_v1'

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
    SELECT component, version, rebuild_required
    FROM derived_state_versions
  `).all() as Array<{ component: DerivedStateComponent; version: string; rebuild_required: number }>

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
  const alreadyPending = new Map(rows.map((row) => [row.component, row.rebuild_required === 1]))
  const changed = Object.entries(DERIVED_STATE_COMPONENT_VERSIONS)
    .filter(([component, version]) => current.get(component as DerivedStateComponent) !== version)
    .map(([component]) => component as DerivedStateComponent)

  // A reset-triggering version bump no longer runs the destructive DELETE
  // synchronously here (it blocked the window for the whole derived-state wipe
  // on the first launch after an upgrade). Instead we record the new versions
  // but flag the reset-components rebuild_required=1 so runPendingDerivedStateReset
  // performs the wipe off the startup critical path. The flag — not the version —
  // is the source of truth for "reset owed", so a crash before the deferred reset
  // still leaves it pending for the next launch.
  const resetPending = changed.some((component) => DERIVED_STATE_RESET_COMPONENTS.has(component))

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
      const comp = component as DerivedStateComponent
      const needsReset = resetPending && DERIVED_STATE_RESET_COMPONENTS.has(comp)
      const resetOwed = needsReset || alreadyPending.get(comp) === true
      upsert.run(
        component,
        version,
        resetOwed ? 1 : 0,
        resetOwed
          ? 'reset pending (deferred)'
          : changed.includes(comp) ? 'auto-synced on startup' : null,
        now,
      )
    }
  })

  tx()
}

// Runs the destructive derived-state wipe that a reset-triggering version bump
// deferred. Safe to call unconditionally at any point after the window is up;
// it is a no-op unless syncDerivedStateMetadata flagged a reset as pending.
// Returns true if a reset was performed. Derived rows repopulate lazily on the
// next view read, exactly as with the previous synchronous reset.
export function runPendingDerivedStateReset(db: Database.Database): boolean {
  const pending = db.prepare(`
    SELECT component FROM derived_state_versions
    WHERE rebuild_required = 1
  `).all() as Array<{ component: DerivedStateComponent }>

  const pendingResetComponents = pending
    .map((row) => row.component)
    .filter((component) => DERIVED_STATE_RESET_COMPONENTS.has(component))

  if (pendingResetComponents.length === 0) return false

  resetDerivedState(db, `Derived state version changed: ${pendingResetComponents.join(', ')}`)

  const clear = db.prepare(`
    UPDATE derived_state_versions SET rebuild_required = 0, updated_at = ?
    WHERE component = ?
  `)
  const now = Date.now()
  const tx = db.transaction(() => {
    for (const component of pendingResetComponents) clear.run(now, component)
  })
  tx()

  return true
}

export function repairStoredIdentityColumns(db: Database.Database): void {
  if (hasMaintenanceRun(db, IDENTITY_COLUMNS_REPAIR_KEY)) return

  const sessionRows = db.prepare(`
    SELECT id, bundle_id, app_name
    FROM app_sessions
    WHERE raw_app_name IS NULL
       OR canonical_app_id IS NULL
       OR app_instance_id IS NULL
       OR capture_source IS NULL
       OR capture_version IS NULL
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
    WHERE (browser_bundle_id IS NOT NULL AND (canonical_browser_id IS NULL OR browser_profile_id IS NULL))
       OR (url IS NOT NULL AND (normalized_url IS NULL OR page_key IS NULL))
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
  markMaintenanceRun(db, IDENTITY_COLUMNS_REPAIR_KEY)
  // The repair UPDATEs evidence rows in place; the range-facts cache's
  // count/max signature cannot see that — bump the shared evidence epoch.
  bumpRangeFactsEvidenceEpoch(db)
}
