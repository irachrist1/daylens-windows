// WO-104 / REQ-VIC-002. One chosen tone across every surface that describes
// activity, and one set of interpretation rules underneath it.
//
// The prompt-site checks are static reads of the source, in the same shape as
// tests/voiceContract.test.ts: they cannot execute a prompt, but they can stop a
// new narrative job shipping without the tone or the policy.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ACTIVITY_DESCRIPTION_DIRECTIVES,
  DESCRIPTION_VOICE_DIRECTIVES,
  INTERPRETATION_DIRECTIVES,
} from '../src/shared/activityDescription.ts'
import {
  DEFAULT_SUMMARY_VOICE,
  SUMMARY_VOICES,
  normalizeSummaryVoice,
  voiceDirective,
} from '../src/shared/summaryVoice.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')

function source(relativePath: string): string {
  const absolute = path.join(REPO_ROOT, relativePath)
  assert.ok(fs.existsSync(absolute), `missing on disk: ${relativePath}`)
  return fs.readFileSync(absolute, 'utf8')
}

// Every site that composes a prompt for a generated activity description a
// person reads. Adding one here is the deliberate gesture that says "this
// surface speaks to the person, so it speaks in their chosen voice."
const NARRATIVE_PROMPT_SITES: Array<{ path: string; label: string }> = [
  { path: 'src/main/jobs/aiService.ts', label: 'the brief (day_summary), week_review, app_narrative' },
  { path: 'src/main/services/wrappedNarrative.ts', label: 'Wrapped day' },
  { path: 'src/main/services/wrappedPeriodNarrative.ts', label: 'Wrapped week/month' },
  { path: 'src/main/services/wrappedQuestion.ts', label: 'Wrapped question' },
]

// ── AC-VIC-002.1: the tone is normalized and real ──────────────────────────

test('AC-VIC-002.1: each tone produces its own instruction', () => {
  const directives = SUMMARY_VOICES.map((voice) => voiceDirective(voice))
  assert.equal(new Set(directives).size, SUMMARY_VOICES.length, 'two tones produce the same instruction')
  for (const directive of directives) {
    assert.match(directive, /^Voice: /)
  }
})

test('AC-VIC-002.1: a missing or invalid stored tone falls back to warm', () => {
  assert.equal(DEFAULT_SUMMARY_VOICE, 'warm')
  for (const bad of [undefined, null, '', 'sarcastic', 42, {}]) {
    assert.equal(normalizeSummaryVoice(bad), 'warm', `not normalized: ${String(bad)}`)
  }
  assert.equal(voiceDirective(undefined), voiceDirective('warm'))
})

// ── AC-VIC-002.2: every narrative surface applies it ───────────────────────

test('AC-VIC-002.2: every narrative prompt site imports and applies the tone', () => {
  for (const site of NARRATIVE_PROMPT_SITES) {
    const text = source(site.path)
    assert.match(text, /from ['"][^'"]*summaryVoice['"]/, `${site.label}: does not import from summaryVoice`)
    assert.match(text, /voiceDirective\(/, `${site.label}: never calls voiceDirective`)
  }
})

test('AC-VIC-002.2: the brief applies the tone, and its cache is keyed on it', () => {
  // The finding this work order closes: voiceDirective moved Wrapped and not
  // the day recap, which is the surface people read every morning.
  const text = source('src/main/jobs/aiService.ts')
  const recap = text.slice(text.indexOf('export async function generateDaySummary'))
  assert.match(recap, /voiceDirective\(voice\)/, 'the brief prompt has no tone directive')
  assert.match(recap, /cacheKey = .*\$\{voice\}/, 'the brief cache is not keyed on the tone')
})

// ── AC-VIC-002.3: one interpretation under every tone ──────────────────────

test('AC-VIC-002.3: every narrative prompt site carries the interpretation directives', () => {
  for (const site of NARRATIVE_PROMPT_SITES) {
    const text = source(site.path)
    const carries = /INTERPRETATION_DIRECTIVES/.test(text)
    // Wrapped day and period compose their prompts in lib/, so the service file
    // delegates. Accept either the site itself or its composer.
    if (!carries) {
      const composer = site.path.replace('/services/', '/lib/')
      assert.match(
        source(composer),
        /INTERPRETATION_DIRECTIVES/,
        `${site.label}: neither it nor its composer carries the interpretation directives`,
      )
    }
  }
})

test('AC-VIC-002.3: the split keeps the combined constant whole', () => {
  assert.deepEqual(
    [...ACTIVITY_DESCRIPTION_DIRECTIVES],
    [...INTERPRETATION_DIRECTIVES, ...DESCRIPTION_VOICE_DIRECTIVES],
  )
  assert.ok(INTERPRETATION_DIRECTIVES.length > 0 && DESCRIPTION_VOICE_DIRECTIVES.length > 0)
})

test('the Wrapped decks take the interpretation half only, so the prompt does not argue with itself', () => {
  // The deck prompt earns the right to praise a real named thing. A blanket
  // grading ban composed into it would contradict its own rule two lines down.
  for (const composer of ['src/main/lib/wrappedNarrative.ts', 'src/main/lib/wrappedPeriodNarrative.ts']) {
    const text = source(composer)
    assert.match(text, /INTERPRETATION_DIRECTIVES/, `${composer}: no interpretation directives`)
    assert.doesNotMatch(text, /DESCRIPTION_VOICE_DIRECTIVES/, `${composer}: composed the grading ban`)
    assert.match(text, /EARNED PRAISE IS ALLOWED/, `${composer}: lost its earned-praise rule`)
  }
})

// ── D4: a prompt must not teach the punctuation the contract bans ──────────

test('no prompt constant teaches an em dash while the voice contract bans it', () => {
  // The old USER_VISIBLE_ACTIVITY_PROSE_RULE ended by explaining what the
  // em dash separates, in the same prompt that says never to write one. The
  // model imitates the punctuation of its own prompt.
  const text = source('src/main/jobs/aiService.ts')
  const rule = text.slice(
    text.indexOf('const USER_VISIBLE_ACTIVITY_PROSE_RULE'),
    text.indexOf('const USER_AUTHORED_LABEL_RULE'),
  )
  assert.ok(rule.length > 0, 'could not find the prose rule')
  assert.doesNotMatch(rule, /—/, 'the prose rule still contains an em dash')
  assert.doesNotMatch(rule, /em-dash|em dash separates/i, 'the prose rule still teaches the em dash')
})

test('the interpretation directives themselves contain no em dash', () => {
  for (const directive of ACTIVITY_DESCRIPTION_DIRECTIVES) {
    assert.doesNotMatch(directive, /—/, `directive teaches an em dash: ${directive.slice(0, 60)}`)
  }
})
