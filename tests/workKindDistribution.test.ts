import test from 'node:test'
import assert from 'node:assert/strict'
import {
  effectiveBlockKind,
  kindForDomain,
  kindFromCategoryDistribution,
  partitionDomainsWorkFirst,
  PROMINENT_LEISURE_MIN_SECONDS,
} from '../src/shared/workKind.ts'

// Regression suite: a day spent redesigning a website in the browser (Canva,
// a local dev server, the company's own domain) read as 50m work / 9h 37m
// personal, because block kind was re-derived from a top-5 site list through
// a short domain allowlist that had never heard of the sites — while the
// block's own persisted, site-weighted category distribution said "work" all
// along.

test('kindFromCategoryDistribution: work-heavy distribution is work', () => {
  // The actual Jul 5 block's distribution (seconds).
  const kind = kindFromCategoryDistribution({
    uncategorized: 24, development: 2687, productivity: 3944, design: 3588,
    system: 10, social: 652, entertainment: 2732, aiTools: 648, research: 29, browsing: 7072,
  })
  assert.equal(kind, 'work')
})

test('kindFromCategoryDistribution: leisure-heavy distribution is leisure', () => {
  const kind = kindFromCategoryDistribution({
    development: 262, aiTools: 7, entertainment: 2843, social: 510, design: 3, browsing: 6220,
  })
  assert.equal(kind, 'leisure')
})

test('kindFromCategoryDistribution: browsing-only distribution carries no signal', () => {
  assert.equal(kindFromCategoryDistribution({ browsing: 1015 }), null)
  assert.equal(kindFromCategoryDistribution({ browsing: 2257, design: 13 }), null)
  assert.equal(kindFromCategoryDistribution(undefined), null)
})

test('kindForDomain: domainCategories work surfaces resolve to work', () => {
  assert.equal(kindForDomain('canva.com'), 'work')
  assert.equal(kindForDomain('figma.com'), 'work')
  assert.equal(kindForDomain('www.canva.com'), 'work')
})

test('kindForDomain: leisure and unknown domains unchanged', () => {
  assert.equal(kindForDomain('youtube.com'), 'leisure')
  assert.equal(kindForDomain('some-unknown-startup.io'), null)
})

test('effectiveBlockKind: stored kind wins, then distribution, then domains', () => {
  const base = {
    dominantCategory: 'development' as const,
    topApps: [],
    websites: [{ domain: 'unknown-agency-site.com', totalSeconds: 3600 }],
  }
  // Stored field is authoritative.
  assert.equal(effectiveBlockKind({ ...base, kind: 'leisure' }), 'leisure')
  // Distribution beats the weak domain fallback.
  assert.equal(
    effectiveBlockKind({ ...base, categoryDistribution: { design: 3000, entertainment: 500 } }),
    'work',
  )
  // No distribution signal: falls back to domain/app resolution.
  assert.equal(
    effectiveBlockKind({ ...base, categoryDistribution: { browsing: 4000 } }),
    'personal',
  )
})

// DEV-240: the "Off to the side" fold exists to keep incidental leisure from
// crowding out work, never to hide hours of real activity off-screen. A
// leisure domain with significant time stays in the main list at its
// time-ranked position.
test('partitionDomainsWorkFirst: prominent leisure stays in the main list', () => {
  const rows = [
    { domain: 'youtube.com', totalSeconds: 4 * 3600 },
    { domain: 'github.com', totalSeconds: 3600 },
    { domain: 'netflix.com', totalSeconds: 5 * 60 },
  ]
  const split = partitionDomainsWorkFirst(rows, (row) => row.domain, (row) => row.totalSeconds)
  assert.deepEqual(split.work.map((row) => row.domain), ['youtube.com', 'github.com'])
  assert.deepEqual(split.leisure.map((row) => row.domain), ['netflix.com'])

  // The threshold boundary is prominent.
  const boundary = partitionDomainsWorkFirst(
    [{ domain: 'youtube.com', totalSeconds: PROMINENT_LEISURE_MIN_SECONDS }],
    (row) => row.domain,
    (row) => row.totalSeconds,
  )
  assert.equal(boundary.leisure.length, 0)

  // Without a seconds accessor the original work-first behavior stands.
  const plain = partitionDomainsWorkFirst(rows, (row) => row.domain)
  assert.deepEqual(plain.leisure.map((row) => row.domain), ['youtube.com', 'netflix.com'])
})
