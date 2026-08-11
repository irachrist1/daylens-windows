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
import {
  buildDaySummarySystemPrompt,
  daySummaryPromptCacheKey,
} from '../src/main/jobs/aiService.ts'
import type { DayTimelinePayload } from '../src/shared/types.ts'

// A day with no activity: enough to key a cache entry, and it carries no
// invented personal detail at all.
function emptyDayPayload(): DayTimelinePayload {
  return {
    date: '2026-06-22',
    sessions: [],
    websites: [],
    blocks: [],
    segments: [],
    focusSessions: [],
    computedAt: 0,
    version: 'test',
    totalSeconds: 0,
    focusSeconds: 0,
    focusPct: 0,
    appCount: 0,
    siteCount: 0,
  }
}

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
  // Both are composed by exported helpers now, so the behavioral tests at the
  // bottom of this file prove the tone actually lands. This scan only guards
  // that generateDaySummary still routes through them instead of rebuilding a
  // prompt or a key inline without the voice.
  const text = source('src/main/jobs/aiService.ts')
  const recap = text.slice(text.indexOf('export async function generateDaySummary'))
  assert.match(recap, /buildDaySummarySystemPrompt\(voice/, 'the brief prompt has no tone directive')
  assert.match(recap, /daySummaryPromptCacheKey\([^)]*voice\)/, 'the brief cache is not keyed on the tone')
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

// ── The brief, executed rather than scanned ────────────────────────────────
//
// The checks above can only prove `voiceDirective` is mentioned in a file. The
// ones below run the recap's own prompt composition and cache key, which is
// what the manual check "switch the tone in Settings, reopen the day recap"
// was standing in for. They need no provider and no live app.

test('AC-VIC-002.1: the recap prompt carries the tone that was chosen', () => {
  for (const voice of SUMMARY_VOICES) {
    const prompt = buildDaySummarySystemPrompt(voice)
    assert.ok(prompt.includes(voiceDirective(voice)), `the recap prompt has no ${voice} directive`)
  }
})

test('AC-VIC-002.1: changing the tone changes the recap prompt', () => {
  const prompts = SUMMARY_VOICES.map((voice) => buildDaySummarySystemPrompt(voice))
  assert.equal(new Set(prompts).size, SUMMARY_VOICES.length, 'two tones compose the same recap prompt')
})

test('AC-VIC-002.3: the recap prompt carries the shared interpretation rules under every tone', () => {
  for (const voice of SUMMARY_VOICES) {
    const prompt = buildDaySummarySystemPrompt(voice)
    for (const directive of INTERPRETATION_DIRECTIVES) {
      assert.ok(prompt.includes(directive), `${voice}: missing ${directive.slice(0, 50)}…`)
    }
    // AC-VIC-004.3: the rule that stops a person's own wording being re-read as
    // a system-derived fact travels with every tone, not just the default.
    assert.match(prompt, /labelIsTheirOwnWords/, `${voice}: no user-authored label rule`)
  }
})

test('AC-VIC-002.1: the recap cache is keyed on the tone, so the toggle is not dead', () => {
  // Without the tone in the key, a cached recap keeps the old voice for the
  // life of the process and switching the setting appears to do nothing.
  const payload = emptyDayPayload()
  const keys = SUMMARY_VOICES.map((voice) => daySummaryPromptCacheKey(payload, 'memory', 'shipped', voice))
  assert.equal(new Set(keys).size, SUMMARY_VOICES.length, 'two tones share one cache entry')
  assert.equal(
    daySummaryPromptCacheKey(payload, 'memory', 'shipped', 'warm'),
    daySummaryPromptCacheKey(payload, 'memory', 'shipped', 'warm'),
    'the key is not stable for one tone',
  )
})
