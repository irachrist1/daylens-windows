import test from 'node:test'
import assert from 'node:assert/strict'
import {
  effectiveBlockKind,
  kindForDomain,
  kindFromCategoryDistribution,
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
  // A focused dominant category resolves to work on the read path — the same
  // rule the block builder applies when it stores the kind (timeline.md
  // §3.2/§3.6). Rehydrated blocks carry no `kind`, and before this a
  // CI-work block with an inflated background Netflix tab re-derived as
  // leisure and rendered "Watching Netflix & YouTube".
  assert.equal(effectiveBlockKind(base), 'work')
  // Distribution beats the weak domain fallback (non-focused dominant).
  assert.equal(
    effectiveBlockKind({
      ...base,
      dominantCategory: 'browsing' as const,
      categoryDistribution: { design: 3000, entertainment: 500 },
    }),
    'work',
  )
  // No distribution signal, no focused dominant: falls back to domain/app
  // resolution.
  assert.equal(
    effectiveBlockKind({
      ...base,
      dominantCategory: 'browsing' as const,
      categoryDistribution: { browsing: 4000 },
    }),
    'personal',
  )
})
