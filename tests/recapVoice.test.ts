import test from 'node:test'
import assert from 'node:assert/strict'
import { recapVoiceFindings } from '../src/shared/labelVoice.ts'

// DEV-275: the recap must read as prose a person could have written — no
// internal vocabulary, no stat-dump shapes. This check is the eval that fails
// the shipped template and passes calm, grounded prose.

test('the shipped "trusted blocks" recap shape fails the voice check', () => {
  const shipped = 'You tracked 1h 42m across 2 trusted blocks today. The clearest named block was daylens (Channel) for 1h 18m. Strongest evidence included daylens (Channel), This week (Jul 19–26), App registrations. Focus held for 1h 42m (100% of tracked time).'
  const findings = recapVoiceFindings(shipped)
  const phrases = findings.map((f) => f.phrase)
  assert.ok(phrases.includes('trusted block'), 'must flag "trusted blocks"')
  assert.ok(phrases.includes('strongest evidence'), 'must flag "strongest evidence"')
  assert.ok(phrases.includes('clearest named block'), 'must flag "clearest named block"')
  assert.ok(phrases.includes('of tracked time'), 'must flag the focus stat-dump')
  assert.ok(findings.length >= 4, `expected several violations, got ${findings.length}`)
})

test('calm grounded recap prose passes', () => {
  const good = 'Most of the day went to shipping the Daylens recap work — building the grounded day context and wiring the progress feedback — with a short stretch reviewing two pull requests before the standup.'
  assert.deepEqual(recapVoiceFindings(good), [])
})

test('the plain deterministic fallback line passes — a factual line is not a stat dump', () => {
  // The new fallbackDaySummary shape: plain, factual, no internal vocabulary.
  const fallback = '6h 12m tracked across 5 blocks. Longest stretch: Shipping the recap agent (1h 30m).'
  assert.deepEqual(recapVoiceFindings(fallback), [])
})

test('judgment and telemetry vocabulary are flagged', () => {
  assert.ok(recapVoiceFindings('A productive morning of foreground app sessions.').length >= 1)
  assert.ok(recapVoiceFindings('You wasted the afternoon.').some((f) => f.reason.includes('productivity')))
})
