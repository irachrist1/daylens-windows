import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import type { AppCategory, TimelineAnalyzeProgress } from '../src/shared/types.ts'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { materializeTimelineDayProjection } from '../src/main/core/query/projections.ts'
import { analyzeTimelineDay } from '../src/main/services/analyzeDay.ts'

// DEV-270: per-block naming used to run one provider round-trip at a time, so a
// multi-block day spun for as long as the sum of every call. The calls are
// independent, so they now run with bounded concurrency, and the pipeline
// streams truthful progress while it works.

const TEST_DATE = '2026-04-22'

function localMs(hour: number, minute = 0): number {
  return new Date(2026, 3, 22, hour, minute, 0, 0).getTime()
}

function insertSession(
  db: Database.Database,
  title: string,
  startHour: number,
  durationMinutes: number,
  category: AppCategory,
  app: { bundleId: string; name: string },
): void {
  const startTime = localMs(startHour)
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, capture_source, capture_version
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'test', 1)
  `).run(app.bundleId, app.name, startTime, startTime + durationMinutes * 60_000, durationMinutes * 60, category, title, app.name)
}

// Four separate sittings (30-minute absences between them), each a distinct
// app/category so they neither fragment-merge nor regroup — four relabel targets.
function seedFourBlocks(db: Database.Database): void {
  insertSession(db, 'daylens tracker work', 8, 40, 'development', { bundleId: 'com.mitchellh.ghostty', name: 'Ghostty' })
  insertSession(db, 'Homepage redesign', 10, 40, 'design', { bundleId: 'com.figma.Desktop', name: 'Figma' })
  insertSession(db, 'Launch plan notes', 12, 40, 'writing', { bundleId: 'notion.id', name: 'Notion' })
  insertSession(db, 'Docs reading', 14, 40, 'browsing', { bundleId: 'com.google.Chrome', name: 'Google Chrome' })
}

test('per-block naming runs in parallel and streams truthful progress', async () => {
  const db = createProductionTestDatabase()
  seedFourBlocks(db)
  // Establish the four heuristic blocks so relabeling has real targets.
  const before = materializeTimelineDayProjection(db, TEST_DATE, null).blocks.filter((block) => !block.isLive)
  assert.ok(before.length >= 3, `expected several blocks to name, got ${before.length}`)

  let inFlight = 0
  let maxInFlight = 0
  const progress: TimelineAnalyzeProgress[] = []

  const result = await analyzeTimelineDay(db, TEST_DATE, {
    regroupPlan: async () => [],
    blockInsight: async (block) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 15))
      inFlight--
      return { label: `Named ${block.startTime}`, narrative: '' }
    },
    onProgress: (update) => progress.push(update),
  })

  assert.ok(maxInFlight >= 2, `naming must run concurrently; peak in-flight was ${maxInFlight}`)
  assert.ok(result.relabeled >= 3, `all eligible blocks were named; relabeled ${result.relabeled}`)

  // Progress is truthful: the naming phase reports a rising count that finishes
  // at the total, and the run reaches a finishing tick.
  const naming = progress.filter((update) => update.stage === 'naming')
  assert.ok(naming.length > 0, 'naming progress was emitted')
  const last = naming[naming.length - 1]
  assert.equal(last.done, last.total, 'the last naming tick reaches the total')
  assert.ok(last.total >= 3, 'the total reflects the real number of blocks named')
  assert.ok(progress.some((update) => update.stage === 'finishing'), 'a finishing tick is emitted')
  db.close()
})

test('a transient naming failure is retried and recovers (DEV-278)', async () => {
  const db = createProductionTestDatabase()
  seedFourBlocks(db)
  materializeTimelineDayProjection(db, TEST_DATE, null)

  let call = 0
  const result = await analyzeTimelineDay(db, TEST_DATE, {
    regroupPlan: async () => [],
    blockInsight: async (block) => {
      call++
      if (call === 1) throw new Error('provider hiccup')
      return { label: `Named ${block.startTime}`, narrative: '' }
    },
    onProgress: () => {},
  })

  assert.equal(result.failures.length, 0, 'a one-off provider hiccup is retried, not reported as un-nameable')
  assert.ok(result.relabeled >= 3, `every block ends up named; relabeled ${result.relabeled}`)
  db.close()
})

test('DEV-278: a day with a single relabel target still gets its retry', async () => {
  const db = createProductionTestDatabase()
  // One sitting → one relabel target. Its lone first-pass failure must not be
  // mistaken for a provider outage.
  insertSession(db, 'daylens tracker work', 8, 40, 'development', { bundleId: 'com.mitchellh.ghostty', name: 'Ghostty' })
  materializeTimelineDayProjection(db, TEST_DATE, null)

  let call = 0
  const result = await analyzeTimelineDay(db, TEST_DATE, {
    regroupPlan: async () => [],
    blockInsight: async (block) => {
      call++
      if (call === 1) throw new Error('provider hiccup')
      return { label: `Named ${block.startTime}`, narrative: '' }
    },
    onProgress: () => {},
  })

  assert.equal(result.failures.length, 0, 'the lone transient failure is retried, not reported')
  assert.ok(result.relabeled >= 1, 'the block ends up named')
  db.close()
})

test('a persistent naming failure is surfaced with its reason, not swallowed', async () => {
  const db = createProductionTestDatabase()
  seedFourBlocks(db)
  materializeTimelineDayProjection(db, TEST_DATE, null)

  const doomedStart = localMs(8)
  const result = await analyzeTimelineDay(db, TEST_DATE, {
    regroupPlan: async () => [],
    blockInsight: async (block) => {
      if (block.startTime === doomedStart) throw new Error('provider rejected the request')
      return { label: `Named ${block.startTime}`, narrative: '' }
    },
    onProgress: () => {},
  })

  assert.ok(result.failures.length >= 1, 'the failed block is reported, never silently dropped')
  assert.match(result.failures[0], /provider rejected the request/, 'the reason travels with the failure')
  assert.ok(result.relabeled >= 1, 'the blocks that succeeded are still named')
  db.close()
})
