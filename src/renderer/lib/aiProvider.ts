import type { AIProvider } from '@shared/types'

export interface AIModelOption {
  id: string
  label: string
  description: string
}

export interface AIProviderMeta {
  id: AIProvider
  label: string
  shortLabel: string
  docsUrl: string
  keyPlaceholder: string
  helperText: string
  defaultModel: string
  models: AIModelOption[]
}

export const AI_PROVIDER_META: Record<AIProvider, AIProviderMeta> = {
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
  aiProvider: AIProvider
  anthropicModel: string
  openaiModel: string
  googleModel: string
}): string {
  switch (settings.aiProvider) {
    case 'openai':
      return settings.openaiModel
    case 'google':
      return settings.googleModel
    case 'anthropic':
    default:
      return settings.anthropicModel
  }
}
