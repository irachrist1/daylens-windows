import test from 'node:test'
import assert from 'node:assert/strict'
import { AI_PROVIDER_META } from '../src/renderer/lib/aiProvider.ts'

// Catalog integrity + the verified GA models.

test('every provider default model is one of its offered models', () => {
  for (const [provider, meta] of Object.entries(AI_PROVIDER_META)) {
    const ids = meta.models.map((m) => m.id)
    assert.ok(ids.includes(meta.defaultModel), `${provider} default ${meta.defaultModel} not in [${ids.join(', ')}]`)
  }
})

test('Gemini uses the GA flash-lite default, never the shut-down preview id', () => {
  const google = AI_PROVIDER_META.google
  assert.equal(google.defaultModel, 'gemini-3.1-flash-lite')
  const ids = google.models.map((m) => m.id)
  assert.ok(ids.includes('gemini-3.1-flash-lite'))
  assert.ok(ids.includes('gemini-3.5-flash'))
  assert.ok(!ids.some((id) => id.includes('flash-lite-preview')), 'must not offer the shut-down gemini-3.1-flash-lite-preview')
})

test('flagship ids are refreshed (OpenAI 5.5, Anthropic Opus 4.8)', () => {
  assert.equal(AI_PROVIDER_META.openai.defaultModel, 'gpt-5.5')
  assert.ok(AI_PROVIDER_META.openai.models.some((m) => m.id === 'gpt-5.5'))
  assert.ok(AI_PROVIDER_META.anthropic.models.some((m) => m.id === 'claude-opus-4-8'))
  assert.ok(AI_PROVIDER_META.anthropic.models.some((m) => m.id === 'claude-sonnet-5'))
  assert.ok(!AI_PROVIDER_META.anthropic.models.some((m) => m.id === 'claude-opus-4-6'), 'opus 4.6 should be replaced by 4.8')
})

test('shipping default is Claude Haiku 4.5 on Anthropic and Claude CLI', () => {
  assert.equal(AI_PROVIDER_META.anthropic.defaultModel, 'claude-haiku-4-5')
  assert.equal(AI_PROVIDER_META['claude-cli'].defaultModel, 'claude-haiku-4-5')
  assert.ok(AI_PROVIDER_META.anthropic.models.some((m) => m.id === 'claude-haiku-4-5'))
  assert.ok(AI_PROVIDER_META['claude-cli'].models.some((m) => m.id === 'claude-haiku-4-5'))
})
