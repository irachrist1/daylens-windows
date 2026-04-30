import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

test('timeline does not render focus percentage or focused-time copy', () => {
  const source = readSource('src/renderer/views/Timeline.tsx')

  assert.doesNotMatch(source, /Best focus/)
  assert.doesNotMatch(source, /focusPct}%/)
  assert.doesNotMatch(source, /focused •/)
  assert.doesNotMatch(source, /<\/strong> focused/)
})

test('ai landing summary does not render focus percentage copy', () => {
  const source = readSource('src/renderer/views/Insights.tsx')

  assert.doesNotMatch(source, /focusPct}%/)
  assert.doesNotMatch(source, /counted as focused time/)
})
