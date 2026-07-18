import test from 'node:test'
import assert from 'node:assert/strict'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import {
  ActiveBrowserContextTracker,
  type ActiveBrowserWindowSnapshot,
} from '../src/main/services/browserContext.ts'
import {
  clipWebsiteVisitDurationToBrowserForeground,
  getBrowserHistoryCursor,
  insertWebsiteVisit,
  setBrowserHistoryCursor,
} from '../src/main/db/queries.ts'
import {
  normalizeUrlForStorage,
  sanitizeUrlForPersistence,
} from '../src/main/lib/appIdentity.ts'

const BASE = 1_800_000_000_000

function snapshot(overrides: Partial<ActiveBrowserWindowSnapshot> = {}): ActiveBrowserWindowSnapshot {
  return {
    bundleId: 'com.google.Chrome',
    appName: 'Google Chrome',
    windowTitle: 'Example',
    capturedAt: BASE,
    ...overrides,
  }
}

test('unverifiable window mode persists no page title or URL', () => {
  const db = createProductionTestDatabase()
  try {
    const tracker = new ActiveBrowserContextTracker(
      () => ({
        url: 'https://secret.example/private-tab?token=abc123secret',
        title: 'Private tab title',
        modeKnown: false,
      }),
      () => true,
    )

    tracker.sample(db, snapshot())
    tracker.sample(db, snapshot({ capturedAt: BASE + 30_000 }))
    assert.equal(tracker.flush(db, BASE + 60_000), false)

    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM website_visits').get() as { n: number }).n,
      0,
    )
    const leaked = db
      .prepare(
        `
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND sql LIKE '%Private tab title%'
    `,
      )
      .all()
    assert.deepEqual(leaked, [])
    assert.doesNotMatch(
      JSON.stringify(
        db.prepare('SELECT * FROM website_visits').all(),
      ),
      /secret\.example|Private tab|abc123secret/i,
    )
  } finally {
    db.close()
  }
})

test('confirmed private windows leave zero page rows anywhere', () => {
  const db = createProductionTestDatabase()
  try {
    const tracker = new ActiveBrowserContextTracker(
      () => ({ url: '', title: null, isPrivate: true, modeKnown: true }),
      () => true,
    )
    tracker.sample(db, snapshot({ windowTitle: 'Incognito' }))
    tracker.flush(db, BASE + 60_000)

    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM website_visits').get() as { n: number }).n,
      0,
    )
    assert.equal(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'website_visits_pending'",
          )
          .get() as { n: number }
      ).n,
      0,
    )
  } finally {
    db.close()
  }
})

test('sensitive query values and fragments are stripped before persistence', () => {
  const raw =
    'https://app.example/callback?code=oauth_code_value&state=xyz&keep=1&access_token=tok_abc#fragment-secret'
  assert.equal(
    sanitizeUrlForPersistence(raw),
    'https://app.example/callback?keep=1',
  )
  assert.equal(
    normalizeUrlForStorage('https://app.example/page?utm_source=x&session_id=s1&v=ok'),
    'https://app.example/page?v=ok',
  )

  const db = createProductionTestDatabase()
  try {
    const inserted = insertWebsiteVisit(db, {
      domain: 'app.example',
      pageTitle: 'Callback',
      url: raw,
      normalizedUrl: normalizeUrlForStorage(raw),
      pageKey: 'app.example/callback',
      visitTime: BASE,
      visitTimeUs: BigInt(BASE) * 1000n,
      durationSec: 30,
      browserBundleId: 'com.google.Chrome',
      canonicalBrowserId: 'chrome',
      browserProfileId: 'default',
      source: 'chrome_history',
    })
    assert.equal(inserted, true)
    const row = db.prepare('SELECT url, normalized_url FROM website_visits').get() as {
      url: string
      normalized_url: string
    }
    assert.equal(row.url, 'https://app.example/callback?keep=1')
    assert.doesNotMatch(row.url, /code=|state=|access_token=|fragment/i)
    assert.doesNotMatch(row.normalized_url, /code=|state=|access_token=/i)
  } finally {
    db.close()
  }
})

test('page duration is clipped to the owning browser foreground interval', () => {
  const db = createProductionTestDatabase()
  try {
    db.prepare(`
      INSERT INTO app_sessions (
        bundle_id, app_name, start_time, end_time, duration_sec, category, is_focused,
        window_title, raw_app_name, canonical_app_id, app_instance_id, capture_source, capture_version
      ) VALUES (?, ?, ?, ?, ?, 'browsing', 1, ?, ?, ?, ?, 'test', 2)
    `).run(
      'com.google.Chrome',
      'Google Chrome',
      BASE,
      BASE + 20_000,
      20,
      'Google Chrome',
      'Google Chrome',
      'chrome',
      'com.google.Chrome',
    )

    const clipped = clipWebsiteVisitDurationToBrowserForeground(db, {
      visitTime: BASE,
      durationSec: 120,
      browserBundleId: 'com.google.Chrome',
      canonicalBrowserId: 'chrome',
    })
    assert.equal(clipped, 20)

    insertWebsiteVisit(db, {
      domain: 'example.com',
      pageTitle: 'Example',
      url: 'https://example.com/',
      normalizedUrl: 'https://example.com/',
      pageKey: 'example.com',
      visitTime: BASE,
      visitTimeUs: BigInt(BASE) * 1000n,
      durationSec: 120,
      browserBundleId: 'com.google.Chrome',
      canonicalBrowserId: 'chrome',
      browserProfileId: 'default',
      source: 'chrome_history',
    })
    const row = db.prepare('SELECT duration_sec FROM website_visits').get() as { duration_sec: number }
    assert.equal(row.duration_sec, 20)
  } finally {
    db.close()
  }
})

test('browser history source cursors are durable and idempotent', () => {
  const db = createProductionTestDatabase()
  try {
    assert.equal(getBrowserHistoryCursor(db, 'com.google.Chrome'), null)
    setBrowserHistoryCursor(db, 'com.google.Chrome', 123456789n)
    assert.equal(getBrowserHistoryCursor(db, 'com.google.Chrome'), 123456789n)
    setBrowserHistoryCursor(db, 'com.google.Chrome', 999n)
    assert.equal(getBrowserHistoryCursor(db, 'com.google.Chrome'), 999n)

    const visit = {
      domain: 'example.com',
      pageTitle: 'Example',
      url: 'https://example.com/',
      normalizedUrl: 'https://example.com/',
      pageKey: 'example.com',
      visitTime: BASE,
      visitTimeUs: 42n,
      durationSec: 15,
      browserBundleId: 'com.google.Chrome',
      canonicalBrowserId: 'chrome',
      browserProfileId: 'default',
      source: 'chrome_history',
    }
    assert.equal(insertWebsiteVisit(db, visit), true)
    assert.equal(insertWebsiteVisit(db, visit), false)
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM website_visits').get() as { n: number }).n,
      1,
    )
  } finally {
    db.close()
  }
})

test('mode-verified live context still persists page evidence', () => {
  const db = createProductionTestDatabase()
  try {
    const tracker = new ActiveBrowserContextTracker(
      () => ({
        url: 'https://github.com/daylens/daylens?token=should-strip',
        title: 'daylens',
        modeKnown: true,
      }),
      () => true,
    )
    tracker.sample(db, snapshot())
    tracker.sample(db, snapshot({ capturedAt: BASE + 20_000 }))
    assert.equal(tracker.flush(db, BASE + 30_000), true)
    const row = db.prepare('SELECT domain, url, page_title FROM website_visits').get() as {
      domain: string
      url: string
      page_title: string
    }
    assert.equal(row.domain, 'github.com')
    assert.equal(row.page_title, 'daylens')
    assert.equal(row.url, 'https://github.com/daylens/daylens')
    assert.doesNotMatch(row.url, /token=/)
  } finally {
    db.close()
  }
})
