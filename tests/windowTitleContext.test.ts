import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDayTitleContext, clusterWindowTitles } from '../src/shared/windowTitleContext.ts'

// Window titles are rich (project names, meeting names, document titles) and
// were ignored by the wrap facts. These fixtures are real title shapes from
// the live DB.

test('truncated variants of one title merge into one cluster', () => {
  const clusters = clusterWindowTitles('Dia', [
    { windowTitle: 'Meet – Machine Learning…', durationSeconds: 2451 },
    { windowTitle: 'Meet – Machine Learning Pipeline', durationSeconds: 300 },
    { windowTitle: 'Meet – Machine Learning Pipel…', durationSeconds: 120 },
  ])
  assert.equal(clusters.length, 1)
  assert.equal(clusters[0].sessions, 3)
  assert.equal(clusters[0].seconds, 2871)
  assert.equal(clusters[0].label, 'Meet – Machine Learning Pipeline')
})

test('browser profile prefixes and badges never reach a label', () => {
  const clusters = clusterWindowTitles('Safari', [
    { windowTitle: 'Work — SPCS Build Proposal CCI - Presentation', durationSeconds: 2606 },
    { windowTitle: 'Personal — (19) YouTube', durationSeconds: 140 },
  ])
  const labels = clusters.map((c) => c.label)
  for (const label of labels) {
    assert.ok(!/^work\b|^personal\b/i.test(label), `profile prefix leaked: ${label}`)
    assert.ok(!/\(\d+\)/.test(label), `badge leaked: ${label}`)
  }
  assert.ok(labels.some((l) => /SPCS Build Proposal/i.test(l)), `expected the proposal cluster, got ${labels.join(', ')}`)
})

test('chrome titles and the app own name carry no context', () => {
  assert.deepEqual(clusterWindowTitles('Granola', [
    { windowTitle: 'Granola', durationSeconds: 797 },
  ]), [])
  assert.deepEqual(clusterWindowTitles('Dia', [
    { windowTitle: 'New Tab', durationSeconds: 400 },
    { windowTitle: 'Untitled', durationSeconds: 400 },
  ]), [])
})

test('emails are stripped from labels', () => {
  const clusters = clusterWindowTitles('Dia', [
    { windowTitle: 'Important • r.mensah3@example-college.edu', durationSeconds: 400 },
  ])
  for (const c of clusters) {
    assert.ok(!c.label.includes('@'), `email leaked: ${c.label}`)
  }
})

test('terminal spinner glyphs and decorations are stripped', () => {
  const clusters = clusterWindowTitles('Warp', [
    { windowTitle: '⠐ Confirm PostHog events implementation', durationSeconds: 900 },
    { windowTitle: '✳ Claude Code', durationSeconds: 300 },
  ])
  for (const c of clusters) {
    assert.ok(/^[A-Za-z]/.test(c.label), `decoration leaked: ${c.label}`)
  }
  assert.ok(clusters.some((c) => /Confirm PostHog events/.test(c.label)))
})

test('buildDayTitleContext groups per app, biggest signal first', () => {
  const context = buildDayTitleContext([
    { appName: 'Safari', windowTitle: 'Work — SPCS Build Proposal CCI - Presentation', durationSeconds: 2606, category: 'productivity' },
    { appName: 'Warp', windowTitle: 'daylens — npm run dev', durationSeconds: 500, category: 'development' },
    { appName: 'loginwindow', windowTitle: 'x', durationSeconds: 900, category: 'system' },
  ])
  assert.ok(context.length >= 1)
  assert.equal(context[0].appName, 'Safari')
  assert.ok(context.every((a) => a.appName !== 'loginwindow'))
})
