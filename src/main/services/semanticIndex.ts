// Semantic "found by meaning" retrieval (memory-and-entities.md §Local
// semantic search, §Retrieval flow, DEV-180).
//
// The second retrieval path next to exact search (DEV-178): when the person
// remembers what something was ABOUT rather than the words on the window,
// "that pricing doc I worked on Tuesday" should find it. Everything stays on
// this device:
//
//   memory_records.semantic_text (the minimized factual representation the
//   exact indexer already writes)
//     → embedded locally in bounded background batches by the DEV-179 engine
//       (pinned all-MiniLM-L6-v2 int8 ONNX under transformers.js)
//     → stored in a sqlite-vec vec0 index in the SAME database, keyed through
//       memory_record_vectors bookkeeping rows that cascade with the records
//
// Deletion and correction propagation are free by construction: a day
// re-projection (correction, evidence exclusion, deletion, or a
// MEMORY_INDEX_VERSION bump) deletes the day's memory_records rows, the
// bookkeeping rows die in the same transaction (ON DELETE CASCADE), and a
// vec0 row without bookkeeping is invisible to every query. The re-projected
// records come back with embedding_model = NULL, so the background indexer
// re-embeds them — undoing an exclusion restores results *including
// re-embedding* (spec §Corrections and deletion).
//
// Honest absence: no model artifact, no loadable extension, or no runtime →
// semantic search reports why and returns nothing; exact and structured
// search never notice (spec §Failure behavior).
//
// LOCAL-ONLY: memory_record_vectors and the vec0 table have no sync-allowlist
// keys and can never serialize into a remote payload (tests/syncAllowlist.test.ts).
import { createRequire } from 'node:module'
import os from 'node:os'
import type Database from 'better-sqlite3'
import {
  searchSemanticMoments,
  type SearchOptions,
  type SessionSearchResult,
} from '../db/queries'
import {
  loadSemanticEmbedder,
  semanticModelAssetStatus,
  SEMANTIC_EMBEDDING_DIMS,
  SEMANTIC_MODEL_ID,
  SEMANTIC_MODEL_REVISION,
  type SemanticEmbedder,
} from './semanticEmbedder'

/** The engine DEV-179 chose (memory-and-entities.md §Chosen engine). */
export const SEMANTIC_ENGINE = 'sqlite-vec'

const EMBED_BATCH_SIZE = 32
/** vec0 rows orphaned by day re-projection are invisible to queries (the
 *  bookkeeping join filters them); each background tick sweeps a bounded
 *  batch so they don't accumulate k-NN slots. */
const ORPHAN_SWEEP_LIMIT = 1024

const nodeRequire = createRequire(__filename)

// ─── Vector store (sqlite-vec) ───────────────────────────────────────────────

type VectorStoreState =
  | { ok: true }
  | { ok: false; detail: string }

const vectorStoreByDb = new WeakMap<Database.Database, VectorStoreState>()

function vectorTableExists(db: Database.Database): boolean {
  return db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_semantic_vec'`,
  ).get() != null
}

/**
 * Load the sqlite-vec extension on this connection and make sure the vec0
 * index exists. Never throws; remembers the outcome per connection. The vec0
 * table cannot be created by migrations because the extension may be absent
 * there — it is derived state, rebuildable from re-embedding at any time.
 */
export function ensureVectorStore(db: Database.Database): VectorStoreState {
  const known = vectorStoreByDb.get(db)
  if (known) return known
  let state: VectorStoreState
  try {
    const sqliteVec = nodeRequire('sqlite-vec') as { getLoadablePath(): string }
    // SQLite dlopens the extension itself, so the path must be a real file —
    // point at the asar-unpacked copy when packaged.
    const loadablePath = sqliteVec.getLoadablePath().replace('app.asar', 'app.asar.unpacked')
    db.loadExtension(loadablePath)
    if (!vectorTableExists(db)) {
      db.exec(
        `CREATE VIRTUAL TABLE memory_semantic_vec USING vec0(embedding float[${SEMANTIC_EMBEDDING_DIMS}] distance_metric=cosine)`,
      )
    }
    state = { ok: true }
  } catch (error) {
    state = { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
  vectorStoreByDb.set(db, state)
  return state
}

function bookkeepingAvailable(db: Database.Database): boolean {
  return db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_record_vectors'`,
  ).get() != null
}

// ─── Incremental embedding ───────────────────────────────────────────────────

interface PendingRow {
  id: string
  date: string
  semantic_text: string
}

// High-sensitivity memory never enters the semantic index (spec §Local
// semantic search: "High-sensitivity evidence is excluded unless its own
// specification permits embedding" — none does today). The exclusion is
// enforced twice: here so the text is never embedded, and again at query
// time (searchSemanticMoments) so a record marked high AFTER it was embedded
// stops surfacing immediately, before any re-projection cleans it up.
const PENDING_FILTER = `
  memory_records.deleted_at IS NULL
  AND memory_records.sensitivity != 'high'
  AND memory_records.semantic_text IS NOT NULL
  AND memory_records.semantic_text != ''
  AND (
    memory_records.embedding_model IS NULL
    OR memory_records.embedding_model != ?
    OR memory_records.embedding_version IS NULL
    OR memory_records.embedding_version != ?
  )`

export function countSemanticPending(
  db: Database.Database,
  engine: { model: string; version: number },
): number {
  if (!bookkeepingAvailable(db)) return 0
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM memory_records WHERE ${PENDING_FILTER}`,
  ).get(engine.model, engine.version) as { c: number }
  return row.c
}

export function countSemanticEmbedded(db: Database.Database): number {
  if (!bookkeepingAvailable(db)) return 0
  const row = db.prepare(`SELECT COUNT(*) AS c FROM memory_record_vectors`).get() as { c: number }
  return row.c
}

export interface SemanticIndexProgress {
  embedded: number
  pending: number
  done: boolean
}

function vectorBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

/**
 * One bounded indexing step: embed up to `batchSize` records that the current
 * engine has not embedded yet (new records, re-projected days, or an
 * embedding-version bump), newest first so recent memory answers first.
 * Embedding runs OUTSIDE the transaction (it is the slow part); the write is
 * atomic per batch. Replaced vectors delete their old bookkeeping row, so a
 * model/version change swaps embeddings in place without a gap.
 */
export async function semanticIndexStep(
  db: Database.Database,
  embedder: SemanticEmbedder,
  options: { batchSize?: number } = {},
): Promise<SemanticIndexProgress> {
  const batchSize = options.batchSize ?? EMBED_BATCH_SIZE
  if (!bookkeepingAvailable(db)) return { embedded: 0, pending: 0, done: true }
  const store = ensureVectorStore(db)
  if (!store.ok) return { embedded: 0, pending: 0, done: true }

  reconcileLostVectors(db)
  scrubHighSensitivityVectors(db)

  const rows = db.prepare(`
    SELECT memory_records.id, memory_records.date, memory_records.semantic_text
    FROM memory_records
    WHERE ${PENDING_FILTER}
    ORDER BY memory_records.start_ms DESC
    LIMIT ?
  `).all(embedder.model, embedder.version, batchSize) as PendingRow[]

  if (rows.length > 0) {
    const vectors = await embedder.embed(rows.map((row) => row.semantic_text))
    const deleteBookkeeping = db.prepare(`DELETE FROM memory_record_vectors WHERE record_id = ?`)
    const insertBookkeeping = db.prepare(`
      INSERT INTO memory_record_vectors (record_id, date, model, model_version, dims, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    const insertVector = db.prepare(`INSERT INTO memory_semantic_vec (rowid, embedding) VALUES (?, ?)`)
    const stampRecord = db.prepare(`
      UPDATE memory_records SET embedding_model = ?, embedding_version = ? WHERE id = ?
    `)
    const now = Date.now()
    db.transaction(() => {
      for (const [index, row] of rows.entries()) {
        const vector = vectors[index]
        if (!vector || vector.length !== embedder.dims) {
          throw new Error(`embedder returned ${vector?.length ?? 0} dims, expected ${embedder.dims}`)
        }
        // A record embedded under an older engine gets its vector replaced;
        // the old vec0 row becomes an invisible orphan swept below.
        deleteBookkeeping.run(row.id)
        const inserted = insertBookkeeping.run(row.id, row.date, embedder.model, embedder.version, embedder.dims, now)
        insertVector.run(BigInt(inserted.lastInsertRowid), vectorBlob(vector))
        stampRecord.run(embedder.model, embedder.version, row.id)
      }
    })()
  }

  sweepOrphanedVectors(db)

  const pending = countSemanticPending(db, embedder)
  return { embedded: rows.length, pending, done: pending === 0 }
}

/** A record marked high-sensitivity AFTER it was embedded keeps nothing
 *  behind: the query filter already hides it instantly; this drops the stored
 *  vector too (the vec0 row becomes an invisible orphan for the sweep) and
 *  clears the engine stamp, so if the sensitivity is ever lowered the record
 *  simply becomes pending again. */
export function scrubHighSensitivityVectors(db: Database.Database): number {
  const dropped = db.prepare(`
    DELETE FROM memory_record_vectors WHERE record_id IN (
      SELECT id FROM memory_records WHERE sensitivity = 'high'
    )
  `).run().changes
  db.prepare(`
    UPDATE memory_records SET embedding_model = NULL, embedding_version = NULL
    WHERE sensitivity = 'high' AND embedding_model IS NOT NULL
  `).run()
  return dropped
}

/** The inverse repair of the orphan sweep: bookkeeping rows whose vec0 row
 *  vanished (a corrupt or wiped vector index) reset their records to pending,
 *  so the index rebuilds itself from the permitted memory records — no manual
 *  recovery step (spec §Failure behavior: "A corrupt index is rebuilt from
 *  permitted memory records"). Bounded per call; the background loop finishes
 *  the job across ticks. */
export function reconcileLostVectors(db: Database.Database): number {
  if (!vectorTableExists(db) || !bookkeepingAvailable(db)) return 0
  // Cheap steady-state guard: vectors can only be "lost" when the vec0 table
  // holds fewer rows than the bookkeeping claims (orphans from re-projection
  // only push the vec0 count the other way, and the sweep drains those). Skip
  // the per-row join unless the counts say something is missing.
  const bookkeepingCount = (db.prepare(`SELECT COUNT(*) AS c FROM memory_record_vectors`).get() as { c: number }).c
  if (bookkeepingCount === 0) return 0
  const vecCount = (db.prepare(`SELECT COUNT(*) AS c FROM memory_semantic_vec`).get() as { c: number }).c
  if (vecCount >= bookkeepingCount) return 0
  const lost = db.prepare(`
    SELECT vectors.record_id AS record_id
    FROM memory_record_vectors vectors
    LEFT JOIN memory_semantic_vec ON memory_semantic_vec.rowid = vectors.vec_rowid
    WHERE memory_semantic_vec.rowid IS NULL
    LIMIT ?
  `).all(ORPHAN_SWEEP_LIMIT) as Array<{ record_id: string }>
  if (lost.length === 0) return 0
  const dropBookkeeping = db.prepare(`DELETE FROM memory_record_vectors WHERE record_id = ?`)
  const resetRecord = db.prepare(`
    UPDATE memory_records SET embedding_model = NULL, embedding_version = NULL WHERE id = ?
  `)
  db.transaction(() => {
    for (const row of lost) {
      dropBookkeeping.run(row.record_id)
      resetRecord.run(row.record_id)
    }
  })()
  return lost.length
}

/** Delete a bounded batch of vec0 rows whose bookkeeping row died with a day
 *  re-projection. They were already invisible to queries; this reclaims space
 *  and k-NN candidate slots. */
export function sweepOrphanedVectors(db: Database.Database): number {
  if (!vectorTableExists(db) || !bookkeepingAvailable(db)) return 0
  const orphans = db.prepare(`
    SELECT memory_semantic_vec.rowid AS rowid
    FROM memory_semantic_vec
    LEFT JOIN memory_record_vectors ON memory_record_vectors.vec_rowid = memory_semantic_vec.rowid
    WHERE memory_record_vectors.vec_rowid IS NULL
    LIMIT ?
  `).all(ORPHAN_SWEEP_LIMIT) as Array<{ rowid: number | bigint }>
  if (orphans.length === 0) return 0
  const remove = db.prepare(`DELETE FROM memory_semantic_vec WHERE rowid = ?`)
  db.transaction(() => {
    for (const orphan of orphans) remove.run(orphan.rowid)
  })()
  return orphans.length
}

// ─── Power/load guard ────────────────────────────────────────────────────────
// Embedding is deferrable work; it must not tax a machine that is already
// drawing from battery or busy (spec: re-embedding "can pause on battery or
// load"). The guard gates the background loop only — corrections, queries,
// and the manual step stay untouched, and search keeps answering from
// whatever is already embedded while paused.

export interface SemanticPowerState {
  onBattery: boolean
  overloaded: boolean
}

function defaultPowerState(): SemanticPowerState {
  let onBattery = false
  try {
    // Present in the Electron main process; under plain Node (tests, tooling)
    // the require yields no powerMonitor and the battery signal reads false.
    const electron = nodeRequire('electron') as {
      powerMonitor?: { isOnBattery?: () => boolean }
    }
    onBattery = electron.powerMonitor?.isOnBattery?.() === true
  } catch {
    // No power signal available — never paused on its account.
  }
  // Conservative load signal: pause while the 1-minute load average exceeds
  // the core count (loadavg reports 0 on Windows, so this never fires there).
  const overloaded = os.loadavg()[0] > Math.max(1, os.cpus().length)
  return { onBattery, overloaded }
}

let powerStateProvider: () => SemanticPowerState = defaultPowerState

/** Test seam for the battery/load pause. Pass null to restore the real signal. */
export function setSemanticPowerStateProviderForTests(
  provider: (() => SemanticPowerState) | null,
): void {
  powerStateProvider = provider ?? defaultPowerState
}

export function semanticIndexingPausedNow(): { paused: boolean; reason: 'on-battery' | 'system-load' | null } {
  const state = powerStateProvider()
  if (state.onBattery) return { paused: true, reason: 'on-battery' }
  if (state.overloaded) return { paused: true, reason: 'system-load' }
  return { paused: false, reason: null }
}

// ─── Background indexing ─────────────────────────────────────────────────────

let indexTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Background embedding: a bounded batch per tick so the main process stays
 * responsive (spec: "Re-embedding runs in bounded background batches"). The
 * loop pauses while the machine is on battery or under load and resumes on
 * the next tick when the condition clears. When the index is current it
 * drops to a slow idle cadence instead of stopping, so records re-projected
 * by later corrections (embedding_model reset to NULL) are re-embedded
 * without the correction paths having to know about embeddings at all.
 * Honest absence: when the model or extension is unavailable the loop
 * exits — status explains why, exact search unaffected.
 */
export function startSemanticIndexBackfill(
  getDatabase: () => Database.Database,
  options: { stepDelayMs?: number; idleDelayMs?: number; batchSize?: number } = {},
): void {
  if (indexTimer) return
  const stepDelayMs = options.stepDelayMs ?? 2_000
  const idleDelayMs = options.idleDelayMs ?? 5 * 60_000
  const step = async (): Promise<void> => {
    indexTimer = null
    let progress: SemanticIndexProgress
    try {
      if (semanticIndexingPausedNow().paused) {
        indexTimer = setTimeout(() => void step(), idleDelayMs)
        return
      }
      const loaded = await loadSemanticEmbedder()
      if (!loaded.ok) {
        // Honest absence — status explains why. Absence can be transient (a
        // crashed embed worker, a model restored while running), so keep the
        // loop alive at the idle cadence instead of stopping until restart.
        indexTimer = setTimeout(() => void step(), idleDelayMs)
        return
      }
      progress = await semanticIndexStep(getDatabase(), loaded.embedder, {
        batchSize: options.batchSize,
      })
    } catch (error) {
      console.error('[semanticIndex] background step failed', error)
      if (!indexTimer) {
        indexTimer = setTimeout(() => void step(), idleDelayMs)
      }
      return
    }
    if (!indexTimer) {
      indexTimer = setTimeout(() => void step(), progress.done ? idleDelayMs : stepDelayMs)
    }
  }
  indexTimer = setTimeout(() => void step(), stepDelayMs)
}

export function stopSemanticIndexBackfill(): void {
  if (indexTimer) {
    clearTimeout(indexTimer)
    indexTimer = null
  }
}

// ─── Query path ──────────────────────────────────────────────────────────────

export interface SemanticSearchOutcome {
  results: SessionSearchResult[]
  /** False when the model, runtime, extension, or vector store is missing. */
  available: boolean
  /** Empty when available; a person-readable sentence otherwise. */
  reason: string
}

/**
 * Find memory by meaning, reporting whether the path could run at all.
 *
 * `searchByMeaning` collapses "ran, matched nothing" and "cannot run here" into
 * the same `[]`, which is right for a purely additive palette section and wrong
 * for the retrieval planner: AC-SM-001.6 requires the planner to return the
 * other paths' results *and say* that semantic retrieval was unavailable. This
 * variant carries that distinction; `searchByMeaning` is its wrapper.
 */
export async function searchByMeaningWithStatus(
  db: Database.Database,
  query: string,
  opts: SearchOptions = {},
): Promise<SemanticSearchOutcome> {
  const trimmed = query.trim()
  if (trimmed.length < 2) {
    return { results: [], available: false, reason: 'The query is too short to match by meaning.' }
  }
  try {
    if (!bookkeepingAvailable(db)) {
      return { results: [], available: false, reason: 'The local semantic index has not been created yet.' }
    }
    const loaded = await loadSemanticEmbedder()
    if (!loaded.ok) {
      return { results: [], available: false, reason: 'The local embedding model is not available on this device.' }
    }
    const store = ensureVectorStore(db)
    if (!store.ok) {
      return { results: [], available: false, reason: 'Local vector search is not available on this device.' }
    }
    const [queryVector] = await loaded.embedder.embed([trimmed])
    if (!queryVector) {
      return { results: [], available: false, reason: 'The query could not be embedded locally.' }
    }
    return {
      results: searchSemanticMoments(
        db,
        queryVector,
        { model: loaded.embedder.model, version: loaded.embedder.version },
        opts,
      ),
      available: true,
      reason: '',
    }
  } catch (error) {
    console.error('[semanticIndex] by-meaning search failed', error)
    return { results: [], available: false, reason: 'Semantic retrieval failed on this device.' }
  }
}

/**
 * Find memory by meaning: embed the query locally, k-NN over the embedded
 * records, corrected/deleted content filtered exactly like the exact readers.
 * Returns [] — never an error — when the model, runtime, or extension is
 * unavailable, so callers can present semantic hits as a purely additive
 * section below exact matches.
 */
export async function searchByMeaning(
  db: Database.Database,
  query: string,
  opts: SearchOptions = {},
): Promise<SessionSearchResult[]> {
  return (await searchByMeaningWithStatus(db, query, opts)).results
}

// ─── Status (Settings surface) ───────────────────────────────────────────────

export interface SemanticSearchStatus {
  available: boolean
  /** Why semantic search is absent when it is; 'ready' otherwise. */
  reason: 'ready' | 'model-missing' | 'runtime-missing' | 'load-failed' | 'vector-store-unavailable'
  detail: string | null
  engine: typeof SEMANTIC_ENGINE
  modelId: string
  modelRevision: string
  /** Model artifact on disk (shipped with the installer / models:semantic). */
  modelPresent: boolean
  modelBytes: number
  embeddedRecords: number
  pendingRecords: number
}

export async function getSemanticSearchStatus(db: Database.Database): Promise<SemanticSearchStatus> {
  const asset = semanticModelAssetStatus()
  const base: Pick<
    SemanticSearchStatus,
    'engine' | 'modelId' | 'modelRevision' | 'modelPresent' | 'modelBytes' | 'embeddedRecords'
  > = {
    engine: SEMANTIC_ENGINE,
    modelId: SEMANTIC_MODEL_ID,
    modelRevision: SEMANTIC_MODEL_REVISION,
    modelPresent: asset.present,
    modelBytes: asset.bytes,
    embeddedRecords: countSemanticEmbedded(db),
  }
  const loaded = await loadSemanticEmbedder()
  if (!loaded.ok) {
    return {
      ...base,
      available: false,
      reason: loaded.reason,
      detail: loaded.detail,
      pendingRecords: 0,
    }
  }
  const store = ensureVectorStore(db)
  if (!store.ok) {
    return {
      ...base,
      available: false,
      reason: 'vector-store-unavailable',
      detail: store.detail,
      pendingRecords: 0,
    }
  }
  return {
    ...base,
    available: true,
    reason: 'ready',
    detail: null,
    pendingRecords: countSemanticPending(db, {
      model: loaded.embedder.model,
      version: loaded.embedder.version,
    }),
  }
}
