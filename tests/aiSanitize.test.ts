import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeForModel, sanitizeForRender, stripLegacyMemoryNudge } from '../src/shared/aiSanitize'

test('legacy inline memory nudges are removed from stored chat answers', () => {
  const answer = 'Monday was your strongest work day.\n\nBy the way — you use Dia most often. Want me to remember that? Just say "remember that".'
  assert.equal(stripLegacyMemoryNudge(answer), 'Monday was your strongest work day.')
})

test('normal answer text is unchanged', () => {
  const answer = 'You asked me to remember that Acme is your largest client.'
  assert.equal(stripLegacyMemoryNudge(answer), answer)
})

test('public resource links keep a lone non-secret video id', () => {
  const link = 'https://media.example/watch?v=Abc_123-xyz'
  assert.equal(sanitizeForModel(link), link)
  assert.equal(sanitizeForRender(link).text, link)
  assert.equal(sanitizeForModel(`${link}&token=secret-value`), link)
})

test('long hyphenated document filenames are not redacted', () => {
  // safeFilename() produces exactly this shape for chat artifacts; the
  // generic_token backstop used to render it as "[redacted].md".
  const line = 'Saved it as **weekly-report-for-your-manager-1a2b3c4d.md** in your artifacts.'
  assert.equal(sanitizeForRender(line).text, line)
  assert.equal(sanitizeForModel(line), line)
  // Mixed-case filenames trip the base64 backstop instead — same exemption.
  const mixed = 'Open MyProject-Notes-Draft2-Final-Version3.xlsx when you get a chance.'
  assert.equal(sanitizeForRender(mixed).text, mixed)
})

test('a bare high-entropy token is still redacted, filename exemption or not', () => {
  const token = 'q7Vb2mX9pL4dK8sT1zR6wN3yH5cJ0aFg'
  assert.equal(token.length >= 32, true)
  const rendered = sanitizeForRender(`your key is ${token} apparently`).text
  assert.ok(!rendered.includes(token))
  assert.ok(rendered.includes('[redacted]'))
  // Extension elsewhere in the sentence does not exempt the token itself.
  const withDoc = sanitizeForRender(`token ${token} is in notes.md`).text
  assert.ok(!withDoc.includes(token))
})
