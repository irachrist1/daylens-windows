// Defaults that are load-bearing, pinned so they cannot drift back.
//
// A default is not a preference when other code reads it as a signal. Both of
// these were shipped wrong in a way no unit test could see: the routing
// function that consumes aiChatProvider was correct and green the whole time,
// because its "no override set" case simply never occurred in a real install.
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS } from '../src/main/services/settings.ts'
import { selectJobProvider } from '../src/main/lib/providerRouting.ts'

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

test('the interpretation agent is on out of the box', () => {
  // It was held off by default until its offline fixture eval passed. That eval
  // passes (npm run timeline:eval -- --strict, plus the interpretationEval and
  // interpretationAgentRelabel suites), so the gate is satisfied and a day gets
  // the extra context when naming low-confidence blocks without being asked.
  assert.equal(DEFAULTS.interpretationAgentEnabled, true)
})
