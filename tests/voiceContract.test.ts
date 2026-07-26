import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BANNED_VOCAB,
  CITATION_CONTRACT,
  VOICE_SYSTEM_PROMPT,
  assertNoBannedVocab,
  containsEmDash,
  findBannedVocab,
  findPlumbingVocab,
} from '../src/main/ai/voiceContract.ts'

test('banned vocabulary matches the voice contract', () => {
  assert.deepEqual([...BANNED_VOCAB], [
    'dive into',
    'unleash',
    'navigate the landscape',
    "this isn't X, it's Y",
    "in today's fast-paced world",
    'game-changing',
    'seamless',
    'elevate',
    'great question',
    "let's explore",
    'at the end of the day',
    'fascinating perspective',
    "you're absolutely right",
    'harness the power',
    'empower',
    'robust',
    'streamline',
    'crush it',
    "you've got this",
    'great work',
    "let's dive in",
  ])
})

test('voice system prompt includes the citation contract', () => {
  for (const line of CITATION_CONTRACT) {
    assert.ok(VOICE_SYSTEM_PROMPT.includes(line))
  }
})

test('banned vocabulary assertion catches golden output drift', () => {
  assert.doesNotThrow(() => assertNoBannedVocab('Cursor appeared in the 9am block with github.com open.'))
  assert.throws(() => assertNoBannedVocab('Great question, let us dive into your day.'))
})

test('the em dash ban is stated in the prompt and absent from its own examples', () => {
  // The model imitates the punctuation of its own prompt, so the contract
  // stating the rule and the contract obeying it are one requirement.
  assert.match(VOICE_SYSTEM_PROMPT, /never write an em dash/)
  const examplesAndRules = VOICE_SYSTEM_PROMPT.split('\n')
  for (const line of examplesAndRules) {
    if (line.includes('never write an em dash')) continue
    assert.ok(!line.includes('—'), `voice prompt teaches an em dash: ${line}`)
  }
})

test('containsEmDash flags em dashes and stand-in double hyphens, not range en dashes', () => {
  assert.equal(containsEmDash('You were on Coursera from 10:49 to 12:12.'), false)
  assert.equal(containsEmDash('The block ran 09:09–10:08, then Slack.'), false)
  assert.equal(containsEmDash('Yesterday was light — just two blocks.'), true)
  assert.equal(containsEmDash('Yesterday was light -- just two blocks.'), true)
})

test('the plumbing ban stays narrow enough for the honest capability answer', () => {
  // "window titles" and "tracked activity" must stay sayable: the capability
  // answer names window titles as something Daylens captures, and the wrap
  // reports how much tracked activity a day was built from.
  assert.equal(findPlumbingVocab('I see which app is in front, plus window titles and the pages you visit.'), null)
  assert.equal(findPlumbingVocab('Built from 1h 15m of tracked activity, 9:16pm to 1:01am.'), null)
  assert.equal(findPlumbingVocab('page-level detail covers 0m of that'), 'page-level detail')
  assert.equal(findPlumbingVocab('Safari was foreground 40m'), 'foreground')
})

test('findBannedVocab is the SOFT, non-throwing guard used in the live answer path', () => {
  // It must NEVER throw — by the time a chat answer is checked it has already
  // streamed to the user; the soft guard only reports for voice monitoring.
  assert.equal(findBannedVocab('Cursor appeared in the 9am block with github.com open.'), null)
  assert.equal(findBannedVocab('Great question, let us dive into your day.'), 'dive into')
})

