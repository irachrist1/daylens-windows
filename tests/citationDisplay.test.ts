import test from 'node:test'
import assert from 'node:assert/strict'
import { citationDisplayTitle } from '../src/shared/citationDisplay.ts'

test('file citations read as titles, not kebab-case filenames with hashes', () => {
  assert.equal(
    citationDisplayTitle({
      identity: 'file:/Users/me/Obsidian/prompts-are-technical-debt-7f3a9c.md',
      kind: 'file_excerpt',
      statement: 'prompts-are-technical-debt-7f3a9c.md: The essay argues prompts rot like code.',
    }),
    'Prompts Are Technical Debt',
  )
  assert.equal(
    citationDisplayTitle({
      identity: 'file:/home/person/notes/Launch Plan.md',
      kind: 'file_excerpt',
      statement: 'Launch Plan.md: three tiers, annual billing.',
    }),
    'Launch Plan',
  )
  assert.equal(
    citationDisplayTitle({
      identity: 'transcript:granola:abc',
      kind: 'file_excerpt',
      statement: 'Granola transcript of "ACME kickoff": We decided to ship Friday.',
    }),
    'Granola transcript of "ACME kickoff"',
  )
})

test('day-fact citations keep the human statement, not the identity', () => {
  assert.equal(
    citationDisplayTitle({
      identity: 'block:42',
      kind: 'day_fact',
      statement: '09:00–11:14 Daylens Wrapped (Cursor)',
    }),
    '09:00–11:14 Daylens Wrapped (Cursor)',
  )
})
