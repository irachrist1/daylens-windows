// Citation presentation (DEV-244): citations render as human titles, never
// raw kebab-case filenames with content hashes. Display-only — the stable
// identity and full statement stay on the record for the inspector.
import test from 'node:test'
import assert from 'node:assert/strict'
import { citationDisplayTitle, humanizeFileTitle } from '../src/shared/citationDisplay.ts'

test('humanizeFileTitle turns kebab-case filenames with hashes into readable titles', () => {
  assert.equal(humanizeFileTitle('prompts-are-technical-debt-4f2a9c.md'), 'Prompts are technical debt')
  assert.equal(humanizeFileTitle('acme_quarterly_report_20260114.pdf'), 'Acme quarterly report')
  assert.equal(humanizeFileTitle('meeting-notes.docx'), 'Meeting notes')
  assert.equal(humanizeFileTitle('Acme launch plan.md'), 'Acme launch plan')
})

test('humanizeFileTitle never returns empty and leaves already-clean names intact', () => {
  assert.equal(humanizeFileTitle('README'), 'README')
  assert.equal(humanizeFileTitle('  '), '')
  // A name that is ALL noise still comes back as itself, not a blank chip.
  assert.equal(humanizeFileTitle('4f2a9c1b'), '4f2a9c1b')
})

test('file-excerpt citations resolve to the humanized file name, not the excerpt', () => {
  assert.equal(
    citationDisplayTitle({
      kind: 'file_excerpt',
      identity: 'file:/Users/me/vault/prompts-are-technical-debt-4f2a9c.md',
      statement: 'prompts-are-technical-debt-4f2a9c.md: Prompts rot the same way code does…',
    }),
    'Prompts are technical debt',
  )
})

test('transcript citations name the meeting', () => {
  assert.equal(
    citationDisplayTitle({
      kind: 'file_excerpt',
      identity: 'transcript:granola:doc-123',
      statement: 'Granola transcript of "ACME weekly sync": Norman opened with the budget…',
    }),
    'Transcript: ACME weekly sync',
  )
})

test('filename-shaped search statements are humanized; prose statements pass through', () => {
  assert.equal(
    citationDisplayTitle({
      kind: 'search_exact',
      identity: 'artifact:42',
      statement: 'daylens-wrapped-brainstorm-9c81f2a340.md',
    }),
    'Daylens wrapped brainstorm',
  )
  assert.equal(
    citationDisplayTitle({
      kind: 'day_fact',
      identity: 'block:7',
      statement: '09:00–10:30 Deep work on the planner refactor (Ghostty)',
    }),
    '09:00–10:30 Deep work on the planner refactor (Ghostty)',
  )
  assert.equal(
    citationDisplayTitle({
      kind: 'corrected_fact',
      identity: 'fact:abc',
      statement: 'Standup runs at 09:00 every day',
    }),
    'Standup runs at 09:00 every day',
  )
})
