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

export const AI_PROVIDER_META: Record<AIProviderMode, AIProviderMeta> = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    shortLabel: 'Claude',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    keyPlaceholder: 'sk-ant-…',
    helperText: 'Use your Claude API key.',
    defaultModel: 'claude-opus-4-6',
    models: [
      {
        id: 'claude-opus-4-6',
        label: 'Claude Opus 4.6',
        description: 'Latest flagship for the hardest coding and reasoning work.',
      },
      {
        id: 'claude-sonnet-4-6',
        label: 'Claude Sonnet 4.6',
        description: 'Latest balanced Claude for speed plus high quality.',
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
    defaultModel: 'gpt-5.4',
    models: [
      {
        id: 'gpt-5.4',
        label: 'GPT-5.4',
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
    defaultModel: 'gemini-3.1-flash-lite-preview',
    models: [
      {
        id: 'gemini-3.1-pro-preview',
        label: 'Gemini 3.1 Pro Preview',
        description: 'Latest advanced Gemini model for deep reasoning and coding.',
      },
      {
        id: 'gemini-3-flash-preview',
        label: 'Gemini 3 Flash Preview',
        description: 'Latest fast frontier Gemini model with strong multimodal and tool support.',
      },
      {
        id: 'gemini-3.1-flash-lite-preview',
        label: 'Gemini 3.1 Flash-Lite Preview',
        description: 'Newest lower-cost Gemini option for fast straightforward tasks. This is the safest Daylens default right now.',
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
    defaultModel: 'claude-opus-4-6',
    models: [
      {
        id: 'claude-opus-4-6',
        label: 'Claude Opus 4.6',
        description: 'Uses your local Claude CLI install and Anthropic account.',
      },
      {
        id: 'claude-sonnet-4-6',
        label: 'Claude Sonnet 4.6',
        description: 'Balanced local Claude CLI option.',
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
    defaultModel: 'gpt-5.4',
    models: [
      {
        id: 'gpt-5.4',
        label: 'GPT-5.4',
        description: 'Uses your local Codex CLI install and OpenAI account.',
      },
      {
        id: 'gpt-5.4-mini',
        label: 'GPT-5.4 mini',
        description: 'Faster local Codex CLI option.',
      },
    ],
  },
}

export const AI_PROVIDERS: AIProvider[] = ['anthropic', 'openai', 'google']

export function detectProviderFromApiKey(key: string): AIProvider | null {
  const trimmed = key.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('sk-ant-')) return 'anthropic'
  if (trimmed.startsWith('AIza')) return 'google'
  if (trimmed.startsWith('sk-')) return 'openai'
  return null
}

export function getSelectedModel(settings: {
  aiProvider: AIProviderMode
  anthropicModel: string
  openaiModel: string
  googleModel: string
}): string {
  switch (settings.aiProvider) {
    case 'openai':
    case 'codex-cli':
      return settings.openaiModel
    case 'google':
      return settings.googleModel
    case 'claude-cli':
      return settings.anthropicModel
    case 'anthropic':
    default:
      return settings.anthropicModel
  }
}
