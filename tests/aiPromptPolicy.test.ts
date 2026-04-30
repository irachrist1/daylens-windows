import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const aiSource = fs.readFileSync(path.resolve(import.meta.dirname, '../src/main/services/ai.ts'), 'utf8')

test('user-visible AI prose prompts prohibit raw app names as activity nouns', () => {
  const required = [
    'Never use raw app names as the activity',
    'Describe activity, work threads, artifacts, pages, or context instead of listing tool names as nouns.',
  ]

  for (const snippet of required) {
    assert.match(aiSource, new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})
