import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import type { AppSession } from '../src/shared/types.ts'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { buildTimelineBlocksFromSessions } from '../src/main/services/workBlocks.ts'
import { blockActiveSeconds } from '../src/shared/blockDuration.ts'

const FLOOR_SECONDS = 15 * 60

// Local-time millis on a fixed day, so block boundaries are deterministic.
function at(hour: number, minute: number): number {
  return new Date(2026, 3, 12, hour, minute, 0, 0).getTime()
}

let nextId = 1
function session(opts: {
  bundleId: string
  appName?: string
  category: AppSession['category']
  startTime: number
  endTime: number
  windowTitle?: string | null
}): AppSession {
  return {
    id: nextId++,
    bundleId: opts.bundleId,
    appName: opts.appName ?? opts.bundleId,
    startTime: opts.startTime,
    endTime: opts.endTime,
    durationSeconds: Math.round((opts.endTime - opts.startTime) / 1000),
    category: opts.category,
    isFocused: opts.category === 'development' || opts.category === 'aiTools',
    windowTitle: opts.windowTitle ?? null,
    rawAppName: opts.appName ?? opts.bundleId,
    canonicalAppId: opts.bundleId,
    appInstanceId: opts.bundleId,
    captureSource: 'foreground_poll',
    endedReason: null,
    captureVersion: 2,
  }
}

function freshDb(): Database.Database {
  return createProductionTestDatabase()
}

function seedActivityEvent(db: Database.Database, tsMs: number, type: string): void {
  db.prepare(`INSERT INTO activity_state_events (event_ts, event_type, source, metadata_json) VALUES (?, ?, 'system', '{}')`).run(tsMs, type)
}

function seedWebsiteVisit(db: Database.Database, opts: {
  domain: string
  pageTitle?: string | null
  url: string
  visitTime: number
  durationSec: number
  browserBundleId?: string | null
}): void {
  db.prepare(`
    INSERT INTO website_visits (
      domain,
      page_title,
      url,
      visit_time,
      visit_time_us,
      duration_sec,
      browser_bundle_id,
      canonical_browser_id,
      normalized_url,
      page_key,
      source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'test')
  `).run(
    opts.domain,
    opts.pageTitle ?? null,
    opts.url,
    opts.visitTime,
    opts.visitTime * 1000,
    opts.durationSec,
    opts.browserBundleId ?? null,
    opts.browserBundleId ?? null,
    opts.url,
    opts.url,
  )
}

function labels(db: Database.Database, sessions: AppSession[]): { count: number; spans: string[] } {
  const blocks = buildTimelineBlocksFromSessions(db, sessions)
  return {
    count: blocks.length,
    spans: blocks.map((b) => `${new Date(b.startTime).getHours()}:${String(new Date(b.startTime).getMinutes()).padStart(2, '0')}-${new Date(b.endTime).getHours()}:${String(new Date(b.endTime).getMinutes()).padStart(2, '0')}`),
  }
}

// FIX: an assisted-work pair (AI tool + the editor it's driving) separated by a
// short interruption inside one segment is ONE coding session. The 10-min gap is
// past the 5-min soft-merge threshold, so this does NOT merge via shouldSoftMerge
// (the once-hypothesised "widen the gap window to 15 min" was proven inert and
// reverted). It merges in the sub-30 absorption pass because aiTools + development
// is recognised as an assisted-work pair, hence `candidatesRelated`.
test('assisted-work pair across a 10-minute gap is one block', () => {
  const db = freshDb()
  const sessions = [
    session({ bundleId: 'com.openai.codex', appName: 'Codex', category: 'aiTools', startTime: at(10, 0), endTime: at(10, 22), windowTitle: 'codex · daylens' }),
    session({ bundleId: 'com.microsoft.VSCode', appName: 'Code', category: 'development', startTime: at(10, 32), endTime: at(10, 58), windowTitle: 'workBlocks.ts — daylens' }),
  ]
  const result = labels(db, sessions)
  assert.equal(result.count, 1, `expected one merged coding block, got ${result.count}: ${result.spans.join(', ')}`)
  db.close()
})

// REGRESSION: a tiny overnight blip (a 24s glance at Claude at 1:56am) must not
// fold across the multi-hour sleep gap into the morning's work. The sliver floor
// used to fold any sub-15min block into its nearest neighbour with no gap check,
// producing one 11-hour block that started at 2am and made the whole wrap lie.
test('an overnight sliver does not fold across the sleep gap into the morning block', () => {
  const db = freshDb()
  const sessions = [
    session({ bundleId: 'com.anthropic.claude', appName: 'Claude', category: 'aiTools', startTime: at(1, 56), endTime: at(1, 56) + 24_000, windowTitle: 'Claude' }),
    session({ bundleId: 'com.apple.Terminal', appName: 'Terminal', category: 'development', startTime: at(9, 41), endTime: at(10, 11), windowTitle: 'daylens — onboarding-ux-redesign' }),
    session({ bundleId: 'com.anthropic.claude', appName: 'Claude', category: 'aiTools', startTime: at(10, 11), endTime: at(10, 50), windowTitle: 'Claude' }),
  ]
  const blocks = buildTimelineBlocksFromSessions(db, sessions)
  const spans = blocks.map((b) => `${new Date(b.startTime).getHours()}:${String(new Date(b.startTime).getMinutes()).padStart(2, '0')}-${new Date(b.endTime).getHours()}:${String(new Date(b.endTime).getMinutes()).padStart(2, '0')}`)
  // The 24s pre-dawn blip is noise: it is neither foldable across the sleep gap
  // nor a block of its own, so it is dropped entirely. No block touches 1-5am.
  const preDawn = blocks.some((b) => new Date(b.startTime).getHours() < 5)
  assert.equal(preDawn, false, `the overnight blip should be dropped, not shown: ${spans.join(', ')}`)
  // The real morning work block starts at 9:41am, not 1:56am.
  const morning = blocks.find((b) => blockActiveSeconds(b) >= FLOOR_SECONDS)
  assert.ok(morning, `expected a real morning block: ${spans.join(', ')}`)
  assert.equal(new Date(morning!.startTime).getHours(), 9, `morning block should start at 9am, got ${spans.join(', ')}`)
  db.close()
})

// GUARD (distinct topics): two different browsing topics in the same browser are
// two different things. They share a top app and the browsing category, so the
// topic-sensitive content-context check (different window titles) is the only
// thing keeping them apart — in both shouldSoftMerge and candidatesRelated. Do
// not loosen it.
test('two distinct browsing topics stay separate', () => {
  const db = freshDb()
  const sessions = [
    session({ bundleId: 'com.apple.Safari', appName: 'Safari', category: 'browsing', startTime: at(11, 0), endTime: at(11, 26), windowTitle: 'pull requests · github' }),
    session({ bundleId: 'com.apple.Safari', appName: 'Safari', category: 'browsing', startTime: at(11, 34), endTime: at(12, 0), windowTitle: 'cooking pasta · youtube' }),
  ]
  const result = labels(db, sessions)
  assert.equal(result.count, 2, `distinct browsing topics must not merge, got ${result.count}: ${result.spans.join(', ')}`)
  db.close()
})

// GUARD (runaway watching, R4): the same video activity split by a real session
// break (away 45+ minutes, machine locked) stays two blocks. Distant
// same-intent spans must NOT bridge into one runaway "watching" block.
test('entertainment across a real 45+ minute gap stays separate', () => {
  const db = freshDb()
  seedActivityEvent(db, at(14, 50), 'lock')
  seedActivityEvent(db, at(15, 28), 'unlock')
  const sessions = [
    session({ bundleId: 'com.apple.Safari', appName: 'Safari', category: 'entertainment', startTime: at(14, 0), endTime: at(14, 40), windowTitle: 'documentary · youtube' }),
    session({ bundleId: 'com.apple.Safari', appName: 'Safari', category: 'entertainment', startTime: at(15, 30), endTime: at(16, 10), windowTitle: 'documentary · youtube' }),
  ]
  const result = labels(db, sessions)
  assert.equal(result.count, 2, `entertainment across a real gap must stay separate, got ${result.count}: ${result.spans.join(', ')}`)
  db.close()
})

// FIX (timeline.md §3.2/§3.5): a brief (<10 min) Netflix peek in the middle of
// a coding stretch folds into the surrounding work — one block, named for the
// work, never "Watching Netflix", and the category stays development (one
// off-task tab can't flip it, §3.6).
test('a brief Netflix peek inside coding folds into the work block', () => {
  const db = freshDb()
  const sessions = [
    session({ bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startTime: at(9, 0), endTime: at(9, 30), windowTitle: 'workBlocks.ts — daylens' }),
    session({ bundleId: 'com.apple.Safari', appName: 'Safari', category: 'entertainment', startTime: at(9, 30), endTime: at(9, 36), windowTitle: 'Stranger Things · Netflix' }),
    session({ bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startTime: at(9, 36), endTime: at(10, 6), windowTitle: 'workBlocks.ts — daylens' }),
  ]
  const blocks = buildTimelineBlocksFromSessions(db, sessions)
  assert.equal(blocks.length, 1, `peek should fold into one coding block, got ${blocks.length}`)
  assert.equal(blocks[0].dominantCategory, 'development', `a Netflix peek must not flip the category, got ${blocks[0].dominantCategory}`)
  assert.doesNotMatch(blocks[0].label.current.toLowerCase(), /netflix|watching/, `work block must not be named after the peek, got "${blocks[0].label.current}"`)
  db.close()
})

// GUARD (R4 still holds): a *sustained* (>=10 min) off-task stretch between work
// is NOT a brief peek — it stays its own block.
test('a sustained Netflix stretch inside coding stays its own block', () => {
  const db = freshDb()
  const sessions = [
    session({ bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startTime: at(9, 0), endTime: at(9, 30), windowTitle: 'workBlocks.ts — daylens' }),
    session({ bundleId: 'com.apple.Safari', appName: 'Safari', category: 'entertainment', startTime: at(9, 30), endTime: at(9, 52), windowTitle: 'Stranger Things · Netflix' }),
    session({ bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startTime: at(9, 52), endTime: at(10, 22), windowTitle: 'workBlocks.ts — daylens' }),
  ]
  const result = labels(db, sessions)
  assert.equal(result.count, 3, `a 22-minute Netflix stretch must stand alone, got ${result.count}: ${result.spans.join(', ')}`)
  db.close()
})

test('a brief social peek folds into the same productivity intent', () => {
  const db = freshDb()
  const sessions = [
    session({ bundleId: 'com.notion.id', appName: 'Notion', category: 'productivity', startTime: at(9, 0), endTime: at(9, 30), windowTitle: 'Q3 launch checklist' }),
    session({ bundleId: 'com.apple.Safari', appName: 'Safari', category: 'social', startTime: at(9, 30), endTime: at(9, 36), windowTitle: 'Home / X' }),
    session({ bundleId: 'com.notion.id', appName: 'Notion', category: 'productivity', startTime: at(9, 36), endTime: at(10, 6), windowTitle: 'Q3 launch checklist' }),
  ]
  const blocks = buildTimelineBlocksFromSessions(db, sessions)
  assert.equal(blocks.length, 1, `brief social peek should fold into the same productivity block, got ${blocks.length}`)
  assert.equal(blocks[0].dominantCategory, 'productivity')
  db.close()
})

test('a brief detour does not merge different intents on either side', () => {
  const db = freshDb()
  const sessions = [
    session({ bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startTime: at(9, 0), endTime: at(9, 30), windowTitle: 'workBlocks.ts — daylens' }),
    session({ bundleId: 'com.apple.Safari', appName: 'Safari', category: 'social', startTime: at(9, 30), endTime: at(9, 36), windowTitle: 'Home / X' }),
    session({ bundleId: 'com.microsoft.Word', appName: 'Word', category: 'writing', startTime: at(9, 36), endTime: at(10, 6), windowTitle: 'Quarterly report' }),
  ]
  const blocks = buildTimelineBlocksFromSessions(db, sessions)
  assert.equal(blocks.length, 2, `the detour should be absorbed without erasing the development→writing intent change, got ${blocks.length}`)
  assert.deepEqual(blocks.map((block) => block.dominantCategory), ['development', 'writing'])
  db.close()
})

// FIX (contentless sliver): a sub-30-min Safari fragment with no window titles
// and no page artifacts sits between two stretches of architecture-review work.
// It carries no independent meaning, so it folds into a neighbour even though
// browsing ≠ development/aiTools. Without this, the sliver stands alone as a
// third block.
test('contentless browsing sliver between work stretches is absorbed', () => {
  const db = freshDb()
  const sessions = [
    session({ bundleId: 'com.microsoft.VSCode', appName: 'Code', category: 'development', startTime: at(9, 0), endTime: at(9, 8), windowTitle: 'PERF-COHERENCE-MAP.md — daylens' }),
    session({ bundleId: 'com.apple.Safari', appName: 'Safari', category: 'browsing', startTime: at(9, 9), endTime: at(9, 21), windowTitle: null }),
    session({ bundleId: 'com.openai.codex', appName: 'Codex', category: 'aiTools', startTime: at(9, 22), endTime: at(10, 5), windowTitle: 'codex · daylens architecture' }),
  ]
  const result = labels(db, sessions)
  assert.equal(result.count, 1, `contentless sliver should fold into the work stretch, got ${result.count}: ${result.spans.join(', ')}`)
  db.close()
})

// GUARD (nearest neighbour): contentless slivers do not use the normal
// same-category preference. They attach to the nearest non-meeting neighbour.
test('contentless browsing sliver chooses the nearest neighbour', () => {
  const db = freshDb()
  const sessions = [
    session({ bundleId: 'com.microsoft.VSCode', appName: 'Code', category: 'development', startTime: at(9, 0), endTime: at(9, 30), windowTitle: 'PERF-COHERENCE-MAP.md — daylens' }),
    session({ bundleId: 'com.apple.Safari', appName: 'Safari', category: 'browsing', startTime: at(9, 35), endTime: at(9, 45), windowTitle: null }),
    session({ bundleId: 'com.openai.codex', appName: 'Codex', category: 'aiTools', startTime: at(9, 46), endTime: at(10, 15), windowTitle: 'codex · daylens architecture' }),
  ]
  const result = labels(db, sessions)
  assert.deepEqual(result.spans, ['9:00-9:30', '9:35-10:15'], `sliver should attach right by nearest gap, got ${result.spans.join(', ')}`)
  db.close()
})

// GUARD (page artifacts): a titleless browser fragment that has page evidence is
// not contentless, so it must not be swallowed across unrelated categories.
// Durations sit above the 15-min calendar floor (DEV-99) so this exercises the
// contentless-vs-page-backed distinction, not the floor: an 18-min page-backed
// browsing block between unrelated work stays its own block.
test('browser sliver with a page artifact stays separate', () => {
  const db = freshDb()
  seedWebsiteVisit(db, {
    domain: 'example.com',
    pageTitle: 'Architecture review notes',
    url: 'https://example.com/architecture',
    visitTime: at(9, 24),
    durationSec: 12 * 60,
    browserBundleId: 'com.apple.Safari',
  })
  const sessions = [
    session({ bundleId: 'com.microsoft.VSCode', appName: 'Code', category: 'development', startTime: at(9, 0), endTime: at(9, 22), windowTitle: 'PERF-COHERENCE-MAP.md — daylens' }),
    session({ bundleId: 'com.apple.Safari', appName: 'Safari', category: 'browsing', startTime: at(9, 23), endTime: at(9, 41), windowTitle: null }),
    session({ bundleId: 'com.openai.codex', appName: 'Codex', category: 'aiTools', startTime: at(9, 42), endTime: at(10, 25), windowTitle: 'codex · daylens architecture' }),
  ]
  const result = labels(db, sessions)
  assert.equal(result.count, 3, `page-backed browser sliver must remain separate, got ${result.count}: ${result.spans.join(', ')}`)
  db.close()
})

// GUARD (scope): the special bypass is for titleless browser slivers. A
// titleless non-browser activity may still be meaningful and must not disappear
// merely because it lacks a captured title. Durations sit above the 15-min
// calendar floor (DEV-99) so this guards the bypass scope, not the floor: an
// 18-min titleless Mail block between unrelated work stays its own block.
test('titleless non-browser short activity is not contentless sliver absorption', () => {
  const db = freshDb()
  const sessions = [
    session({ bundleId: 'com.microsoft.VSCode', appName: 'Code', category: 'development', startTime: at(9, 0), endTime: at(9, 22), windowTitle: 'PERF-COHERENCE-MAP.md — daylens' }),
    session({ bundleId: 'com.apple.mail', appName: 'Mail', category: 'email', startTime: at(9, 23), endTime: at(9, 41), windowTitle: null }),
    session({ bundleId: 'com.openai.codex', appName: 'Codex', category: 'aiTools', startTime: at(9, 42), endTime: at(10, 25), windowTitle: 'codex · daylens architecture' }),
  ]
  const result = labels(db, sessions)
  assert.equal(result.count, 3, `titleless Mail activity must stay separate, got ${result.count}: ${result.spans.join(', ')}`)
  db.close()
})

// GUARD (true sliver): the special case is a fragment between other activity.
// A titleless browser block at the edge of a segment may be the user's actual
// activity and should not be erased just because it lacks a captured page title.
// Durations sit above the 15-min calendar floor (DEV-99) so this guards the
// "edge fragment is not a sliver" rule, not the floor.
test('edge titleless browser activity is not absorbed as a sliver', () => {
  const db = freshDb()
  const sessions = [
    session({ bundleId: 'com.apple.Safari', appName: 'Safari', category: 'browsing', startTime: at(9, 0), endTime: at(9, 18), windowTitle: null }),
    session({ bundleId: 'com.openai.codex', appName: 'Codex', category: 'aiTools', startTime: at(9, 19), endTime: at(10, 6), windowTitle: 'codex · daylens architecture' }),
  ]
  const result = labels(db, sessions)
  assert.equal(result.count, 2, `edge browser activity must stay separate, got ${result.count}: ${result.spans.join(', ')}`)
  db.close()
})

// FIX (the YouTube-with-a-break case): the same video, a 2-minute detour, back
// to the same video — one continuous block, not three. There is no duration
// ceiling (DEV-232), so this stays one block however long it runs; the test
// isolates detour-absorption from the real-absence split.
test('same video with a short detour is one block', () => {
  const db = freshDb()
  const sessions = [
    session({ bundleId: 'com.apple.Safari', appName: 'Safari', category: 'entertainment', startTime: at(7, 0), endTime: at(7, 50), windowTitle: 'long lecture · youtube' }),
    session({ bundleId: 'com.google.Chrome', appName: 'Chrome', category: 'browsing', startTime: at(7, 50), endTime: at(7, 52), windowTitle: 'how long is a marathon · google' }),
    session({ bundleId: 'com.apple.Safari', appName: 'Safari', category: 'entertainment', startTime: at(7, 52), endTime: at(8, 35), windowTitle: 'long lecture · youtube' }),
  ]
  const result = labels(db, sessions)
  assert.equal(result.count, 1, `same video either side of a 2-min detour should be one block, got ${result.count}: ${result.spans.join(', ')}`)
  db.close()
})

// FLOOR (DEV-99 / timeline.md §3.4): no block under fifteen minutes stands
// alone. A morning with brief (sub-15-minute) lulls and an 8-minute Spotify
// blip is one continuous sitting under the 15-minute session break — the blip
// and the brief lulls fold INTO the work, never out as slivers.
test('a sub-15-minute sliver between brief lulls folds into the surrounding work', () => {
  const db = freshDb()
  const sessions = [
    session({ bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startTime: at(9, 0), endTime: at(9, 40), windowTitle: 'workBlocks.ts — daylens' }),
    session({ bundleId: 'com.spotify.client', appName: 'Spotify', category: 'entertainment', startTime: at(9, 50), endTime: at(9, 58), windowTitle: 'Discover Weekly' }),
    session({ bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startTime: at(10, 8), endTime: at(10, 48), windowTitle: 'workBlocks.ts — daylens' }),
  ]
  const blocks = buildTimelineBlocksFromSessions(db, sessions)
  assert.equal(blocks.length, 1, `one sitting of the same work should be one block, got ${blocks.length}`)
  for (const block of blocks) {
    assert.ok(blockActiveSeconds(block) >= FLOOR_SECONDS, `no block may sit under the 15-min floor, got ${blockActiveSeconds(block)}s`)
  }
  db.close()
})

// The 15-minute session break: real activity
// gaps of 15+ minutes END the block and are never absorbed. The same morning
// with 20-minute lulls is three sittings; the isolated 8-minute Spotify blip
// bounded by real gaps on both sides is noise, not a block — it is dropped,
// and the two work stretches stand as separate blocks with blank space between.
test('15+ minute gaps end blocks; an isolated sub-floor blip between real gaps is dropped', () => {
  const db = freshDb()
  const sessions = [
    session({ bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startTime: at(9, 0), endTime: at(9, 40), windowTitle: 'workBlocks.ts — daylens' }),
    session({ bundleId: 'com.spotify.client', appName: 'Spotify', category: 'entertainment', startTime: at(10, 0), endTime: at(10, 8), windowTitle: 'Discover Weekly' }),
    session({ bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startTime: at(10, 28), endTime: at(11, 8), windowTitle: 'workBlocks.ts — daylens' }),
  ]
  const blocks = buildTimelineBlocksFromSessions(db, sessions)
  assert.equal(blocks.length, 2, `two sittings split by real gaps should be two blocks, got ${blocks.length}: ${blocks.map((b) => `${new Date(b.startTime).toLocaleTimeString()}–${new Date(b.endTime).toLocaleTimeString()}`).join(', ')}`)
  const sorted = [...blocks].sort((a, b) => a.startTime - b.startTime)
  assert.ok(sorted[0].endTime <= at(9, 40), 'the first block must not span into the gap')
  assert.ok(sorted[1].startTime >= at(10, 28), 'the second block must not reach back across the gap')
  db.close()
})

// FLOOR: the floor pass must fold EVERY sub-floor
// sliver, however fragmented the day. The old fold loop was bounded by the
// shrinking result length, so a day with many slivers exited early and 12-second
// blocks reached the screen. Alternating work/leisure runs force many hard-cut
// sliver candidates; all of them must fold or drop.
test('a heavily fragmented day leaves no sub-floor blocks behind', () => {
  const db = freshDb()
  const sessions = []
  // 10 alternating 2-minute work/leisure slivers back to back (kind shifts are
  // hard candidate boundaries), then a real work block.
  for (let i = 0; i < 10; i++) {
    const start = at(9, i * 2)
    const end = at(9, i * 2 + 2)
    sessions.push(i % 2 === 0
      ? session({ bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startTime: start, endTime: end, windowTitle: 'workBlocks.ts — daylens' })
      : session({ bundleId: 'com.apple.Safari', appName: 'Safari', category: 'entertainment', startTime: start, endTime: end, windowTitle: 'Stranger Things · Netflix' }))
  }
  sessions.push(session({ bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startTime: at(9, 20), endTime: at(10, 20), windowTitle: 'workBlocks.ts — daylens' }))
  const blocks = buildTimelineBlocksFromSessions(db, sessions)
  for (const block of blocks) {
    const spanMs = block.endTime - block.startTime
    const activeMs = blockActiveSeconds(block) * 1000
    assert.ok(
      spanMs >= FLOOR_SECONDS * 1000 || activeMs >= FLOOR_SECONDS * 1000,
      `no block may sit under the 15-min floor on both axes, got span ${Math.round(spanMs / 1000)}s / active ${Math.round(activeMs / 1000)}s`,
    )
  }
  db.close()
})

// FLOOR (exemption): a short block with no non-meeting neighbour to fold into is
// the one thing allowed under the floor — a lone short day can't fold into
// nothing.
test('a lone short block with no neighbour stays', () => {
  const db = freshDb()
  const sessions = [
    session({ bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startTime: at(9, 0), endTime: at(9, 8), windowTitle: 'workBlocks.ts — daylens' }),
  ]
  const blocks = buildTimelineBlocksFromSessions(db, sessions)
  assert.equal(blocks.length, 1, `a lone short block has nothing to fold into, got ${blocks.length}`)
  db.close()
})

// FLOOR (meeting boundary): the floor never folds a sliver *into* a meeting —
// that would pollute the meeting block. A sub-15 sliver next to a meeting folds
// into the work side instead, leaving the meeting clean.
test('the floor folds a sliver into work, never into an adjacent meeting', () => {
  const db = freshDb()
  const sessions = [
    session({ bundleId: 'us.zoom.xos', appName: 'zoom.us', category: 'meetings', startTime: at(9, 0), endTime: at(9, 25), windowTitle: 'Zoom Meeting' }),
    session({ bundleId: 'com.spotify.client', appName: 'Spotify', category: 'entertainment', startTime: at(9, 26), endTime: at(9, 34), windowTitle: 'Discover Weekly' }),
    session({ bundleId: 'com.todesktop.cursor', appName: 'Cursor', category: 'development', startTime: at(9, 35), endTime: at(10, 5), windowTitle: 'workBlocks.ts — daylens' }),
  ]
  const blocks = buildTimelineBlocksFromSessions(db, sessions)
  assert.equal(blocks.length, 2, `the sliver must fold into the work block, leaving meeting + work, got ${blocks.length}`)
  assert.equal(blocks[0].dominantCategory, 'meetings', `the meeting block must stay a clean meeting, got ${blocks[0].dominantCategory}`)
  for (const block of blocks) {
    assert.ok(blockActiveSeconds(block) >= FLOOR_SECONDS, `no block may sit under the 15-min floor, got ${blockActiveSeconds(block)}s`)
  }
  db.close()
})
