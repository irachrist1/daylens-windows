import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CLI_PROVIDERS,
  CLI_TOOL_BY_PROVIDER,
  SHIPPING_DEFAULT_ANTHROPIC_MODEL,
  accountModel,
  accountProvider,
  buildCliProviderAvailability,
  chatProvider,
  cliProviderCanServeChat,
  cliToolForProvider,
  isCliProvider,
  modelSettingForProvider,
  resolveChatSelection,
  subscriptionSourceAvailability,
} from '../src/shared/aiProviderState.ts'
import { applyProviderChangeToSettings, selectJobProvider } from '../src/main/lib/providerRouting.ts'

const account = {
  aiProvider: 'anthropic' as const,
  aiChatProvider: undefined,
  anthropicModel: SHIPPING_DEFAULT_ANTHROPIC_MODEL,
  openaiModel: 'gpt-5.5',
  googleModel: 'gemini-3.1-flash-lite',
  openrouterModel: 'anthropic/claude-sonnet-4.6',
}

test('every catalogued CLI maps to one detection tool, including Codex', () => {
  assert.deepEqual([...CLI_PROVIDERS], ['claude-cli', 'chatgpt-cli', 'gemini-cli', 'codex-cli'])
  assert.equal(cliToolForProvider('codex-cli'), 'codex')
  assert.equal(CLI_TOOL_BY_PROVIDER['codex-cli'], 'codex')
  for (const provider of CLI_PROVIDERS) {
    assert.equal(isCliProvider(provider), true)
    assert.ok(cliToolForProvider(provider))
  }
})

test('only Claude CLI is offered as a chat-capable CLI', () => {
  assert.equal(cliProviderCanServeChat('claude-cli'), true)
  assert.equal(cliProviderCanServeChat('anthropic'), true)
  assert.equal(cliProviderCanServeChat('codex-cli'), false)
  assert.equal(cliProviderCanServeChat('chatgpt-cli'), false)
  assert.equal(cliProviderCanServeChat('gemini-cli'), false)
})

test('an installed Codex CLI is not reported as missing for chat — it is not offered', () => {
  const installed = subscriptionSourceAvailability({
    provider: 'codex-cli',
    installed: true,
    purpose: 'chat',
  })
  assert.equal(installed.available, false)
  assert.match(installed.unavailableReason ?? '', /cannot run chat/i)
  assert.doesNotMatch(installed.unavailableReason ?? '', /not installed/i)

  const missing = subscriptionSourceAvailability({
    provider: 'codex-cli',
    installed: false,
    purpose: 'chat',
  })
  assert.match(missing.unavailableReason ?? '', /not installed/i)
})

test('Settings and chat resolve the same provider when chat has no pin', () => {
  const connected = { ...account, aiProvider: 'claude-cli' as const }
  assert.equal(accountProvider(connected), 'claude-cli')
  assert.equal(chatProvider(connected), 'claude-cli')
  assert.equal(selectJobProvider(true, connected), 'claude-cli')
  assert.equal(selectJobProvider(false, connected), 'claude-cli')
})

test('the explicit Anthropic model is the account model — strategy is not a second source', () => {
  assert.equal(accountModel(account, 'anthropic'), 'claude-haiku-4-5')
  assert.equal(accountModel({ ...account, anthropicModel: 'claude-sonnet-4-6' }, 'anthropic'), 'claude-sonnet-4-6')
  assert.equal(accountModel(account, 'claude-cli'), 'claude-haiku-4-5')
  assert.equal(modelSettingForProvider('claude-cli'), 'anthropicModel')
  assert.equal(modelSettingForProvider('codex-cli'), 'openaiModel')
})

test('an empty Anthropic model falls back to the shipping Haiku default', () => {
  assert.equal(accountModel({ ...account, anthropicModel: '' }, 'anthropic'), 'claude-haiku-4-5')
})

test('a usable thread override wins; an unusable one falls back to Settings', () => {
  const settings = { ...account, aiProvider: 'claude-cli' as const, anthropicModel: 'claude-haiku-4-5' }
  const thread = { provider: 'openai' as const, model: 'gpt-5.5' }

  const kept = resolveChatSelection({
    settings,
    thread,
    providerAvailability: { openai: true, 'claude-cli': true },
  })
  assert.deepEqual(kept, { provider: 'openai', model: 'gpt-5.5', source: 'thread' })

  const fallen = resolveChatSelection({
    settings,
    thread,
    providerAvailability: { openai: false, 'claude-cli': true },
  })
  assert.deepEqual(fallen, { provider: 'claude-cli', model: 'claude-haiku-4-5', source: 'account' })

  const unsupportedCli = resolveChatSelection({
    settings,
    thread: { provider: 'codex-cli', model: 'gpt-5.5' },
    providerAvailability: { 'codex-cli': true, 'claude-cli': true },
  })
  assert.deepEqual(unsupportedCli, { provider: 'claude-cli', model: 'claude-haiku-4-5', source: 'account' })
})

test('switching Settings provider clears a leftover chat pin', () => {
  const written = applyProviderChangeToSettings(
    { aiProvider: 'anthropic', aiChatProvider: 'anthropic' },
    { aiProvider: 'claude-cli' },
  )
  assert.equal(written.aiChatProvider, undefined)
  assert.equal(
    chatProvider({ aiProvider: 'claude-cli', aiChatProvider: written.aiChatProvider }),
    'claude-cli',
  )
})

test('CLI availability comes from the probe, never from a skipped lookup', () => {
  const probed = buildCliProviderAvailability({ claude: '/usr/bin/claude', chatgpt: null, gemini: null, codex: '/usr/bin/codex' })
  assert.equal(probed['claude-cli'], true)
  assert.equal(probed['codex-cli'], true)
  assert.equal(probed['chatgpt-cli'], false)
  const skipped = buildCliProviderAvailability({ claude: null, chatgpt: null, gemini: null, codex: null })
  assert.equal(skipped['claude-cli'], false)
})
