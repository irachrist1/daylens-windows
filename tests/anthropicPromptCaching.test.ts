import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAnthropicPromptInput } from '../src/main/services/anthropicPromptCaching.ts'

const prior = [
  { role: 'user' as const, content: 'Earlier question' },
  { role: 'assistant' as const, content: 'Earlier answer' },
]

test('stable_prefix caching marks the reusable system prompt', () => {
  const payload = buildAnthropicPromptInput(
    'System instructions',
    [],
    'Newest user turn',
    {
      cachePolicy: 'stable_prefix',
      promptCachingEnabled: true,
    },
  )

  assert.equal(payload.cache_control, undefined)
  assert.deepEqual(payload.system, [
    {
      type: 'text',
      text: 'System instructions',
      cache_control: { type: 'ephemeral' },
    },
  ])
  assert.deepEqual(payload.messages, [
    { role: 'user', content: 'Newest user turn' },
  ])
})

test('stable_prefix caching keeps the system prefix explicit for multi-turn requests', () => {
  const payload = buildAnthropicPromptInput(
    'System instructions',
    prior,
    'Newest user turn',
    {
      cachePolicy: 'stable_prefix',
      promptCachingEnabled: true,
    },
  )

  assert.deepEqual(payload.cache_control, { type: 'ephemeral' })
  assert.deepEqual(payload.system, [
    {
      type: 'text',
      text: 'System instructions',
      cache_control: { type: 'ephemeral' },
    },
  ])
  assert.deepEqual(payload.messages, [
    { role: 'user', content: 'Earlier question' },
    { role: 'assistant', content: 'Earlier answer' },
    { role: 'user', content: 'Newest user turn' },
  ])
})

test('repeated_payload caching marks the final user payload', () => {
  const payload = buildAnthropicPromptInput(
    'System instructions',
    [],
    'Repeat this exact export request',
    {
      cachePolicy: 'repeated_payload',
      promptCachingEnabled: true,
    },
  )

  assert.equal(payload.cache_control, undefined)
  assert.equal(payload.system, 'System instructions')
  assert.deepEqual(payload.messages, [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Repeat this exact export request',
          cache_control: { type: 'ephemeral' },
        },
      ],
    },
  ])
})

test('prompt caching toggle leaves Anthropic payload unmarked when disabled', () => {
  const payload = buildAnthropicPromptInput(
    'System instructions',
    prior,
    'Newest user turn',
    {
      cachePolicy: 'stable_prefix',
      promptCachingEnabled: false,
    },
  )

  assert.equal(payload.cache_control, undefined)
  assert.equal(payload.system, 'System instructions')
  assert.deepEqual(payload.messages, [
    { role: 'user', content: 'Earlier question' },
    { role: 'assistant', content: 'Earlier answer' },
    { role: 'user', content: 'Newest user turn' },
  ])
})
