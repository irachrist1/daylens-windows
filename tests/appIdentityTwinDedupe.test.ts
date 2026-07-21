// Same app, one entity (#22 / DEV-224).
//
// The poll capture backend keyed an app by executable path when the
// active-window module reported no bundle id; macOS focus events key the same
// install by CFBundleIdentifier. For apps outside the normalization catalog
// (Traycer, Canva desktop, Raycast Beta) that minted two app_identities rows
// and two forever-living entities.
//
// Covered here:
//   - mint-time unification: both backends reporting the same install produce
//     ONE identity and ONE entity (through the real poll FSM),
//   - the v59 dedupe: path-keyed twins collapse onto their bundle-keyed
//     counterpart through the reversible merge machinery; user renames and
//     prior explicit merges outrank; equivalence is ONLY the resolved
//     bundle-id/path mapping — never a shared display name,
//   - re-mint prevention (issue Done-when #3): after the dedupe, fresh
//     captures and adoption re-runs do not resurrect the twins.
import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { clearTestDb, setTestDb } from './support/database-stub.mjs'
import {
  __setTrackingFsmTestHarness,
  __pollForTest,
} from '../src/main/services/tracking.ts'
import {
  dedupeAppIdentityTwins,
  looksLikeMacExecutablePathIdentity,
} from '../src/main/services/entities/appIdentityTwinDedupe.ts'
import { runEntityAdoptionBackfill } from '../src/main/services/entities/entityAdoption.ts'
import { applyEntityCorrection } from '../src/main/services/entities/entityCorrections.ts'
import { upsertAppIdentityObservation } from '../src/main/core/inference/appIdentityRegistry.ts'
import type { EntityRow } from '../src/main/services/entities/entityRepository.ts'

const TRAYCER_PATH = '/Applications/Traycer.app/Contents/MacOS/Traycer'
const TRAYCER_BUNDLE = 'com.traycer.app'
const CANVA_PATH = '/Applications/Canva Desktop.app/Contents/MacOS/CanvaDesktop'
const CANVA_BUNDLE = 'com.canva.CanvaDesktop'
const RAYCAST_PATH = '/Applications/Raycast Beta.app/Contents/MacOS/Raycast'
const RAYCAST_BUNDLE = 'com.raycast.macos.beta'

const BASE = new Date(2026, 6, 6, 10, 0, 0, 0).getTime()

// The two shapes the real backends hand the poll for the same install:
// active-window (no bundle id, executable path) vs focus events (the
// CFBundleIdentifier travels in `path` — see recentMacFocusEventWindow).
const TRAYCER_ACTIVE_WINDOW = {
  title: 'Traycer — plan',
  application: 'Traycer',
  path: TRAYCER_PATH,
  pid: 4001,
  icon: '',
}
const TRAYCER_FOCUS_EVENTS = {
  title: 'Traycer — plan',
  application: 'Traycer',
  path: TRAYCER_BUNDLE,
  pid: 4001,
  icon: '',
}
const OTHER_WIN = {
  title: 'Draft notes',
  application: 'TextEdit',
  path: '/Applications/TextEdit.app',
  pid: 4321,
  icon: '',
}

function activeApplicationEntities(db: Database.Database, name: string): EntityRow[] {
  return db.prepare(`
    SELECT * FROM entities
    WHERE entity_type = 'application' AND status = 'active' AND LOWER(canonical_name) = LOWER(?)
  `).all(name) as EntityRow[]
}

function applicationEntityByKey(db: Database.Database, identityKey: string): EntityRow {
  const row = db.prepare(`SELECT * FROM entities WHERE entity_type = 'application' AND identity_key = ?`)
    .get(identityKey) as EntityRow | undefined
  assert.ok(row, `expected an application entity at ${identityKey}`)
  return row
}

function seedIdentity(
  db: Database.Database,
  input: { instanceId: string; displayName: string; canonicalAppId?: string | null; firstSeenAt?: number; lastSeenAt?: number },
): void {
  db.prepare(`
    INSERT INTO app_identities (app_instance_id, bundle_id, raw_app_name, canonical_app_id, display_name, first_seen_at, last_seen_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, '{}')
  `).run(
    input.instanceId,
    input.instanceId,
    input.displayName,
    input.canonicalAppId ?? null,
    input.displayName,
    input.firstSeenAt ?? BASE - 86_400_000,
    input.lastSeenAt ?? BASE,
  )
}

// ─── Mint-time unification through the real poll path ───────────────────────

test('both capture backends mint ONE identity for the same install once the path resolves its bundle id', async () => {
  const db = createProductionTestDatabase()
  setTestDb(db)
  let win = TRAYCER_ACTIVE_WINDOW as typeof TRAYCER_ACTIVE_WINDOW | typeof TRAYCER_FOCUS_EVENTS | typeof OTHER_WIN
  const clock = { now: BASE, lastInput: BASE }
  __setTrackingFsmTestHarness({
    platform: 'darwin',
    now: () => clock.now,
    idleSeconds: () => Math.max(0, (clock.now - clock.lastInput) / 1_000),
    activeWindow: () => win,
    resolveMacBundleId: (executablePath) =>
      executablePath.startsWith('/Applications/Traycer.app/') ? TRAYCER_BUNDLE : null,
  })
  const poll = async (nowMs: number): Promise<void> => {
    clock.now = nowMs
    clock.lastInput = nowMs
    await __pollForTest()
  }
  try {
    // Backend one: the active-window poll knows only the executable path.
    await poll(BASE)
    await poll(BASE + 60_000)
    win = OTHER_WIN
    await poll(BASE + 90_000)

    // Backend two: focus events report the real CFBundleIdentifier.
    win = TRAYCER_FOCUS_EVENTS
    await poll(BASE + 120_000)
    await poll(BASE + 180_000)
    win = OTHER_WIN
    await poll(BASE + 210_000)

    // Slice 10: the canonical record is the only persisted record — every
    // Traycer foreground event from both backends must carry the bundle id.
    const canonicalBundles = db.prepare(`
      SELECT DISTINCT app_bundle_id FROM focus_events
      WHERE app_name = 'Traycer' AND app_bundle_id IS NOT NULL
    `).all() as Array<{ app_bundle_id: string }>
    assert.deepEqual(
      canonicalBundles.map((row) => row.app_bundle_id),
      [TRAYCER_BUNDLE],
      'the poll path must mint the bundle id, not the path',
    )

    const identities = db.prepare(`
      SELECT app_instance_id, metadata_json FROM app_identities WHERE raw_app_name = 'Traycer'
    `).all() as Array<{ app_instance_id: string; metadata_json: string }>
    assert.equal(identities.length, 1, 'one install, one app_identities row')
    assert.equal(identities[0].app_instance_id, TRAYCER_BUNDLE)
    // The executable path survives as metadata on the unified identity; the
    // focus-events "path" (really the bundle id) never overwrites it.
    assert.equal(
      (JSON.parse(identities[0].metadata_json) as { executablePath?: string }).executablePath,
      TRAYCER_PATH,
    )

    runEntityAdoptionBackfill(db)
    assert.equal(activeApplicationEntities(db, 'Traycer').length, 1, 'one install, one entity')
  } finally {
    __setTrackingFsmTestHarness(null)
    clearTestDb()
    db.close()
  }
})

test('without bundle resolution the path fallback still stands (last resort, and the pre-fix twin shape)', async () => {
  const db = createProductionTestDatabase()
  setTestDb(db)
  let win = TRAYCER_ACTIVE_WINDOW as typeof TRAYCER_ACTIVE_WINDOW | typeof TRAYCER_FOCUS_EVENTS | typeof OTHER_WIN
  const clock = { now: BASE, lastInput: BASE }
  __setTrackingFsmTestHarness({
    platform: 'darwin',
    now: () => clock.now,
    idleSeconds: () => Math.max(0, (clock.now - clock.lastInput) / 1_000),
    activeWindow: () => win,
    // No resolveMacBundleId: an unreadable bundle keeps the raw path as identity.
  })
  const poll = async (nowMs: number): Promise<void> => {
    clock.now = nowMs
    clock.lastInput = nowMs
    await __pollForTest()
  }
  try {
    await poll(BASE)
    win = OTHER_WIN
    await poll(BASE + 60_000)
    win = TRAYCER_FOCUS_EVENTS
    await poll(BASE + 90_000)
    win = OTHER_WIN
    await poll(BASE + 150_000)

    const identities = db.prepare(`
      SELECT app_instance_id FROM app_identities WHERE raw_app_name = 'Traycer' ORDER BY app_instance_id
    `).all() as Array<{ app_instance_id: string }>
    assert.deepEqual(
      identities.map((row) => row.app_instance_id),
      [TRAYCER_PATH, TRAYCER_BUNDLE],
      'unresolved paths keep the twin shape the dedupe migration collapses',
    )
  } finally {
    __setTrackingFsmTestHarness(null)
    clearTestDb()
    db.close()
  }
})

// ─── The dedupe (migration v59 body) ─────────────────────────────────────────

const RESOLVER_MAP: Record<string, string> = {
  [TRAYCER_PATH]: TRAYCER_BUNDLE,
  [CANVA_PATH]: CANVA_BUNDLE,
  [RAYCAST_PATH]: RAYCAST_BUNDLE,
  '/Applications/Studio.app/Contents/MacOS/Studio': 'com.alpha.studio',
  '/Applications/Notion Fake.app/Contents/MacOS/Notion Fake': 'com.notionfake.app',
}

function fakeResolver(executablePath: string): string | null {
  return RESOLVER_MAP[executablePath] ?? null
}

function seedTwinWorld(): Database.Database {
  const db = createProductionTestDatabase()
  // Canva desktop: the issue's twin — path row + bundle row, both catalog misses.
  seedIdentity(db, { instanceId: CANVA_PATH, displayName: 'Canva Desktop', firstSeenAt: BASE - 10 * 86_400_000 })
  seedIdentity(db, { instanceId: CANVA_BUNDLE, displayName: 'Canva Desktop' })
  // Raycast Beta: the path row's exe basename hit the catalog ('raycast') but
  // the beta bundle id missed it — same install, still keyed apart.
  seedIdentity(db, { instanceId: RAYCAST_PATH, displayName: 'Raycast Beta', canonicalAppId: 'raycast' })
  seedIdentity(db, { instanceId: RAYCAST_BUNDLE, displayName: 'Raycast Beta' })
  // Traycer: path row only — the bundle-keyed capture hasn't happened yet.
  seedIdentity(db, { instanceId: TRAYCER_PATH, displayName: 'Traycer' })
  // Two DIFFERENT products that share a display name: must never merge.
  seedIdentity(db, { instanceId: '/Applications/Studio.app/Contents/MacOS/Studio', displayName: 'Studio' })
  seedIdentity(db, { instanceId: 'com.beta.studio', displayName: 'Studio' })
  // A path identity whose app is gone — unresolvable, must be left alone.
  seedIdentity(db, { instanceId: '/Applications/Ghost.app/Contents/MacOS/Ghost', displayName: 'Ghost' })
  seedIdentity(db, { instanceId: 'com.ghost.app', displayName: 'Ghost' })
  // Historical sessions captured under the path key (canonical_app_id NULL).
  db.prepare(`
    INSERT INTO app_sessions (bundle_id, app_name, start_time, end_time, duration_sec, category)
    VALUES (?, 'Canva Desktop', ?, ?, 600, 'design'), (?, 'Canva Desktop', ?, ?, 300, 'design')
  `).run(
    CANVA_PATH, BASE, BASE + 600_000,
    CANVA_PATH, BASE + 700_000, BASE + 1_000_000,
  )
  runEntityAdoptionBackfill(db)
  return db
}

test('path identity is recognized structurally, never by name', () => {
  assert.equal(looksLikeMacExecutablePathIdentity(TRAYCER_PATH), true)
  assert.equal(looksLikeMacExecutablePathIdentity('/Applications/TextEdit.app'), true)
  assert.equal(looksLikeMacExecutablePathIdentity(TRAYCER_BUNDLE), false)
  assert.equal(looksLikeMacExecutablePathIdentity('com.foo.app'), false)
  assert.equal(looksLikeMacExecutablePathIdentity('C:\\Program Files\\Canva\\Canva.exe'), false)
  assert.equal(looksLikeMacExecutablePathIdentity(''), false)
  assert.equal(looksLikeMacExecutablePathIdentity(null), false)
})

test('dedupe collapses path/bundle twins reversibly and leaves name-only pairs alone', () => {
  const db = seedTwinWorld()
  try {
    assert.equal(activeApplicationEntities(db, 'Canva Desktop').length, 2, 'the twins exist before the dedupe')

    const result = dedupeAppIdentityTwins(db, fakeResolver)

    // Canva + Raycast Beta merged; Traycer and the Studio path re-keyed to
    // their own bundle ids; Ghost untouched.
    assert.equal(result.pathIdentitiesResolved, 4)
    assert.equal(result.identityRowsLinked, 4)
    assert.equal(result.entitiesMerged, 2)
    assert.equal(result.entitiesRekeyed, 2)
    assert.equal(result.sessionsRestamped, 2)

    // One active Canva; the twin is merged (not deleted) into the
    // bundle-keyed survivor, so the merge is reversible via split/undo.
    const canva = activeApplicationEntities(db, 'Canva Desktop')
    assert.equal(canva.length, 1)
    assert.equal(canva[0].identity_key, `app:${CANVA_BUNDLE}`)
    const mergedTwin = applicationEntityByKey(db, `app:${CANVA_PATH}`)
    assert.equal(mergedTwin.status, 'merged')
    assert.equal(mergedTwin.merged_into_id, canva[0].id)

    // Raycast Beta: the bundle-keyed entity merged into the canonical-keyed
    // one, and the bundle row now carries the same canonical id.
    const raycast = activeApplicationEntities(db, 'Raycast Beta')
    assert.equal(raycast.length, 1)
    assert.equal(raycast[0].identity_key, 'app:raycast')
    const raycastBundleRow = db.prepare(`SELECT canonical_app_id FROM app_identities WHERE app_instance_id = ?`)
      .get(RAYCAST_BUNDLE) as { canonical_app_id: string | null }
    assert.equal(raycastBundleRow.canonical_app_id, 'raycast')

    // Traycer had no bundle-keyed counterpart: its entity now carries the
    // bundle identity key so the first bundle-keyed capture resolves to it.
    const traycer = activeApplicationEntities(db, 'Traycer')
    assert.equal(traycer.length, 1)
    assert.equal(traycer[0].identity_key, `app:${TRAYCER_BUNDLE}`)

    // Two different products sharing the name "Studio" stay two entities.
    assert.equal(activeApplicationEntities(db, 'Studio').length, 2)

    // Unresolvable Ghost pair is left for the Needs-attention review.
    assert.equal(activeApplicationEntities(db, 'Ghost').length, 2)
    const ghostRow = db.prepare(`SELECT canonical_app_id FROM app_identities WHERE app_instance_id = ?`)
      .get('/Applications/Ghost.app/Contents/MacOS/Ghost') as { canonical_app_id: string | null }
    assert.equal(ghostRow.canonical_app_id, null)

    // Historical sessions group as the unified app via the derived column;
    // the raw bundle_id evidence is untouched.
    const sessions = db.prepare(`SELECT bundle_id, canonical_app_id FROM app_sessions WHERE app_name = 'Canva Desktop'`)
      .all() as Array<{ bundle_id: string; canonical_app_id: string | null }>
    assert.equal(sessions.length, 2)
    for (const session of sessions) {
      assert.equal(session.bundle_id, CANVA_PATH)
      assert.equal(session.canonical_app_id, CANVA_BUNDLE)
    }

    // The surviving identity row absorbed the twin's range and learned its path.
    const canvaIdentity = db.prepare(`
      SELECT first_seen_at, metadata_json FROM app_identities WHERE app_instance_id = ?
    `).get(CANVA_BUNDLE) as { first_seen_at: number; metadata_json: string }
    assert.equal(canvaIdentity.first_seen_at, BASE - 10 * 86_400_000)
    assert.equal(
      (JSON.parse(canvaIdentity.metadata_json) as { executablePath?: string }).executablePath,
      CANVA_PATH,
    )

    // Idempotent: a second run finds nothing left to do.
    const rerun = dedupeAppIdentityTwins(db, fakeResolver)
    assert.deepEqual(rerun, {
      pathIdentitiesResolved: 0,
      identityRowsLinked: 0,
      entitiesMerged: 0,
      entitiesRekeyed: 0,
      sessionsRestamped: 0,
    })
  } finally {
    db.close()
  }
})

test('a user rename outranks the dedupe: the renamed entity survives the merge', () => {
  const db = seedTwinWorld()
  try {
    const pathEntity = applicationEntityByKey(db, `app:${CANVA_PATH}`)
    applyEntityCorrection(db, { kind: 'entity-rename', entityId: pathEntity.id, name: 'Canva (desktop)' })

    dedupeAppIdentityTwins(db, fakeResolver)

    const survivors = activeApplicationEntities(db, 'Canva (desktop)')
    assert.equal(survivors.length, 1, 'the user-renamed entity is the survivor')
    assert.equal(survivors[0].id, pathEntity.id)
    assert.equal(survivors[0].name_source, 'user')
    const bundleEntity = applicationEntityByKey(db, `app:${CANVA_BUNDLE}`)
    assert.equal(bundleEntity.status, 'merged')
    assert.equal(bundleEntity.merged_into_id, pathEntity.id)
    assert.equal(activeApplicationEntities(db, 'Canva Desktop').length, 0)
  } finally {
    db.close()
  }
})

test('a prior explicit merge stands exactly as the user arranged it', () => {
  const db = seedTwinWorld()
  try {
    seedIdentity(db, { instanceId: '/Applications/Notion Fake.app/Contents/MacOS/Notion Fake', displayName: 'Notion Fake' })
    seedIdentity(db, { instanceId: 'com.notionfake.app', displayName: 'Notion Fake' })
    runEntityAdoptionBackfill(db)
    const pathEntity = applicationEntityByKey(db, 'app:/Applications/Notion Fake.app/Contents/MacOS/Notion Fake')
    const bundleEntity = applicationEntityByKey(db, 'app:com.notionfake.app')
    // The user merged the pair by hand — and chose the path entity as target.
    applyEntityCorrection(db, { kind: 'entity-merge', targetId: pathEntity.id, sourceId: bundleEntity.id })

    dedupeAppIdentityTwins(db, fakeResolver)

    const after = db.prepare(`SELECT * FROM entities WHERE id = ?`).get(bundleEntity.id) as EntityRow
    assert.equal(after.status, 'merged')
    assert.equal(after.merged_into_id, pathEntity.id, 'the user-chosen merge direction is untouched')
    const survivor = db.prepare(`SELECT * FROM entities WHERE id = ?`).get(pathEntity.id) as EntityRow
    assert.equal(survivor.status, 'active')
  } finally {
    db.close()
  }
})

// ─── Re-mint prevention (issue Done-when #3) ─────────────────────────────────

test('after the dedupe, fresh captures from either backend do not resurrect the twins', () => {
  const db = seedTwinWorld()
  try {
    dedupeAppIdentityTwins(db, fakeResolver)

    // Fresh bundle-keyed capture (focus events, or the poll path post-fix).
    upsertAppIdentityObservation(db, {
      bundleId: CANVA_BUNDLE,
      rawAppName: 'Canva Desktop',
      firstSeenAt: BASE + 2_000_000,
      lastSeenAt: BASE + 2_060_000,
    })
    // Traycer's FIRST bundle-keyed capture — before the fix this minted the twin.
    upsertAppIdentityObservation(db, {
      bundleId: TRAYCER_BUNDLE,
      rawAppName: 'Traycer',
      firstSeenAt: BASE + 2_000_000,
      lastSeenAt: BASE + 2_060_000,
    })
    // Raycast Beta keeps arriving bundle-keyed too.
    upsertAppIdentityObservation(db, {
      bundleId: RAYCAST_BUNDLE,
      rawAppName: 'Raycast Beta',
      firstSeenAt: BASE + 2_000_000,
      lastSeenAt: BASE + 2_060_000,
    })
    // A path-keyed observation whose bundle resolution failed this once must
    // not clear the stored canonical link.
    upsertAppIdentityObservation(db, {
      bundleId: CANVA_PATH,
      rawAppName: 'Canva Desktop',
      firstSeenAt: BASE + 3_000_000,
      lastSeenAt: BASE + 3_060_000,
    })
    const pathRow = db.prepare(`SELECT canonical_app_id FROM app_identities WHERE app_instance_id = ?`)
      .get(CANVA_PATH) as { canonical_app_id: string | null }
    assert.equal(pathRow.canonical_app_id, CANVA_BUNDLE, 'the dedupe link outlives later observations')

    // Adoption re-runs over everything and still resolves to one entity each.
    runEntityAdoptionBackfill(db)
    assert.equal(activeApplicationEntities(db, 'Canva Desktop').length, 1)
    assert.equal(activeApplicationEntities(db, 'Traycer').length, 1)
    assert.equal(activeApplicationEntities(db, 'Raycast Beta').length, 1)
  } finally {
    db.close()
  }
})
