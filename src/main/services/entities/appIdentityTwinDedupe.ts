// One install, one identity (#22 / DEV-224).
//
// The poll capture backend used to key an app by its executable path whenever
// the active-window module reported no bundle id, while macOS focus events key
// the same install by its real CFBundleIdentifier. Apps outside the
// normalization catalog (Traycer, Canva desktop, Raycast Beta) got
// canonical_app_id = NULL, so the raw key became the identity: one install →
// two app_identities rows → two application entities.
//
// This module collapses the existing twins. Equivalence is ONLY the resolved
// bundle-id/path mapping — the executable path's own Info.plist naming the
// bundle identifier the other row is keyed by. Display names are never
// identity (two different products sharing a vague name stay separate; the
// Needs-attention review is where a person decides those).
//
// Nothing is deleted. Twin entities merge through the existing reversible
// pointer machinery (status='merged' + merged_into_id — aliases and evidence
// stay on their rows, split/undo restores them), identity rows are linked via
// canonical_app_id, and historical app_sessions get the unified id stamped
// into the derived canonical_app_id column so Apps/Timeline group one app.
// A user's explicit corrections outrank this collapse: an entity the user
// renamed survives as the merge target, and a pair the user already merged is
// left exactly as they arranged it.
import type Database from 'better-sqlite3'
import { resolveMergeChain, type EntityRow } from './entityRepository'
import { bumpRangeFactsEvidenceEpoch } from '../../core/query/rangeFactsCache'

export interface AppIdentityTwinDedupeResult {
  /** Path-keyed identity rows whose bundle id resolved to a change. */
  pathIdentitiesResolved: number
  /** app_identities rows linked to the unified id via canonical_app_id. */
  identityRowsLinked: number
  /** Twin entities merged into their surviving (bundle-keyed or user-renamed) twin. */
  entitiesMerged: number
  /** Path-keyed entities with no counterpart, re-keyed to the bundle identity
   *  so fresh bundle-keyed captures resolve to them instead of minting twins. */
  entitiesRekeyed: number
  /** Historical app_sessions rows stamped with the unified canonical id. */
  sessionsRestamped: number
}

interface AppIdentityRow {
  app_instance_id: string
  bundle_id: string
  canonical_app_id: string | null
  first_seen_at: number
  last_seen_at: number
  metadata_json: string
}

const MAC_EXECUTABLE_PATH_RE = /^\/.*\.app(?:\/|$)/i

/** A raw identity that is a macOS executable/bundle path, not a bundle id. */
export function looksLikeMacExecutablePathIdentity(value: string | null | undefined): boolean {
  const trimmed = value?.trim()
  return Boolean(trimmed && MAC_EXECUTABLE_PATH_RE.test(trimmed))
}

function applicationEntityByKey(db: Database.Database, identityKey: string): EntityRow | null {
  return (db.prepare(
    `SELECT * FROM entities WHERE entity_type = 'application' AND identity_key = ?`,
  ).get(identityKey) as EntityRow | undefined) ?? null
}

/** Merge `loser` into `winner` with the same reversible pointer flip the
 *  Settings merge uses — aliases and evidence refs stay on their rows. */
function mergeEntityPair(db: Database.Database, winnerId: string, loserId: string): void {
  const now = Date.now()
  db.prepare(`UPDATE entities SET status = 'merged', merged_into_id = ?, updated_at = ? WHERE id = ?`)
    .run(winnerId, now, loserId)
  db.prepare(`UPDATE entities SET updated_at = ? WHERE id = ?`).run(now, winnerId)
}

export function dedupeAppIdentityTwins(
  db: Database.Database,
  resolveBundleIdForExecutablePath: (executablePath: string) => string | null,
): AppIdentityTwinDedupeResult {
  const result: AppIdentityTwinDedupeResult = {
    pathIdentitiesResolved: 0,
    identityRowsLinked: 0,
    entitiesMerged: 0,
    entitiesRekeyed: 0,
    sessionsRestamped: 0,
  }

  const rows = db.prepare(`
    SELECT app_instance_id, bundle_id, canonical_app_id, first_seen_at, last_seen_at, metadata_json
    FROM app_identities
  `).all() as AppIdentityRow[]
  if (rows.length === 0) return result

  const byInstanceId = new Map(rows.map((row) => [row.app_instance_id, row]))
  const byInstanceIdLower = new Map<string, AppIdentityRow>()
  for (const row of rows) {
    const lower = row.app_instance_id.toLowerCase()
    if (!byInstanceIdLower.has(lower)) byInstanceIdLower.set(lower, row)
  }

  const dedupe = db.transaction(() => {
    for (const row of rows) {
      if (!looksLikeMacExecutablePathIdentity(row.app_instance_id)) continue

      // Unresolvable (uninstalled, moved, unreadable plist): leave the row.
      // Any twin stays visible in Needs attention for a human decision —
      // a shared display name alone is never treated as the same install.
      const resolved = resolveBundleIdForExecutablePath(row.app_instance_id)?.trim()
      if (!resolved || resolved === row.app_instance_id) continue

      const pathCanonical = row.canonical_app_id?.trim() || null
      const counterpart = byInstanceId.get(resolved)
        ?? byInstanceIdLower.get(resolved.toLowerCase())
        ?? null
      // A path row that already carries a canonical id and has no row keyed by
      // its bundle id is already grouped — there is nothing keyed apart to unify.
      if (!counterpart && pathCanonical) continue

      const counterpartCanonical = counterpart?.canonical_app_id?.trim() || null
      // One id for the whole install: an existing canonical grouping (either
      // side's) wins over the raw bundle id, so history stays where the user
      // has been seeing it; otherwise the bundle-keyed instance id — exactly
      // what fresh captures mint after the tracking fix.
      const unifiedId = pathCanonical
        ?? counterpartCanonical
        ?? counterpart?.app_instance_id
        ?? resolved
      let changed = false

      // Link the identity rows through canonical_app_id.
      if (pathCanonical !== unifiedId) {
        db.prepare(`UPDATE app_identities SET canonical_app_id = ? WHERE app_instance_id = ?`)
          .run(unifiedId, row.app_instance_id)
        result.identityRowsLinked += 1
        changed = true

        if (counterpart) {
          // The surviving row's observation range covers both keys of the one
          // install, and it learns the executable path the twin carried.
          const counterpartMetadata = parseMetadata(counterpart.metadata_json)
          if (!counterpartMetadata.executablePath) {
            counterpartMetadata.executablePath =
              parseMetadata(row.metadata_json).executablePath ?? row.app_instance_id
          }
          db.prepare(`
            UPDATE app_identities
            SET first_seen_at = MIN(first_seen_at, ?),
                last_seen_at = MAX(last_seen_at, ?),
                metadata_json = ?
            WHERE app_instance_id = ?
          `).run(
            row.first_seen_at,
            row.last_seen_at,
            JSON.stringify(counterpartMetadata),
            counterpart.app_instance_id,
          )
        }
      }
      if (
        counterpart
        && counterpartCanonical !== unifiedId
        && unifiedId !== counterpart.app_instance_id
      ) {
        db.prepare(`UPDATE app_identities SET canonical_app_id = ? WHERE app_instance_id = ?`)
          .run(unifiedId, counterpart.app_instance_id)
        result.identityRowsLinked += 1
        changed = true
      }

      // Entities. Each side's pre-dedupe identity key is app:<canonical ?? instance>;
      // every key that differs from the unified key holds a twin. The twin
      // either merges into the unified entity (reversibly) or, when no unified
      // entity exists yet, takes over the unified key so future captures and
      // adoption re-runs resolve to it instead of minting a fresh twin.
      const unifiedKey = `app:${unifiedId}`
      const twinKeys = [...new Set([
        `app:${pathCanonical ?? row.app_instance_id}`,
        counterpart ? `app:${counterpartCanonical ?? counterpart.app_instance_id}` : null,
      ].filter((key): key is string => Boolean(key) && key !== unifiedKey))]
      let unifiedEntity = applicationEntityByKey(db, unifiedKey)
      for (const twinKey of twinKeys) {
        const twin = applicationEntityByKey(db, twinKey)
        if (!twin) continue
        if (!unifiedEntity) {
          db.prepare(`UPDATE entities SET identity_key = ?, updated_at = ? WHERE id = ?`)
            .run(unifiedKey, Date.now(), twin.id)
          unifiedEntity = { ...twin, identity_key: unifiedKey }
          result.entitiesRekeyed += 1
          changed = true
          continue
        }
        const unifiedSurvivor = resolveMergeChain(db, unifiedEntity)
        const twinSurvivor = resolveMergeChain(db, twin)
        // Already one entity — e.g. the user merged the pair by hand. Their
        // arrangement (including which side survived) stands untouched.
        if (unifiedSurvivor.id === twinSurvivor.id) continue
        // An explicit user rename outranks this inference: the renamed entity
        // survives, whichever key it carries. Ties (both or neither renamed)
        // keep the entity on the unified key — the one fresh captures resolve.
        const twinWins = twinSurvivor.name_source === 'user' && unifiedSurvivor.name_source !== 'user'
        const winner = twinWins ? twinSurvivor : unifiedSurvivor
        const loser = twinWins ? unifiedSurvivor : twinSurvivor
        mergeEntityPair(db, winner.id, loser.id)
        result.entitiesMerged += 1
        changed = true
      }

      // Historical sessions carry the raw path in bundle_id (raw evidence —
      // untouched). canonical_app_id is the derived grouping column the read
      // layer already prefers; stamping it groups old and new time as one app.
      const restamped = db.prepare(`
        UPDATE app_sessions
        SET canonical_app_id = ?
        WHERE bundle_id = ? AND (canonical_app_id IS NULL OR canonical_app_id = '')
      `).run(unifiedId, row.bundle_id).changes
      result.sessionsRestamped += restamped
      changed = changed || restamped > 0

      if (changed) result.pathIdentitiesResolved += 1
    }
  })
  dedupe()
  // Restamping canonical_app_id UPDATEs evidence rows in place; the
  // range-facts cache's count/max signature cannot see that — bump the
  // shared evidence epoch so every process's cache drops stale windows.
  if (result.sessionsRestamped > 0 || result.entitiesMerged > 0) bumpRangeFactsEvidenceEpoch(db)
  return result
}

function parseMetadata(rawValue: string | null | undefined): { executablePath?: string | null } & Record<string, unknown> {
  if (!rawValue) return {}
  try {
    const parsed = JSON.parse(rawValue) as Record<string, unknown> | null
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
