import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  ActiveBrowserContextTracker,
  pickRecentHistoryRow,
  type ActiveBrowserWindowSnapshot,
} from '../src/main/services/browserContext.ts'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE website_visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      page_title TEXT,
      url TEXT,
      visit_time INTEGER NOT NULL,
      visit_time_us INTEGER NOT NULL DEFAULT 0,
      duration_sec INTEGER NOT NULL DEFAULT 0,
      browser_bundle_id TEXT,
      canonical_browser_id TEXT,
      browser_profile_id TEXT,
      normalized_url TEXT,
      page_key TEXT,
      source TEXT NOT NULL DEFAULT 'history',
      UNIQUE (browser_bundle_id, visit_time_us, url)
    );
  `)
  return db
}

function snapshot(overrides: Partial<ActiveBrowserWindowSnapshot> = {}): ActiveBrowserWindowSnapshot {
  return {
    bundleId: '/System/Applications/Safari.app/Contents/MacOS/Safari',
    appName: 'Safari',
    windowTitle: null,
    capturedAt: 1_800_000_000_000,
    ...overrides,
  }
}

test('frontmost Safari tab context is persisted as website evidence', () => {
  const db = createDb()
  const tracker = new ActiveBrowserContextTracker(
    () => ({
      url: 'https://www.youtube.com/watch?v=kJC1l4__UhE&t=2825s',
      title: "Are These Apple's Next Products? - YouTube",
    }),
    () => true,
  )

  tracker.sample(db, snapshot())
  tracker.sample(db, snapshot({ capturedAt: 1_800_000_010_000 }))
  assert.equal(tracker.flush(db, 1_800_000_015_000), true)

  const row = db.prepare(`
    SELECT domain, page_title, url, duration_sec, browser_bundle_id, canonical_browser_id, browser_profile_id, source
    FROM website_visits
  `).get() as {
    domain: string
    page_title: string
    url: string
    duration_sec: number
    browser_bundle_id: string
    canonical_browser_id: string
    browser_profile_id: string
    source: string
  }

  assert.equal(row.domain, 'youtube.com')
  assert.equal(row.page_title, "Are These Apple's Next Products? - YouTube")
  assert.equal(row.url, 'https://www.youtube.com/watch?v=kJC1l4__UhE&t=2825s')
  assert.equal(row.duration_sec, 15)
  assert.equal(row.browser_bundle_id, '/System/Applications/Safari.app/Contents/MacOS/Safari')
  assert.equal(row.canonical_browser_id, 'safari')
  assert.equal(row.browser_profile_id, 'default')
  assert.equal(row.source, 'active_browser_context')
})

test('active media domains produce only a privacy-safe passive-presence signal', () => {
  const db = createDb()
  let current = {
    url: 'https://www.netflix.com/watch/81234567?trackId=abc',
    title: 'Netflix',
  }
  const tracker = new ActiveBrowserContextTracker(() => current, () => true)

  assert.deepEqual(tracker.sample(db, snapshot()), {
    isPrivate: false,
    passivePresence: true,
    passiveHold: 'media',
  })

  current = {
    url: 'https://example.com/articles/idle',
    title: 'An article',
  }
  assert.deepEqual(
    tracker.sample(db, snapshot({ capturedAt: 1_800_000_005_000, windowTitle: 'An article' })),
    { isPrivate: false, passivePresence: false },
  )
  db.close()
})

test('missing tab access clears a previously active passive-presence signal', () => {
  const db = createDb()
  let current: { url: string; title: string | null } | null = {
    url: 'https://netflix.com/watch/81234567',
    title: 'Netflix',
  }
  const tracker = new ActiveBrowserContextTracker(() => current, () => true)

  assert.equal(tracker.sample(db, snapshot()).passivePresence, true)
  current = null
  assert.deepEqual(
    tracker.sample(db, snapshot({ capturedAt: 1_800_000_005_000 })),
    { isPrivate: false, passivePresence: false },
  )
  db.close()
})

test('explicit browser-context cutoff beats a later cached last-seen timestamp', () => {
  const db = createDb()
  const tracker = new ActiveBrowserContextTracker(
    () => ({
      url: 'https://github.com/irachrist1/daylens',
      title: 'daylens',
    }),
    () => true,
  )
  const at = (seconds: number) => 1_800_000_000_000 + seconds * 1_000

  tracker.sample(db, snapshot({ capturedAt: at(0) }))
  tracker.sample(db, snapshot({ capturedAt: at(60) }))
  assert.equal(tracker.flush(db, at(30)), true)

  const row = db.prepare('SELECT domain, duration_sec FROM website_visits').get() as {
    domain: string
    duration_sec: number
  }
  assert.equal(row.domain, 'github.com')
  assert.equal(row.duration_sec, 30)
})

test('browser tab switches flush separate page visits', () => {
  const db = createDb()
  let current = {
    url: 'https://chatgpt.com/c/first',
    title: 'Planning browser tracking',
  }
  const tracker = new ActiveBrowserContextTracker(() => current, () => true)

  tracker.sample(db, snapshot({ appName: 'Google Chrome', bundleId: 'chrome.exe', capturedAt: 1_800_000_000_000 }))
  current = {
    url: 'https://github.com/irachrist1/daylens',
    title: 'irachrist1/daylens',
  }
  tracker.sample(db, snapshot({ appName: 'Google Chrome', bundleId: 'chrome.exe', capturedAt: 1_800_000_012_000 }))
  tracker.sample(db, snapshot({ appName: 'Google Chrome', bundleId: 'chrome.exe', capturedAt: 1_800_000_022_000 }))
  tracker.flush(db, 1_800_000_025_000)

  const rows = db.prepare(`
    SELECT domain, page_title, duration_sec
    FROM website_visits
    ORDER BY visit_time ASC
  `).all() as { domain: string; page_title: string; duration_sec: number }[]

  assert.deepEqual(rows, [
    { domain: 'chatgpt.com', page_title: 'Planning browser tracking', duration_sec: 12 },
    { domain: 'github.com', page_title: 'irachrist1/daylens', duration_sec: 13 },
  ])
})

test('a browser-page flicker under ten seconds is absorbed instead of becoming a visit', () => {
  const db = createDb()
  let current = {
    url: 'https://github.com/irachrist1/daylens',
    title: 'irachrist1/daylens',
  }
  const tracker = new ActiveBrowserContextTracker(() => current, () => true)
  const at = (seconds: number) => 1_800_000_000_000 + seconds * 1_000

  tracker.sample(db, snapshot({ capturedAt: at(0) }))
  tracker.sample(db, snapshot({ capturedAt: at(10) }))
  current = { url: 'https://x.com/home', title: 'Home / X' }
  tracker.sample(db, snapshot({ capturedAt: at(20), windowTitle: 'Home / X' }))
  current = { url: 'https://github.com/irachrist1/daylens', title: 'irachrist1/daylens' }
  tracker.sample(db, snapshot({ capturedAt: at(25), windowTitle: 'irachrist1/daylens' }))
  tracker.flush(db, at(30))

  const rows = db.prepare(`
    SELECT domain, duration_sec
    FROM website_visits
    ORDER BY visit_time ASC
  `).all()
  assert.deepEqual(rows, [{ domain: 'github.com', duration_sec: 30 }])
})

test('mode-unverified live tab stays private despite matching ordinary history', () => {
  const db = createDb()
  const at = 1_800_000_000_000
  db.prepare(`
    INSERT INTO website_visits (
      domain, page_title, url, visit_time, visit_time_us, browser_bundle_id,
      canonical_browser_id, normalized_url, page_key, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'netflix.com',
    'Netflix',
    'https://www.netflix.com/watch/81234567',
    at - 1_000,
    (at - 1_000) * 1_000,
    '/System/Applications/Safari.app/Contents/MacOS/Safari',
    'safari',
    'https://www.netflix.com/watch/81234567',
    'netflix.com/watch/81234567',
    'webkit_history',
  )
  const tracker = new ActiveBrowserContextTracker(
    () => ({
      url: 'https://www.netflix.com/watch/81234567',
      title: 'Netflix',
      modeKnown: false,
    }),
    () => true,
  )

  assert.deepEqual(tracker.sample(db, snapshot({ capturedAt: at })), {
    isPrivate: false,
    passivePresence: true,
    passiveHold: 'media',
    windowModeUnverified: true,
  })
  assert.equal(tracker.flush(db, at + 15_000), false)
  const activeVisitCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM website_visits
    WHERE source = 'active_browser_context'
  `).get() as { count: number }
  assert.equal(activeVisitCount.count, 0)
})

test('titleless history fallback refuses to guess the latest row', () => {
  const rows = [
    { url: 'https://www.netflix.com/watch/1', title: 'Stranger Things | Netflix' },
    { url: 'https://www.coursera.org/learn/ml', title: 'Supervised ML | Coursera' },
  ]
  assert.equal(pickRecentHistoryRow(rows, null), null)
  assert.equal(pickRecentHistoryRow(rows, ''), null)
  assert.equal(
    pickRecentHistoryRow(rows, 'Supervised ML | Coursera')?.url,
    'https://www.coursera.org/learn/ml',
  )
  assert.equal(
    pickRecentHistoryRow(rows, 'Inbox — Gmail')?.url,
    'https://www.netflix.com/watch/1',
    'a titled window with no token overlap still takes the latest row',
  )
})
