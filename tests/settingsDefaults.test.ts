// Defaults that are load-bearing, pinned so they cannot drift back.
//
// A default is not a preference when other code reads it as a signal. Both of
// these were shipped wrong in a way no unit test could see: the routing
// function that consumes aiChatProvider was correct and green the whole time,
// because its "no override set" case simply never occurred in a real install.
import test from 'node:test'
import assert from 'node:assert/strict'
import { SHIPPING_DEFAULT_ANTHROPIC_MODEL } from '../src/shared/aiProviderState.ts'
import { DEFAULTS } from '../src/main/services/settings.ts'
import { selectJobProvider, applyProviderChangeToSettings } from '../src/main/lib/providerRouting.ts'
import { modelForProvider } from '../src/main/services/aiOrchestration.ts'

test('the shipping default model is Claude Haiku 4.5, not a strategy alias', () => {
  assert.equal(DEFAULTS.anthropicModel, SHIPPING_DEFAULT_ANTHROPIC_MODEL)
  assert.equal(DEFAULTS.anthropicModel, 'claude-haiku-4-5')
  assert.equal(DEFAULTS.aiModelStrategy, 'balanced')
  assert.equal(modelForProvider('anthropic', DEFAULTS), 'claude-haiku-4-5')
  assert.equal(modelForProvider('anthropic', 'quality', DEFAULTS), 'claude-haiku-4-5')
  assert.equal(
    modelForProvider('anthropic', 'balanced', { ...DEFAULTS, anthropicModel: 'claude-sonnet-4-6' }),
    'claude-sonnet-4-6',
    'an explicit model wins over the balanced strategy',
  )
})

test('chat starts with no provider of its own, so it follows the one in Settings', () => {
  // A concrete default here reads as "the person explicitly chose Anthropic for
  // chat", and nothing ever clears it: connecting the Claude CLI in Settings
  // left chat still calling the Anthropic API, on an account with no credit.
  assert.equal(
    DEFAULTS.aiChatProvider,
    undefined,
    'aiChatProvider must start unset; any concrete value pins chat away from the Settings provider',
  )
})

test('with the shipped defaults, connecting a provider moves chat too', () => {
  const connected = { aiProvider: 'claude-cli' as const, aiChatProvider: DEFAULTS.aiChatProvider }
  assert.equal(selectJobProvider(true, connected), 'claude-cli', 'chat did not follow the connected provider')
  assert.equal(selectJobProvider(false, connected), 'claude-cli', 'a background surface did not follow it either')
})

test('an explicit per-chat choice still wins', () => {
  // The override is a real feature; the fix must not flatten it.
  assert.equal(selectJobProvider(true, { aiProvider: 'claude-cli', aiChatProvider: 'openai' }), 'openai')
})

test('switching provider retires a chat pin that could no longer be reached', () => {
  // The chat picker only lists API providers, so a pin left behind after a
  // switch to a CLI provider is unreachable from the chat UI: Settings reads
  // Claude CLI while chat keeps calling the old account.
  const written = applyProviderChangeToSettings(
    { aiProvider: 'anthropic', aiChatProvider: 'anthropic' },
    { aiProvider: 'claude-cli' },
  )
  assert.ok('aiChatProvider' in written, 'the pin must be written as an explicit clear, not simply omitted')
  assert.equal(written.aiChatProvider, undefined)
  assert.equal(selectJobProvider(true, { aiProvider: 'claude-cli', aiChatProvider: written.aiChatProvider }), 'claude-cli')
})

test('an explicit null chat pin clears even when the Settings provider does not change', () => {
  const written = applyProviderChangeToSettings(
    { aiProvider: 'anthropic', aiChatProvider: 'openai' },
    { aiChatProvider: null },
  )
  assert.equal(written.aiChatProvider, undefined)
  assert.equal(selectJobProvider(true, { aiProvider: 'anthropic', aiChatProvider: written.aiChatProvider }), 'anthropic')
})

test('a write that states its own chat provider is left alone', () => {
  const written = applyProviderChangeToSettings(
    { aiProvider: 'anthropic', aiChatProvider: 'anthropic' },
    { aiProvider: 'claude-cli', aiChatProvider: 'openai' },
  )
  assert.equal(written.aiChatProvider, 'openai')
})

test('an unrelated settings write never touches the chat pin', () => {
  const previous = { aiProvider: 'anthropic' as const, aiChatProvider: 'openai' as const }
  assert.deepEqual(applyProviderChangeToSettings(previous, { userName: 'Tonny' }), { userName: 'Tonny' })
  // Re-saving the same provider is not a switch.
  assert.deepEqual(applyProviderChangeToSettings(previous, { aiProvider: 'anthropic' }), { aiProvider: 'anthropic' })
})

test('the interpretation agent is on out of the box', () => {
  // It was held off by default until its offline fixture eval passed. That eval
  // passes (npm run timeline:eval -- --strict, plus the interpretationEval and
  // interpretationAgentRelabel suites), so the gate is satisfied and a day gets
  // the extra context when naming low-confidence blocks without being asked.
  assert.equal(DEFAULTS.interpretationAgentEnabled, true)
})
