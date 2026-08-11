import test from 'node:test'
import assert from 'node:assert/strict'
import {
  citationFallback,
  extractNamedEntities,
  verifyCitedEntities,
  verifyTimestamps,
} from '../src/main/ai/citations.ts'

test('extractNamedEntities captures quoted and filename entities (not bare capitals)', () => {
  // Quoted strings and filenames are the only signal we trust — bare
  // capitalised words like "Cursor" or "GitHub" produce too many false
  // positives against tool result JSON (paraphrasing, casing).
  const entities = extractNamedEntities('Cursor showed "ASYV Report" and schema.sql near GitHub.')
  assert.ok(entities.includes('ASYV Report'))
  assert.ok(entities.includes('schema.sql'))
  assert.ok(!entities.includes('Cursor'))
  assert.ok(!entities.includes('GitHub'))
})

test('scare quotes around the model\'s own prose are not citations', () => {
  // A lowercase, digitless quoted phrase is emphasis, not a cited entity.
  // Flagging one used to cost a full grounding retry: the model re-ran its
  // whole tool sweep and rewrote a correct answer into defensive prose.
  const entities = extractNamedEntities(
    'Not much of a "watching" day. Your "top apps" were quiet, and the branch was "merged, plus" a revert.',
  )
  assert.deepEqual(entities, [])

  const verdict = verifyCitedEntities('Nothing that counts as "watching" happened.', [
    JSON.stringify({ pages: [{ title: 'Programming Thinking', seconds: 45 }] }),
  ])
  assert.equal(verdict.ok, true)

  // A real title still gets checked, even when most of it is lowercase.
  const real = extractNamedEntities('The block was labeled "Reviewing ML fundamentals".')
  assert.ok(real.includes('Reviewing ML fundamentals'))
})

test('verifyCitedEntities passes when entities appear in tool results', () => {
  const result = verifyCitedEntities('Cursor and GitHub appeared together.', [
    JSON.stringify({ app: 'Cursor', page: 'GitHub pull request' }),
  ])
  assert.equal(result.ok, true)
  assert.deepEqual(result.missingEntities, [])
})

test('verifyCitedEntities rejects hallucinated quoted entities', () => {
  // Conversational mentions of "Cursor" and "Notion" no longer trigger
  // checks (too many false positives). The verifier now only fires on
  // explicit citations: quoted strings and filenames.
  const result = verifyCitedEntities('Cursor and Notion appeared together.', [
    JSON.stringify({ app: 'Cursor', page: 'GitHub pull request' }),
  ])
  assert.equal(result.ok, true)

  const quoted = verifyCitedEntities('The window title was "Q2 Plan Draft".', [
    JSON.stringify({ title: 'something else entirely' }),
  ])
  assert.equal(quoted.ok, false)
  assert.ok(quoted.missingEntities.includes('Q2 Plan Draft'))
})

test('verifyCitedEntities passes all-stopword answer with no entities', () => {
  const result = verifyCitedEntities('Today was 2h 10m across two blocks.', ['{}'])
  assert.equal(result.ok, true)
})

test('verifyCitedEntities enforces quoted-string entities', () => {
  const result = verifyCitedEntities('The window title was "ASYV Budget Draft".', [
    JSON.stringify({ title: 'ASYV board deck' }),
  ])
  assert.equal(result.ok, false)
  assert.ok(result.missingEntities.includes('ASYV Budget Draft'))
})

test('citationFallback names unsupported entities and surfaces available evidence', () => {
  const text = citationFallback(['Notion'], [JSON.stringify({ topApps: [{ appName: 'Cursor' }, { appName: 'Dia' }] })])
  assert.ok(text.includes('Notion'))
  assert.ok(text.includes('Cursor'))
  assert.ok(!text.includes("I can't see evidence"))
})

test('citationFallback with empty tool results still mentions the missing entity', () => {
  const text = citationFallback(['Notion'], [])
  assert.ok(text.includes('Notion'))
  assert.ok(!text.includes("I can't see evidence"))
})

test('timestamp verification accepts unmarked 12-hour ranges backed by 24-hour evidence', () => {
  assert.equal(verifyTimestamps('3:00–3:10', ['15:00 15:10']).ok, true)
  assert.equal(verifyTimestamps('3:00pm–3:10pm', ['15:00 15:10']).ok, true)
  assert.equal(verifyTimestamps('3:00–3:10', ['09:00 09:10']).ok, false)
})
