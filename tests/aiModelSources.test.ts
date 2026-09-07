// Provider sources for the model picker (DEV-201): managed allowance, your
// API keys, and your CLI subscriptions as ONE abstraction with honest
// availability — and the seam a bring-your-own-subscription provider
// (issue #5) slots into without picker changes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildModelSources } from '../src/shared/aiModelSources.ts'

const billingUsable = { mode: 'trial', canUseAI: true, message: 'Trial active.' } as const
const billingExhausted = {
  mode: 'trial',
  canUseAI: false,
  message: 'Trial credit is used up. Subscribe or add your own key in Settings.',
} as const

test('every source is present with honest availability — an unusable source says why, never vanishes', () => {
  const sources = buildModelSources({
    providerAvailability: { anthropic: true, 'claude-cli': true },
    billing: billingUsable,
  })
  const byId = new Map(sources.map((source) => [source.id, source]))

  assert.ok(byId.get('managed')?.available)
  assert.equal(byId.get('managed')?.costBasis, 'allowance_usd')

  assert.ok(byId.get('byok:anthropic')?.available)
  assert.equal(byId.get('byok:anthropic')?.costBasis, 'metered_usd')

  const openai = byId.get('byok:openai')!
  assert.equal(openai.available, false)
  assert.match(openai.unavailableReason ?? '', /No OpenAI API key/i)

  const claudeCli = byId.get('subscription:claude-cli')!
  assert.ok(claudeCli.available)
  assert.equal(claudeCli.costBasis, 'subscription_included')

  const codexCli = byId.get('subscription:codex-cli')!
  assert.equal(codexCli.available, false)
  assert.match(codexCli.unavailableReason ?? '', /not installed/i)
})

test('exhausted managed access keeps the source visible with the billing reason', () => {
  const sources = buildModelSources({ providerAvailability: {}, billing: billingExhausted })
  const managed = sources.find((source) => source.id === 'managed')!
  assert.equal(managed.available, false)
  assert.match(managed.unavailableReason ?? '', /used up/i)
})

test('a build without a billing service has no managed source at all', () => {
  for (const billing of [null, { mode: 'unavailable', canUseAI: false, message: 'x' } as const]) {
    const sources = buildModelSources({ providerAvailability: {}, billing })
    assert.equal(sources.some((source) => source.kind === 'managed'), false)
  }
})

test('chat sources never call an installed non-Claude CLI "not installed"', () => {
  const sources = buildModelSources({
    providerAvailability: { 'claude-cli': true, 'chatgpt-cli': true, 'codex-cli': true, 'gemini-cli': true },
    billing: null,
    purpose: 'chat',
  })
  const byId = new Map(sources.map((source) => [source.id, source]))

  assert.equal(byId.get('subscription:claude-cli')?.available, true)
  assert.equal(byId.get('subscription:claude-cli')?.unavailableReason, null)

  const codex = byId.get('subscription:codex-cli')!
  assert.equal(codex.available, false)
  assert.match(codex.unavailableReason ?? '', /cannot run chat/i)
  assert.doesNotMatch(codex.unavailableReason ?? '', /not installed/i)
})

test('chat sources still say not installed when the Claude CLI is missing', () => {
  const sources = buildModelSources({
    providerAvailability: {},
    billing: null,
    purpose: 'chat',
  })
  const claude = sources.find((source) => source.id === 'subscription:claude-cli')!
  assert.equal(claude.available, false)
  assert.match(claude.unavailableReason ?? '', /not installed/i)
})

test('the BYO seam: subscription sources are ordinary descriptors the picker renders generically', () => {
  const sources = buildModelSources({
    providerAvailability: { 'claude-cli': true, 'chatgpt-cli': true, 'codex-cli': true, 'gemini-cli': true },
    billing: null,
  })
  const subscriptions = sources.filter((source) => source.kind === 'subscription')
  assert.equal(subscriptions.length, 4)
  for (const source of subscriptions) {
    assert.ok(source.provider, source.id)
    assert.equal(source.costBasis, 'subscription_included')
    assert.equal(source.id, `subscription:${source.provider}`)
  }
})
