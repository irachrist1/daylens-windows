// Attention-clamped kind voting (Q2): foreground app sessions are the only
// source that measures attention; browser history explains attention, never
// adds to it. The regression this pins: a Netflix tab left open in the
// background accrued 1249 raw visit-seconds inside a block where the browser
// was foregrounded only ~800s, so the block resolved leisure ("Watching
// Netflix & YouTube") while the user migrated CI workflows in an IDE.
//
// Two layers under test:
//   1. resolveBlockKind (the effectiveBlockKind fallback in shared/workKind):
//      site seconds must be clamped to the browser's own foreground seconds
//      before they vote, and an entertainment-policy domain that never held
//      the majority of that clamped budget is ambience — no vote at all.
//      The fallback cases use non-focused dominant categories on purpose:
//      FOCUSED_CATEGORIES short-circuits to 'work' before the fallback runs,
//      and these tests must exercise the voting itself.
//   2. Segmentation (workBlocks buildTimelineContext): browser sessions must
//      vote with reconciled credits, so a background tab whose history
//      duration out-dwells the real active tab cannot flip a session — or a
//      block — to leisure.
import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { getTimelineDayPayload } from '../src/main/services/workBlocks.ts'
import { effectiveBlockKind } from '../src/shared/workKind.ts'
import { blockActiveSeconds } from '../src/shared/blockDuration.ts'

const TEST_DATE = '2026-06-10'

function localMs(hour: number, minute = 0, second = 0): number {
  return new Date(2026, 5, 10, hour, minute, second, 0).getTime()
}

function insertSession(
  db: Database.Database,
  o: { bundleId: string; appName: string; start: number; end: number; category: string; title: string },
): void {
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, canonical_app_id, capture_source, capture_version
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'test', 2)
  `).run(
    o.bundleId, o.appName, o.start, o.end, Math.round((o.end - o.start) / 1000),
    o.category, o.title, o.appName, o.bundleId,
  )
}

function insertVisit(
  db: Database.Database,
  o: {
    domain: string
    title: string
    url: string
    visitMs: number
    durationSec: number
    browserBundleId: string
    source?: string
  },
): void {
  db.prepare(`
    INSERT INTO website_visits (
      domain, page_title, url, visit_time, visit_time_us, duration_sec,
      browser_bundle_id, canonical_browser_id, normalized_url, page_key, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    o.domain, o.title, o.url, o.visitMs, o.visitMs * 1000, o.durationSec,
    o.browserBundleId, o.browserBundleId, o.url, o.url, o.source ?? 'history',
  )
}

// ─── 1. resolveBlockKind fallback: clamp + ambience ──────────────────────────
// effectiveBlockKind reaches the fallback only when a block carries neither a
// stored kind nor a distribution signal, so these inputs pass neither.

test('fallback kind: background-tab site seconds are clamped to browser foreground before voting', () => {
  // The exact failure shape: 1000s of IDE work, browser foregrounded 800s,
  // Netflix history visit claiming 1249 raw seconds. Unclamped, leisure 1249
  // outvotes work 1000; clamped, Netflix can spend at most the browser's own
  // 800 foreground seconds.
  const kind = effectiveBlockKind({
    dominantCategory: 'browsing',
    topApps: [
      { category: 'development', totalSeconds: 1000 },
      { category: 'browsing', totalSeconds: 800, isBrowser: true },
    ],
    websites: [{ domain: 'netflix.com', totalSeconds: 1249 }],
  })
  assert.equal(kind, 'work')
})

test('fallback kind: an entertainment domain without the majority of the clamped budget is ambience', () => {
  // Browser foregrounded 800s. Netflix raw 1600s + GitHub 300s scale to
  // 674s + 126s. 674 > 400 is a majority, so Netflix still gets a vote here —
  // the clamp alone must carry this one: work 600+126 beats leisure 674.
  const majority = effectiveBlockKind({
    dominantCategory: 'browsing',
    topApps: [
      { category: 'development', totalSeconds: 600 },
      { category: 'browsing', totalSeconds: 800, isBrowser: true },
    ],
    websites: [
      { domain: 'netflix.com', totalSeconds: 1600 },
      { domain: 'github.com', totalSeconds: 300 },
    ],
  })
  assert.equal(majority, 'work')

  // Netflix's 390 credited seconds are under half of the 800s budget: pure
  // ambience, no vote at all. Raw voting used to let leisure 390 beat the
  // 250s of work signal here.
  const ambience = effectiveBlockKind({
    dominantCategory: 'browsing',
    topApps: [
      { category: 'development', totalSeconds: 100 },
      { category: 'browsing', totalSeconds: 800, isBrowser: true },
    ],
    websites: [
      { domain: 'github.com', totalSeconds: 150 },
      { domain: 'netflix.com', totalSeconds: 390 },
    ],
  })
  assert.equal(ambience, 'work')
})

test('fallback kind: an idle social-feed tab is ambience too, not only entertainment', () => {
  // The ambience rule must cover EVERY leisure-mapping domain policy. x.com is
  // 'social_feed', not 'entertainment' — before the fix its background credit
  // always voted, so 390s of idle feed outvoted 300s of real work.
  const kind = effectiveBlockKind({
    dominantCategory: 'browsing',
    topApps: [
      { category: 'productivity', totalSeconds: 300 },
      { category: 'browsing', totalSeconds: 800, isBrowser: true },
    ],
    websites: [
      { domain: 'x.com', totalSeconds: 390 },
      { domain: 'trainline.com', totalSeconds: 100 },
    ],
  })
  assert.equal(kind, 'work')
})

test('fallback kind: a real watching block stays leisure — majority of the budget is activity', () => {
  const kind = effectiveBlockKind({
    dominantCategory: 'browsing',
    topApps: [{ category: 'browsing', totalSeconds: 5400, isBrowser: true }],
    websites: [{ domain: 'netflix.com', totalSeconds: 5100 }],
  })
  assert.equal(kind, 'leisure')
})

// ─── 2. Segmentation: reconciled credits vote, not raw visit seconds ─────────

// Same failure with the browser on a NON-focused work surface (Notion →
// productivity), so no dominant-category short-circuit can mask a raw-seconds
// leisure vote: the block's kind must come from honest attention-clamped
// voting.
test('segmentation: an idle Netflix tab cannot flip a Notion-in-browser work block to leisure', () => {
  const db = createProductionTestDatabase()
  try {
    insertSession(db, {
      bundleId: 'com.mitchellh.ghostty', appName: 'Ghostty', category: 'development',
      start: localMs(9, 0), end: localMs(10, 0), title: 'daylens — migrate CI workflows',
    })
    insertSession(db, {
      bundleId: 'com.google.Chrome', appName: 'Google Chrome', category: 'browsing',
      start: localMs(10, 0), end: localMs(10, 20), title: 'CI migration runbook · Notion',
    })
    insertSession(db, {
      bundleId: 'com.mitchellh.ghostty', appName: 'Ghostty', category: 'development',
      start: localMs(10, 20), end: localMs(11, 20), title: 'daylens — migrate CI workflows',
    })

    // The real active tab: Notion, observed by the active-tab tracker for
    // nearly the whole 1200s browser window.
    insertVisit(db, {
      domain: 'notion.so', title: 'CI migration runbook',
      url: 'https://www.notion.so/daylens/ci-migration-runbook',
      visitMs: localMs(10, 0, 10), durationSec: 1150,
      browserBundleId: 'com.google.Chrome', source: 'active_browser_context',
    })
    // The background Netflix tab: raw history seconds EXCEED the browser's
    // entire foreground time in the block (1900 > 1200).
    insertVisit(db, {
      domain: 'netflix.com', title: 'Stranger Things — Netflix',
      url: 'https://www.netflix.com/watch/80100172',
      visitMs: localMs(10, 0), durationSec: 1900,
      browserBundleId: 'com.google.Chrome', source: 'history',
    })

    const payload = getTimelineDayPayload(db, TEST_DATE, null, { materialize: false })
    assert.ok(payload.blocks.length >= 1, 'the morning produced blocks')

    let leisureSeconds = 0
    for (const block of payload.blocks) {
      if (effectiveBlockKind(block) === 'leisure') leisureSeconds += blockActiveSeconds(block)
    }
    assert.equal(leisureSeconds, 0, 'no leisure block exists — the Netflix tab was never watched')

    const covering = payload.blocks.find(
      (block) => block.startTime <= localMs(10, 5) && block.endTime >= localMs(10, 15),
    )
    assert.ok(covering, 'the browser stretch belongs to a block')
    assert.equal(effectiveBlockKind(covering!), 'work', 'the runbook stretch resolves work')
  } finally {
    db.close()
  }
})

test('segmentation: an idle Netflix tab cannot flip a CI-migration block to leisure', () => {
  const db = createProductionTestDatabase()
  try {
    insertSession(db, {
      bundleId: 'com.mitchellh.ghostty', appName: 'Ghostty', category: 'development',
      start: localMs(9, 0), end: localMs(10, 0), title: 'daylens — migrate CI workflows',
    })
    insertSession(db, {
      bundleId: 'com.google.Chrome', appName: 'Google Chrome', category: 'browsing',
      start: localMs(10, 0), end: localMs(10, 20), title: 'ci.yml · daylens/daylens · GitHub',
    })
    insertSession(db, {
      bundleId: 'com.mitchellh.ghostty', appName: 'Ghostty', category: 'development',
      start: localMs(10, 20), end: localMs(11, 20), title: 'daylens — migrate CI workflows',
    })

    // The real active tab: GitHub, observed by the active-tab tracker for
    // nearly the whole 1200s browser window.
    insertVisit(db, {
      domain: 'github.com', title: 'ci.yml · daylens/daylens',
      url: 'https://github.com/daylens/daylens/blob/main/.github/workflows/ci.yml',
      visitMs: localMs(10, 0, 10), durationSec: 1150,
      browserBundleId: 'com.google.Chrome', source: 'active_browser_context',
    })
    // The background Netflix tab: raw history seconds EXCEED the browser's
    // entire foreground time in the block (1900 > 1200).
    insertVisit(db, {
      domain: 'netflix.com', title: 'Stranger Things — Netflix',
      url: 'https://www.netflix.com/watch/80100172',
      visitMs: localMs(10, 0), durationSec: 1900,
      browserBundleId: 'com.google.Chrome', source: 'history',
    })

    const payload = getTimelineDayPayload(db, TEST_DATE, null, { materialize: false })
    assert.ok(payload.blocks.length >= 1, 'the morning produced blocks')

    let leisureSeconds = 0
    for (const block of payload.blocks) {
      if (effectiveBlockKind(block) === 'leisure') leisureSeconds += blockActiveSeconds(block)
    }
    assert.equal(leisureSeconds, 0, 'no leisure block exists — the Netflix tab was never watched')

    const covering = payload.blocks.find(
      (block) => block.startTime <= localMs(10, 5) && block.endTime >= localMs(10, 15),
    )
    assert.ok(covering, 'the browser stretch belongs to a block')
    assert.equal(effectiveBlockKind(covering!), 'work', 'the CI-migration stretch resolves work')
  } finally {
    db.close()
  }
})

// social_feed domains map to leisure exactly like entertainment ones, but the
// ambience filter only covered policyForHost === 'entertainment' — so ANY
// background x.com credit flipped an unfocused browsing session to leisure
// via resolveKind's leisure-anywhere rule.
test('segmentation: a background x.com tab cannot flip a trainline booking session to leisure', () => {
  const db = createProductionTestDatabase()
  try {
    insertSession(db, {
      bundleId: 'com.google.Chrome', appName: 'Google Chrome', category: 'browsing',
      start: localMs(10, 0), end: localMs(10, 20), title: 'Trainline: book cheap train tickets',
    })
    // The real active tab: booking a train, observed nearly the whole window.
    insertVisit(db, {
      domain: 'trainline.com', title: 'Trainline: book cheap train tickets',
      url: 'https://www.trainline.com/book',
      visitMs: localMs(10, 0, 10), durationSec: 1150,
      browserBundleId: 'com.google.Chrome', source: 'active_browser_context',
    })
    // The background x.com tab: raw history seconds exceed the browser's
    // entire foreground time.
    insertVisit(db, {
      domain: 'x.com', title: 'Home / X',
      url: 'https://x.com/home',
      visitMs: localMs(10, 0), durationSec: 1900,
      browserBundleId: 'com.google.Chrome', source: 'history',
    })

    const payload = getTimelineDayPayload(db, TEST_DATE, null, { materialize: false })
    const covering = payload.blocks.find(
      (block) => block.startTime <= localMs(10, 5) && block.endTime >= localMs(10, 15),
    )
    assert.ok(covering, 'the booking stretch belongs to a block')
    assert.equal(effectiveBlockKind(covering!), 'personal',
      'the trainline session stays personal — the x.com tab was never in the foreground')
  } finally {
    db.close()
  }
})

// A brand word in the foreground title must not vouch for a background tab:
// "youtube itinerary video notes" (a Notion doc ABOUT YouTube) contains the
// page title "YouTube" as a substring, which the old containment test read as
// the browser being foregrounded on YouTube.
test('segmentation: a work title mentioning "youtube" does not vouch for an idle YouTube tab', () => {
  const db = createProductionTestDatabase()
  try {
    insertSession(db, {
      bundleId: 'com.google.Chrome', appName: 'Google Chrome', category: 'browsing',
      start: localMs(14, 0), end: localMs(14, 20), title: 'YouTube itinerary video notes',
    })
    // The real active tab starts five minutes in, so the idle YouTube tab's
    // history fill earns real (but minority) credit for 14:00–14:05.
    insertVisit(db, {
      domain: 'notion.so', title: 'YouTube itinerary video notes',
      url: 'https://www.notion.so/daylens/youtube-itinerary-video-notes',
      visitMs: localMs(14, 5), durationSec: 890,
      browserBundleId: 'com.google.Chrome', source: 'active_browser_context',
    })
    // The idle YouTube tab: bare brand page title, big raw history seconds.
    insertVisit(db, {
      domain: 'youtube.com', title: 'YouTube',
      url: 'https://www.youtube.com/',
      visitMs: localMs(14, 0), durationSec: 1900,
      browserBundleId: 'com.google.Chrome', source: 'history',
    })

    const payload = getTimelineDayPayload(db, TEST_DATE, null, { materialize: false })
    const covering = payload.blocks.find(
      (block) => block.startTime <= localMs(14, 5) && block.endTime >= localMs(14, 15),
    )
    assert.ok(covering, 'the notes stretch belongs to a block')
    assert.equal(effectiveBlockKind(covering!), 'work',
      'the Notion work session stays work — a brand word in the title is not a foregrounded YouTube tab')
  } finally {
    db.close()
  }
})

// The other direction must keep working: a browser genuinely foregrounded on
// a real YouTube video — the full video title in the window title — is
// watching, and the title match still vouches for it.
test('segmentation: a genuinely foregrounded YouTube session still counts leisure', () => {
  const db = createProductionTestDatabase()
  try {
    insertSession(db, {
      bundleId: 'com.apple.Safari', appName: 'Safari', category: 'browsing',
      start: localMs(21, 0), end: localMs(22, 0), title: 'Deep Focus Coding Music - YouTube',
    })
    insertVisit(db, {
      domain: 'youtube.com', title: 'Deep Focus Coding Music - YouTube',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      visitMs: localMs(21, 1), durationSec: 55 * 60,
      browserBundleId: 'com.apple.Safari', source: 'history',
    })

    const payload = getTimelineDayPayload(db, TEST_DATE, null, { materialize: false })
    const watching = payload.blocks.find(
      (block) => block.startTime <= localMs(21, 30) && block.endTime >= localMs(21, 30),
    )
    assert.ok(watching, 'the evening produced a block')
    assert.equal(effectiveBlockKind(watching!), 'leisure', 'real watching stays leisure')
  } finally {
    db.close()
  }
})

test('segmentation: a browser genuinely foregrounded on Netflix still resolves leisure', () => {
  const db = createProductionTestDatabase()
  try {
    insertSession(db, {
      bundleId: 'com.apple.Safari', appName: 'Safari', category: 'browsing',
      start: localMs(20, 0), end: localMs(21, 30), title: 'Stranger Things - Netflix',
    })
    insertVisit(db, {
      domain: 'netflix.com', title: 'Stranger Things',
      url: 'https://www.netflix.com/watch/80100172',
      visitMs: localMs(20, 5), durationSec: 85 * 60,
      browserBundleId: 'com.apple.Safari', source: 'history',
    })

    const payload = getTimelineDayPayload(db, TEST_DATE, null, { materialize: false })
    const watching = payload.blocks.find(
      (block) => block.startTime <= localMs(20, 30) && block.endTime >= localMs(20, 30),
    )
    assert.ok(watching, 'the evening produced a block')
    assert.equal(effectiveBlockKind(watching!), 'leisure', 'real watching stays leisure')
  } finally {
    db.close()
  }
})
