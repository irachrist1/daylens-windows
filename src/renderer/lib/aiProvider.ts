import { SHIPPING_DEFAULT_ANTHROPIC_MODEL, accountModel } from '@shared/aiProviderState'
import type { AIProvider, AIProviderMode } from '@shared/types'

export interface AIModelOption {
  id: string
  label: string
  description: string
}

export interface AIProviderMeta {
  id: AIProviderMode
  label: string
  shortLabel: string
  docsUrl: string
  keyPlaceholder: string
  helperText: string
  defaultModel: string
  models: AIModelOption[]
}

// ids verified against each provider's public model docs (ai.google.dev,
// platform.openai.com, Anthropic).
//   - Google: gemini-3.1-flash-lite-preview was SHUT DOWN; replaced
//     with the GA gemini-3.1-flash-lite (cheapest/highest-RPM → the default).
//     Added GA gemini-3.5-flash; dropped the gemini-3-flash-preview offering.
//   - OpenAI: flagship is gpt-5.5 (GA); mini/nano stay on 5.4.
//   - Anthropic: flagship is opus 4.8 (current); Sonnet 4.6 / Haiku 4.5 hold.
// The main-process tier fallback (services/aiOrchestration.ts) is kept a subset
// of these ids. settings.ts read-time-migrates the dead flash-lite-preview id.
// Live answer-quality testing per provider is a separate device step (needs keys).
export const AI_PROVIDER_META: Record<AIProviderMode, AIProviderMeta> = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    shortLabel: 'Claude',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    keyPlaceholder: 'sk-ant-…',
    helperText: 'Use your Claude API key.',
    defaultModel: SHIPPING_DEFAULT_ANTHROPIC_MODEL,
    models: [
      {
        id: 'claude-opus-4-8',
        label: 'Claude Opus 4.8',
        description: 'Latest flagship for the hardest coding and reasoning work.',
      },
      {
        id: 'claude-sonnet-5',
        label: 'Claude Sonnet 5',
        description: 'Latest Sonnet for fast, high-quality agentic work.',
      },
      {
        id: 'claude-sonnet-4-6',
        label: 'Claude Sonnet 4.6',
        description: 'Balanced Claude for speed plus high quality.',
      },
      {
        id: 'claude-haiku-4-5',
        label: 'Claude Haiku 4.5',
        description: 'Fastest current Claude option for lighter workloads.',
      },
    ],
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    shortLabel: 'OpenAI',
    docsUrl: 'https://platform.openai.com/api-keys',
    keyPlaceholder: 'sk-…',
    helperText: 'Use your OpenAI API key.',
    defaultModel: 'gpt-5.5',
    models: [
      {
        id: 'gpt-5.5',
        label: 'GPT-5.5',
        description: 'Latest flagship for complex reasoning, coding, and agentic work.',
      },
      {
        id: 'gpt-5.4-mini',
        label: 'GPT-5.4 mini',
        description: 'Strong mini model for coding and faster high-volume use.',
      },
      {
        id: 'gpt-5.4-nano',
        label: 'GPT-5.4 nano',
        description: 'Cheapest GPT-5.4-class model for simple fast requests.',
      },
    ],
  },
  google: {
    id: 'google',
    label: 'Google AI Studio',
    shortLabel: 'Gemini',
    docsUrl: 'https://aistudio.google.com/apikey',
    keyPlaceholder: 'AIza…',
    helperText: 'Use your Gemini Developer API key from AI Studio.',
    defaultModel: 'gemini-3.1-flash-lite',
    models: [
      {
        id: 'gemini-3.1-flash-lite',
        label: 'Gemini 3.1 Flash-Lite',
        description: 'Fastest, lowest-cost Gemini with the highest rate limits. The safest Daylens default.',
      },
      {
        id: 'gemini-3.5-flash',
        label: 'Gemini 3.5 Flash',
        description: 'Latest GA Gemini — most intelligent for agentic and coding work.',
      },
      {
        id: 'gemini-3.1-pro-preview',
        label: 'Gemini 3.1 Pro (Preview)',
        description: 'Advanced Gemini for the deepest reasoning. Preview — higher cost, lower limits.',
      },
    ],
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    shortLabel: 'OpenRouter',
    docsUrl: 'https://openrouter.ai/settings/keys',
    keyPlaceholder: 'sk-or-...',
    helperText: 'Use your OpenRouter API key.',
    defaultModel: 'anthropic/claude-sonnet-4.6',
    models: [
      {
        id: 'anthropic/claude-sonnet-4.6',
        label: 'Claude Sonnet 4.6',
        description: 'Balanced OpenRouter option for high-quality Daylens work.',
      },
      {
        id: 'openai/gpt-5.4-mini',
        label: 'GPT-5.4 mini',
        description: 'Faster OpenRouter option for lighter Daylens jobs.',
      },
    ],
  },
  'claude-cli': {
    id: 'claude-cli',
    label: 'Claude CLI',
    shortLabel: 'Claude CLI',
    docsUrl: 'https://docs.anthropic.com',
    keyPlaceholder: '',
    helperText: 'Uses the locally installed Claude CLI instead of an API key.',
    defaultModel: SHIPPING_DEFAULT_ANTHROPIC_MODEL,
    models: [
      {
        id: 'claude-opus-4-8',
        label: 'Claude Opus 4.8',
        description: 'Uses your local Claude CLI install and Anthropic account.',
      },
      {
        id: 'claude-sonnet-5',
        label: 'Claude Sonnet 5',
        description: 'Uses the latest Sonnet through the local Claude CLI.',
      },
      {
        id: 'claude-sonnet-4-6',
        label: 'Claude Sonnet 4.6',
        description: 'Balanced local Claude CLI option.',
      },
      {
        id: 'claude-haiku-4-5',
        label: 'Claude Haiku 4.5',
        description: 'Fastest current Claude option through the local Claude CLI.',
      },
    ],
  },
  'codex-cli': {
    id: 'codex-cli',
    label: 'Codex CLI',
    shortLabel: 'Codex CLI',
    docsUrl: 'https://platform.openai.com/docs',
    keyPlaceholder: '',
    helperText: 'Uses the locally installed Codex CLI instead of an API key.',
    defaultModel: 'gpt-5.5',
    models: [
      {
        id: 'gpt-5.5',
        label: 'GPT-5.5',
        description: 'Uses your local Codex CLI install and OpenAI account.',
      },
      {
        id: 'gpt-5.4-mini',
        label: 'GPT-5.4 mini',
        description: 'Faster local Codex CLI option.',
      },
    ],
  },
  'chatgpt-cli': {
    id: 'chatgpt-cli',
    label: 'ChatGPT CLI',
    shortLabel: 'ChatGPT CLI',
    docsUrl: 'https://help.openai.com/',
    keyPlaceholder: '',
    helperText: 'Uses the locally installed ChatGPT CLI instead of an API key.',
    defaultModel: 'gpt-5.5',
    models: [
      {
        id: 'gpt-5.5',
        label: 'GPT-5.5',
        description: 'Uses your local ChatGPT CLI install and OpenAI account.',
      },
      {
        id: 'gpt-5.4-mini',
        label: 'GPT-5.4 mini',
        description: 'Faster local ChatGPT CLI option.',
      },
    ],
  },
  'gemini-cli': {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    shortLabel: 'Gemini CLI',
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
    keyPlaceholder: '',
    helperText: 'Uses the locally installed Gemini CLI instead of an API key.',
    defaultModel: 'gemini-3.5-flash',
    models: [
      {
        id: 'gemini-3.5-flash',
        label: 'Gemini 3.5 Flash',
        description: 'Uses your local Gemini CLI install and Google account.',
      },
      {
        id: 'gemini-3.1-flash-lite',
        label: 'Gemini 3.1 Flash-Lite',
        description: 'Faster local Gemini CLI option.',
      },
    ],
  },
}

// FB8: per-model capability metadata for the Raycast-style model selector
// (speed/intelligence bars, context window, capability badges). Display hints
// for the picker card — BYOK still runs whatever model the id resolves to.
export interface AIModelCapabilities {
  speed: 1 | 2 | 3 | 4 | 5
  intelligence: 1 | 2 | 3 | 4 | 5
  contextTokens: number
  vision: boolean
  toolUse: boolean
  reasoning: boolean
}

// Keyed by model id (ids are shared across API + CLI variants, distinct on
// OpenRouter).
const AI_MODEL_CAPABILITIES: Record<string, AIModelCapabilities> = {
  'claude-opus-4-8': { speed: 3, intelligence: 5, contextTokens: 1_000_000, vision: true, toolUse: true, reasoning: true },
  'claude-sonnet-5': { speed: 4, intelligence: 5, contextTokens: 1_000_000, vision: true, toolUse: true, reasoning: true },
  'claude-sonnet-4-6': { speed: 4, intelligence: 4, contextTokens: 200_000, vision: true, toolUse: true, reasoning: true },
  'claude-haiku-4-5': { speed: 5, intelligence: 3, contextTokens: 200_000, vision: true, toolUse: true, reasoning: false },
  'gpt-5.5': { speed: 3, intelligence: 5, contextTokens: 400_000, vision: true, toolUse: true, reasoning: true },
  'gpt-5.4-mini': { speed: 4, intelligence: 4, contextTokens: 400_000, vision: true, toolUse: true, reasoning: true },
  'gpt-5.4-nano': { speed: 5, intelligence: 2, contextTokens: 400_000, vision: false, toolUse: true, reasoning: false },
  'gemini-3.1-flash-lite': { speed: 5, intelligence: 3, contextTokens: 1_000_000, vision: true, toolUse: true, reasoning: false },
  'gemini-3.5-flash': { speed: 4, intelligence: 4, contextTokens: 1_000_000, vision: true, toolUse: true, reasoning: true },
  'gemini-3.1-pro-preview': { speed: 2, intelligence: 5, contextTokens: 1_000_000, vision: true, toolUse: true, reasoning: true },
  'anthropic/claude-sonnet-4.6': { speed: 4, intelligence: 4, contextTokens: 200_000, vision: true, toolUse: true, reasoning: true },
  'openai/gpt-5.4-mini': { speed: 4, intelligence: 4, contextTokens: 400_000, vision: true, toolUse: true, reasoning: true },
}

export function modelCapabilities(modelId: string | null | undefined): AIModelCapabilities | null {
  if (!modelId) return null
  return AI_MODEL_CAPABILITIES[modelId] ?? null
}

// "150k words | 200k" — words estimated at ~0.75 words/token, tokens compacted.
export function contextWindowLabel(tokens: number): string {
  const words = Math.round((tokens * 0.75) / 1000)
  const tokenLabel = tokens >= 1_000_000
    ? `${Number((tokens / 1_000_000).toFixed(1)).toString()}M`
    : `${Math.round(tokens / 1000)}k`
  return `${words}k words | ${tokenLabel}`
}

export const AI_PROVIDERS: AIProvider[] = ['anthropic', 'openai', 'google', 'openrouter']

export function detectProviderFromApiKey(key: string): AIProvider | null {
  const trimmed = key.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('sk-ant-')) return 'anthropic'
  if (trimmed.startsWith('sk-or-')) return 'openrouter'
  if (trimmed.startsWith('AIza')) return 'google'
  if (trimmed.startsWith('sk-')) return 'openai'
  return null
}

export function getSelectedModel(settings: {
  aiProvider: AIProviderMode
  anthropicModel: string
  openaiModel: string
  googleModel: string
  openrouterModel: string
}): string {
  return accountModel(settings, settings.aiProvider)
}
