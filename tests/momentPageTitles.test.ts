import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import {
  getMomentEvidence,
  getVisitsOverlappingMoment,
  resolveMomentPageEvidence,
} from '../src/main/lib/momentEvidence.ts'

function setupDb(): Database.Database {
  return createProductionTestDatabase()
}

function localMs(date: Date, hour: number, minute = 0, second = 0): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, second, 0).getTime()
}

function dateStr(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function seedYoutubeAfternoon(db: Database.Database, day: Date): void {
  const start = localMs(day, 14, 14)
  const end = localMs(day, 15, 1)
  const evidence = {
    apps: [
      {
        bundleId: 'company.thebrowser.dia',
        canonicalAppId: 'dia',
        appName: 'Dia',
        category: 'browsing',
        totalSeconds: 2226,
        sessionCount: 8,
        isBrowser: true,
      },
    ],
    pages: [
      {
        id: 'art_grades',
        artifactType: 'page',
        canonicalKey: 'page:https://canvas.example/grades',
        displayTitle: 'Grades for Gentil Tonny Christian Iradukunda: Introduction to Machine Learning',
        subtitle: 'canvas.example',
        totalSeconds: 150,
        confidence: 0.85,
        domain: 'canvas.example',
        host: 'canvas.example',
        pageTitle: 'Grades for Gentil Tonny Christian Iradukunda: Introduction to Machine Learning',
        url: 'https://canvas.example/grades',
      },
      {
        id: 'art_yt_generic',
        artifactType: 'page',
        canonicalKey: 'page:https://www.youtube.com/',
        displayTitle: 'YouTube',
        subtitle: 'youtube.com',
        totalSeconds: 30,
        confidence: 0.85,
        domain: 'youtube.com',
        host: 'youtube.com',
        pageTitle: 'YouTube',
        url: 'https://www.youtube.com/',
      },
      {
        id: 'art_yt_smarthome',
        artifactType: 'page',
        canonicalKey: 'page:https://www.youtube.com/watch?v=smart',
        displayTitle: 'How I wasted $52,000 in my Dream Smart Home - YouTube',
        subtitle: 'youtube.com',
        totalSeconds: 205,
        confidence: 0.85,
        domain: 'youtube.com',
        host: 'youtube.com',
        pageTitle: 'How I wasted $52,000 in my Dream Smart Home - YouTube',
        url: 'https://www.youtube.com/watch?v=smart',
      },
      {
        id: 'art_yt_video',
        artifactType: 'page',
        canonicalKey: 'page:https://www.youtube.com/watch?v=DJ6yw3js7lI',
        displayTitle: 'I Found Out Why Chinese Performance Cars Are Taking Over - YouTube',
        subtitle: 'youtube.com',
        totalSeconds: 1200,
        confidence: 0.85,
        domain: 'youtube.com',
        host: 'youtube.com',
        pageTitle: 'I Found Out Why Chinese Performance Cars Are Taking Over - YouTube',
        url: 'https://www.youtube.com/watch?v=DJ6yw3js7lI',
      },
    ],
  }
  // heuristic must match TIMELINE_HEURISTIC_VERSION or the day is rebuilt
  // from sessions and pageRefs in evidence_summary_json are dropped.
  db.prepare(`
    INSERT INTO timeline_blocks (
      id, date, start_time, end_time, block_kind, dominant_category,
      category_distribution_json, switch_count, label_current, label_source,
      label_confidence, narrative_current, evidence_summary_json, is_live,
      heuristic_version, computed_at, invalidated_at
    ) VALUES (?, ?, ?, ?, 'work', 'entertainment', '{}', 0, ?, 'rule', 0.8, NULL, ?, 0, 'timeline-v11', ?, NULL)
  `).run(
    `blk_${dateStr(day)}_yt`,
    dateStr(day),
    start,
    end,
    'Watching YouTube',
    JSON.stringify(evidence),
    start,
  )
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec, category, is_focused,
      window_title, raw_app_name, canonical_app_id, capture_source, capture_version
    ) VALUES (?, ?, ?, ?, ?, 'browsing', 1, ?, ?, 'dia', 'test', 1)
  `).run(
    'company.thebrowser.dia',
    'Dia',
    start,
    end,
    Math.round((end - start) / 1000),
    'I Found Out Why Chinese Performance Cars Are Taking Over - YouTube',
    'Dia',
  )

  const insertVisit = db.prepare(`
    INSERT INTO website_visits (
      domain, page_title, url, visit_time, visit_time_us, duration_sec,
      browser_bundle_id, source
    ) VALUES (?, ?, ?, ?, ?, ?, 'company.thebrowser.dia', 'history')
  `)
  // Earlier videos in the same block — must NOT win a 3:00pm question.
  insertVisit.run(
    'youtube.com',
    'How I wasted $52,000 in my Dream Smart Home - YouTube',
    'https://www.youtube.com/watch?v=smart',
    localMs(day, 14, 15, 31),
    localMs(day, 14, 15, 31) * 1000,
    205,
  )
  insertVisit.run(
    'canvas.example',
    'Grades for Gentil Tonny Christian Iradukunda: Introduction to Machine Learning',
    'https://canvas.example/grades',
    localMs(day, 14, 50, 8),
    localMs(day, 14, 50, 8) * 1000,
    150,
  )
  // The visit actually covering 15:00.
  insertVisit.run(
    'youtube.com',
    'I Found Out Why Chinese Performance Cars Are Taking Over - YouTube',
    'https://www.youtube.com/watch?v=DJ6yw3js7lI',
    localMs(day, 14, 59, 43),
    localMs(day, 14, 59, 43) * 1000,
    65,
  )
}

test('resolveMomentPageEvidence prefers real video titles over bare YouTube chrome', () => {
  const resolved = resolveMomentPageEvidence([
    { pageTitle: 'YouTube', displayTitle: 'YouTube', host: 'youtube.com', domain: 'youtube.com', totalSeconds: 30 },
    {
      pageTitle: 'I Found Out Why Chinese Performance Cars Are Taking Over - YouTube',
      displayTitle: 'I Found Out Why Chinese Performance Cars Are Taking Over - YouTube',
      host: 'youtube.com',
      domain: 'youtube.com',
      totalSeconds: 1200,
    },
  ])
  assert.ok(resolved)
  assert.match(resolved!.title, /Chinese Performance Cars/)
  assert.notEqual(resolved!.title, 'YouTube')
})

test('resolveMomentPageEvidence says no title when only site chrome exists', () => {
  const resolved = resolveMomentPageEvidence([
    { pageTitle: '(26) YouTube', displayTitle: '(26) YouTube', host: 'youtube.com', domain: 'youtube.com' },
  ])
  assert.ok(resolved)
  assert.equal(resolved!.title, 'youtube.com (no specific page title captured)')
})

test('resolveMomentPageEvidence prefers the visit covering the clock time over longer block pages', () => {
  const resolved = resolveMomentPageEvidence(
    [
      {
        pageTitle: 'How I wasted $52,000 in my Dream Smart Home - YouTube',
        displayTitle: 'How I wasted $52,000 in my Dream Smart Home - YouTube',
        host: 'youtube.com',
        domain: 'youtube.com',
        totalSeconds: 900,
      },
      {
        pageTitle: 'Grades for Gentil Tonny Christian Iradukunda: Introduction to Machine Learning',
        displayTitle: 'Grades for Gentil Tonny Christian Iradukunda: Introduction to Machine Learning',
        host: 'canvas.example',
        domain: 'canvas.example',
        totalSeconds: 150,
      },
    ],
    [
      {
        pageTitle: 'I Found Out Why Chinese Performance Cars Are Taking Over - YouTube',
        displayTitle: 'I Found Out Why Chinese Performance Cars Are Taking Over - YouTube',
        host: 'youtube.com',
        domain: 'youtube.com',
        url: 'https://www.youtube.com/watch?v=DJ6yw3js7lI',
        totalSeconds: 65,
        overlapMs: 65_000,
      },
    ],
  )
  assert.ok(resolved)
  assert.match(resolved!.title, /Chinese Performance Cars/)
  assert.equal(resolved!.verb, 'watching')
  assert.doesNotMatch(resolved!.title, /Grades|Smart Home/)
})

test('getVisitsOverlappingMoment returns the visit actually covering the asked minute', () => {
  const db = setupDb()
  const day = new Date(2026, 6, 7, 12, 0, 0, 0)
  seedYoutubeAfternoon(db, day)
  const momentMs = localMs(day, 15, 0)
  const overlapping = getVisitsOverlappingMoment(db, momentMs)
  assert.ok(overlapping.length > 0)
  assert.equal(overlapping[0].pageTitle, 'I Found Out Why Chinese Performance Cars Are Taking Over - YouTube')
  db.close()
})

test('getMomentEvidence names the video active at 3pm, not every page in the block', () => {
  const db = setupDb()
  // Past day so persisted blocks load instead of live provisional rebuild.
  const day = new Date(2026, 6, 7, 12, 0, 0, 0)
  seedYoutubeAfternoon(db, day)
  const evidence = getMomentEvidence(db, dateStr(day), '15:00')

  assert.equal(evidence.found, true)
  assert.ok(evidence.activePage, 'expected the single active page at 3pm')
  assert.match(evidence.activePage!.title, /Chinese Performance Cars/)
  assert.equal(evidence.activePage!.verb, 'watching')
  // Never the whole block's pages — the other pages must not become the answer.
  assert.doesNotMatch(evidence.activePage!.title, /Grades for Gentil/)
  assert.doesNotMatch(evidence.activePage!.title, /Smart Home/)

  assert.ok(evidence.coveringBlock, 'expected the covering timeline block')
  assert.ok(
    evidence.coveringBlock!.topApps.some((app) => app.appName === 'Dia'),
    `expected Dia in the covering block's top apps, got: ${evidence.coveringBlock!.topApps.map((a) => a.appName).join(', ')}`,
  )
  db.close()
})

test('getMomentEvidence resolves an active page from visits even with no covering timeline block', () => {
  const db = setupDb()
  const day = new Date(2026, 6, 8, 12, 0, 0, 0)
  // No timeline_blocks row for this day — only a raw website visit.
  db.prepare(`
    INSERT INTO website_visits (
      domain, page_title, url, visit_time, visit_time_us, duration_sec,
      browser_bundle_id, source
    ) VALUES (?, ?, ?, ?, ?, ?, 'company.thebrowser.dia', 'history')
  `).run(
    'youtube.com',
    'I Found Out Why Chinese Performance Cars Are Taking Over - YouTube',
    'https://www.youtube.com/watch?v=DJ6yw3js7lI',
    localMs(day, 15, 0),
    localMs(day, 15, 0) * 1000,
    120,
  )
  const evidence = getMomentEvidence(db, dateStr(day), '15:01')

  assert.equal(evidence.found, true)
  assert.ok(evidence.activePage, 'expected the visit to resolve to an active page')
  assert.match(evidence.activePage!.title, /Chinese Performance Cars/)
  assert.equal(evidence.coveringBlock, null, 'no timeline block was seeded, so there is no covering block')
  db.close()
})
