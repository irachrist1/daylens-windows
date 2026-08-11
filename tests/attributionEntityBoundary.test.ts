// Attribution reads through the entity-graph boundary (WO-34 / DEV-246).
// Identity resolves via resolveEntityByLabel; ambiguous labels never silently
// pick a client/project and invent attributed minutes for the wrong subject.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import {
  addEntityAlias,
  upsertEntity,
} from '../src/main/services/entities/entityRepository.ts'
import {
  findClientByName,
  findProjectByName,
  resolveClientByLabel,
  resolveClientQuery,
  resolveProjectByLabel,
} from '../src/main/core/query/attributionResolvers.ts'

function seedClient(
  db: ReturnType<typeof createProductionTestDatabase>,
  id: string,
  name: string,
): void {
  const now = Date.now()
  db.prepare(`
    INSERT INTO clients (id, name, color, status, created_at, updated_at)
    VALUES (?, ?, NULL, 'active', ?, ?)
  `).run(id, name, now, now)
  db.prepare(`
    INSERT INTO client_aliases (id, client_id, alias, alias_normalized, source, created_at)
    VALUES (?, ?, ?, ?, 'user', ?)
  `).run(`alias-${id}`, id, name, name.toLowerCase(), now)
  upsertEntity(db, {
    type: 'client',
    identityKey: `supplied:${id}`,
    name,
    origin: 'supplied',
    id,
    observedAt: now,
  })
  addEntityAlias(db, id, name, { source: 'user' })
}

function seedProject(
  db: ReturnType<typeof createProductionTestDatabase>,
  id: string,
  name: string,
  clientId: string | null = null,
): void {
  const now = Date.now()
  db.prepare(`
    INSERT INTO projects (id, client_id, name, code, color, status, created_at, updated_at)
    VALUES (?, ?, ?, NULL, NULL, 'active', ?, ?)
  `).run(id, clientId, name, now, now)
  db.prepare(`
    INSERT INTO project_aliases (id, project_id, alias, alias_normalized, source, created_at)
    VALUES (?, ?, ?, ?, 'user', ?)
  `).run(`palias-${id}`, id, name, name.toLowerCase(), now)
  upsertEntity(db, {
    type: 'project',
    identityKey: `supplied:${id}`,
    name,
    origin: 'supplied',
    id,
    observedAt: now,
  })
  addEntityAlias(db, id, name, { source: 'user' })
}

function seedAttributedSession(
  db: ReturnType<typeof createProductionTestDatabase>,
  opts: { id: string; clientId: string; projectId?: string | null; activeMs: number; startedAt: number },
): void {
  const endedAt = opts.startedAt + opts.activeMs
  const now = Date.now()
  db.prepare(`
    INSERT INTO work_sessions (
      id, device_id, started_at, ended_at, duration_ms, active_ms, idle_ms,
      client_id, project_id, attribution_status, attribution_confidence,
      title, primary_bundle_id, app_bundle_ids_json, created_at, updated_at
    ) VALUES (?, 'test-device', ?, ?, ?, ?, 0, ?, ?, 'attributed', 0.95, ?, 'com.example.app', '[]', ?, ?)
  `).run(
    opts.id,
    opts.startedAt,
    endedAt,
    opts.activeMs,
    opts.activeMs,
    opts.clientId,
    opts.projectId ?? null,
    'Work',
    now,
    now,
  )
}

test('ambiguous shared alias returns candidates and does not silently pick a client', () => {
  const db = createProductionTestDatabase()
  try {
    seedClient(db, 'client-acme', 'ACME Corporation')
    seedClient(db, 'client-acmenta', 'Acmenta Labs')
    addEntityAlias(db, 'client-acme', 'acme', { source: 'user' })
    addEntityAlias(db, 'client-acmenta', 'acme', { source: 'inferred' })

    const resolved = resolveClientByLabel('acme', db)
    assert.equal(resolved.client, null, 'ambiguous label must not select a client')
    assert.equal(resolved.candidates.length, 2)
    assert.equal(findClientByName('acme', db), null)

    // The old LIKE LIMIT 1 path would have returned the shorter "Acmenta Labs"
    // and then attributed that client's minutes to the ask.
    const fromMs = Date.UTC(2026, 7, 1)
    const toMs = Date.UTC(2026, 7, 8)
    seedAttributedSession(db, {
      id: 'ws-short',
      clientId: 'client-acmenta',
      activeMs: 10 * 60_000,
      startedAt: fromMs + 3_600_000,
    })
    seedAttributedSession(db, {
      id: 'ws-long',
      clientId: 'client-acme',
      activeMs: 3 * 3_600_000 + 43 * 60_000,
      startedAt: fromMs + 7_200_000,
    })

    assert.equal(
      findClientByName('acme', db),
      null,
      'DEV-246 guard: ambiguous label must not bind either client\'s hours',
    )
  } finally {
    db.close()
  }
})

test('unique entity alias resolves to the surviving client', () => {
  const db = createProductionTestDatabase()
  try {
    seedClient(db, 'client-portal', 'Customer Portal')
    addEntityAlias(db, 'client-portal', 'the portal', { source: 'user' })

    const resolved = resolveClientByLabel('the portal', db)
    assert.equal(resolved.client?.id, 'client-portal')
    assert.equal(resolved.matchedBy, 'alias')
    assert.equal(findClientByName('the portal', db)?.id, 'client-portal')
  } finally {
    db.close()
  }
})

test('substring that matches two clients does not silently pick the shortest', () => {
  const db = createProductionTestDatabase()
  try {
    seedClient(db, 'client-learn', 'Learning Lab')
    seedClient(db, 'client-deep', 'Deep Learning Partners')

    // Neither shares an exact alias; the removed fuzzy LIMIT 1 would have
    // returned "Learning Lab" for the needle "learning".
    assert.equal(findClientByName('learning', db), null)
    const resolved = resolveClientByLabel('learning', db)
    assert.equal(resolved.client, null)
    assert.ok(resolved.candidates.length >= 2)
  } finally {
    db.close()
  }
})

test('resolveClientQuery surfaces entity-graph aliases including a prior canonical name', () => {
  const db = createProductionTestDatabase()
  try {
    seedClient(db, 'client-renamed', 'Old Name Co')
    db.prepare(`UPDATE entities SET canonical_name = 'New Name Co', name_source = 'user' WHERE id = ?`)
      .run('client-renamed')
    addEntityAlias(db, 'client-renamed', 'Old Name Co', { source: 'user' })
    addEntityAlias(db, 'client-renamed', 'ONC', { source: 'user' })

    const fromMs = Date.UTC(2026, 7, 1)
    const toMs = Date.UTC(2026, 7, 2)
    seedAttributedSession(db, {
      id: 'ws-1',
      clientId: 'client-renamed',
      activeMs: 30 * 60_000,
      startedAt: fromMs + 60_000,
    })

    const payload = resolveClientQuery('client-renamed', fromMs, toMs, 'how long on New Name Co?', db)
    assert.ok(payload)
    assert.equal(payload!.target.client_name, 'New Name Co')
    assert.ok(payload!.target.aliases.includes('Old Name Co'))
    assert.ok(payload!.target.aliases.includes('ONC'))
    assert.equal(payload!.totals.attributed_ms, 30 * 60_000)
    assert.equal(payload!.sessions[0]?.confidence, 0.95)
    assert.equal(payload!.sessions[0]?.attribution_status, 'attributed')
  } finally {
    db.close()
  }
})

test('ambiguous project label returns candidates without a silent pick', () => {
  const db = createProductionTestDatabase()
  try {
    seedClient(db, 'client-a', 'Client A')
    seedProject(db, 'project-alpha', 'Alpha Portal', 'client-a')
    seedProject(db, 'project-beta', 'Beta Portal', 'client-a')
    addEntityAlias(db, 'project-alpha', 'portal', { source: 'user' })
    addEntityAlias(db, 'project-beta', 'portal', { source: 'inferred' })

    const resolved = resolveProjectByLabel('portal', db)
    assert.equal(resolved.project, null)
    assert.equal(resolved.candidates.length, 2)
    assert.equal(findProjectByName('portal', db), null)
  } finally {
    db.close()
  }
})
