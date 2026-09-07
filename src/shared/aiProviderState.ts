import type { AIProviderMode, AIThreadSettings, AppSettings } from './types'

/** Shipping default for Anthropic / Claude CLI. Product decision: DEV-242. */
export const SHIPPING_DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5'

export const CLI_PROVIDERS = ['claude-cli', 'chatgpt-cli', 'gemini-cli', 'codex-cli'] as const
export type CLIProvider = (typeof CLI_PROVIDERS)[number]

export type CLIToolName = 'claude' | 'chatgpt' | 'gemini' | 'codex'

export const CLI_TOOL_BY_PROVIDER: Record<CLIProvider, CLIToolName> = {
  'claude-cli': 'claude',
  'chatgpt-cli': 'chatgpt',
  'gemini-cli': 'gemini',
  'codex-cli': 'codex',
}

// Claude CLI can drive chat through the Daylens MCP server. The other local
// CLIs can run background text jobs but cannot make the structured tool calls
// the chat agent needs — they are not offered as chat sources.
export const CHAT_CAPABLE_CLI_PROVIDERS: readonly CLIProvider[] = ['claude-cli']

export const CLI_NOT_INSTALLED_REASON: Record<CLIProvider, string> = {
  'claude-cli': 'Claude CLI is not installed on this machine.',
  'chatgpt-cli': 'ChatGPT CLI is not installed on this machine.',
  'codex-cli': 'Codex CLI is not installed on this machine.',
  'gemini-cli': 'Gemini CLI is not installed on this machine.',
}

export const CLI_NOT_CHAT_CAPABLE_REASON =
  'Installed, but this CLI cannot run chat answers. Use an API key or Claude CLI.'

export type ProviderModelSettingKey = 'anthropicModel' | 'openaiModel' | 'googleModel' | 'openrouterModel'

export type AccountModelSettings = Pick<
  AppSettings,
  'aiProvider' | 'aiChatProvider' | 'anthropicModel' | 'openaiModel' | 'googleModel' | 'openrouterModel'
>

export function isCliProvider(provider: string | null | undefined): provider is CLIProvider {
  return provider === 'claude-cli'
    || provider === 'chatgpt-cli'
    || provider === 'gemini-cli'
    || provider === 'codex-cli'
}

export function cliToolForProvider(provider: string | null | undefined): CLIToolName | null {
  if (!isCliProvider(provider)) return null
  return CLI_TOOL_BY_PROVIDER[provider]
}

export function cliProviderCanServeChat(provider: AIProviderMode): boolean {
  return !isCliProvider(provider) || CHAT_CAPABLE_CLI_PROVIDERS.includes(provider)
}

export function accountProvider(settings: Pick<AppSettings, 'aiProvider'>): AIProviderMode {
  return settings.aiProvider ?? 'anthropic'
}

export function chatProvider(settings: Pick<AppSettings, 'aiProvider' | 'aiChatProvider'>): AIProviderMode {
  return settings.aiChatProvider ?? settings.aiProvider ?? 'anthropic'
}

export function modelSettingForProvider(provider: AIProviderMode): ProviderModelSettingKey {
  switch (provider) {
    case 'openai':
    case 'chatgpt-cli':
    case 'codex-cli':
      return 'openaiModel'
    case 'google':
    case 'gemini-cli':
      return 'googleModel'
    case 'openrouter':
      return 'openrouterModel'
    case 'anthropic':
    case 'claude-cli':
    default:
      return 'anthropicModel'
  }
}

export function accountModel(settings: AccountModelSettings, provider: AIProviderMode = chatProvider(settings)): string {
  const key = modelSettingForProvider(provider)
  const stored = settings[key]
  if (stored) return stored
  if (key === 'anthropicModel') return SHIPPING_DEFAULT_ANTHROPIC_MODEL
  return stored
}

export type ChatSelectionSource = 'thread' | 'account'

export function providerIsUsable(
  provider: AIProviderMode,
  availability: Partial<Record<AIProviderMode, boolean>> | undefined,
): boolean {
  if (!availability) return true
  if (!(provider in availability)) return true
  return availability[provider] === true
}

export function resolveChatSelection(input: {
  settings: AccountModelSettings
  thread?: Pick<AIThreadSettings, 'provider' | 'model'> | null
  providerAvailability?: Partial<Record<AIProviderMode, boolean>>
}): { provider: AIProviderMode; model: string; source: ChatSelectionSource } {
  const threadProvider = input.thread?.provider ?? null
  const threadModel = input.thread?.model ?? null
  if (threadProvider && threadModel && providerIsUsable(threadProvider, input.providerAvailability)) {
    return { provider: threadProvider, model: threadModel, source: 'thread' }
  }
  const provider = chatProvider(input.settings)
  return { provider, model: accountModel(input.settings, provider), source: 'account' }
}

export function buildCliProviderAvailability(
  cliTools: Partial<Record<CLIToolName, string | null | undefined>>,
): Partial<Record<AIProviderMode, boolean>> {
  const availability: Partial<Record<AIProviderMode, boolean>> = {}
  for (const provider of CLI_PROVIDERS) {
    availability[provider] = Boolean(cliTools[CLI_TOOL_BY_PROVIDER[provider]])
  }
  return availability
}

export function subscriptionSourceAvailability(input: {
  provider: CLIProvider
  installed: boolean
  purpose: 'chat' | 'all'
}): { available: boolean; unavailableReason: string | null } {
  if (input.purpose === 'chat' && !cliProviderCanServeChat(input.provider)) {
    return {
      available: false,
      unavailableReason: input.installed
        ? CLI_NOT_CHAT_CAPABLE_REASON
        : CLI_NOT_INSTALLED_REASON[input.provider],
    }
  }
  return {
    available: input.installed,
    unavailableReason: input.installed ? null : CLI_NOT_INSTALLED_REASON[input.provider],
  }
}
