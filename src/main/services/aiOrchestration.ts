import { randomUUID } from 'node:crypto'
import { finishAIUsageEvent, startAIUsageEvent } from '../db/queries'
import { getDb } from './database'
import { capture } from './analytics'
import { getApiKey, getSettings, getSettingsAsync } from './settings'
import type {
  AIInvocationSource,
  AIJobType,
  AIModelStrategy,
  AIProviderMode,
  AISurface,
  AppSettings,
} from '@shared/types'

export interface ResolvedProviderConfig {
  provider: AIProviderMode
  apiKey: string | null
  model: string
}

export interface AIProviderUsage {
  inputTokens?: number | null
  outputTokens?: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
}

export interface ProviderTextResponse {
  text: string
  usage?: AIProviderUsage | null
}

interface AIJobDefinition {
  jobType: AIJobType
  screen: AISurface
  foreground: boolean
  timeoutMs: number
  providerPreferenceKey: 'aiChatProvider' | 'aiBlockNamingProvider' | 'aiSummaryProvider' | 'aiArtifactProvider'
  cachePolicy: 'off' | 'stable_prefix' | 'repeated_payload'
  modelStrategy: Extract<AIModelStrategy, 'balanced' | 'quality' | 'economy'>
}

const JOB_DEFINITIONS: Record<AIJobType, AIJobDefinition> = {
  block_label_preview: {
    jobType: 'block_label_preview',
    screen: 'timeline_day',
    foreground: false,
    timeoutMs: 8_000,
    providerPreferenceKey: 'aiBlockNamingProvider',
    cachePolicy: 'off',
    modelStrategy: 'economy',
  },
  block_label_finalize: {
    jobType: 'block_label_finalize',
    screen: 'timeline_day',
    foreground: false,
    timeoutMs: 12_000,
    providerPreferenceKey: 'aiBlockNamingProvider',
    cachePolicy: 'stable_prefix',
    modelStrategy: 'economy',
  },
  block_cleanup_relabel: {
    jobType: 'block_cleanup_relabel',
    screen: 'background',
    foreground: false,
    timeoutMs: 15_000,
    providerPreferenceKey: 'aiBlockNamingProvider',
    cachePolicy: 'stable_prefix',
    modelStrategy: 'balanced',
  },
  day_summary: {
    jobType: 'day_summary',
    screen: 'timeline_day',
    foreground: true,
    timeoutMs: 15_000,
    providerPreferenceKey: 'aiSummaryProvider',
    cachePolicy: 'repeated_payload',
    modelStrategy: 'balanced',
  },
  week_review: {
    jobType: 'week_review',
    screen: 'timeline_week',
    foreground: true,
    timeoutMs: 18_000,
    providerPreferenceKey: 'aiSummaryProvider',
    cachePolicy: 'repeated_payload',
    modelStrategy: 'balanced',
  },
  app_narrative: {
    jobType: 'app_narrative',
    screen: 'app_detail',
    foreground: true,
    timeoutMs: 15_000,
    providerPreferenceKey: 'aiSummaryProvider',
    cachePolicy: 'repeated_payload',
    modelStrategy: 'balanced',
  },
  chat_answer: {
    jobType: 'chat_answer',
    screen: 'ai_chat',
    foreground: true,
    timeoutMs: 30_000,
    providerPreferenceKey: 'aiChatProvider',
    cachePolicy: 'stable_prefix',
    modelStrategy: 'quality',
  },
  report_generation: {
    jobType: 'report_generation',
    screen: 'ai_chat',
    foreground: true,
    timeoutMs: 45_000,
    providerPreferenceKey: 'aiArtifactProvider',
    cachePolicy: 'repeated_payload',
    modelStrategy: 'quality',
  },
  attribution_assist: {
    jobType: 'attribution_assist',
    screen: 'background',
    foreground: false,
    timeoutMs: 15_000,
    providerPreferenceKey: 'aiSummaryProvider',
    cachePolicy: 'stable_prefix',
    modelStrategy: 'balanced',
  },
}

function providerUsesCLI(provider: AIProviderMode): provider is 'claude-cli' | 'codex-cli' {
  return provider === 'claude-cli' || provider === 'codex-cli'
}

function orderedUnique<T>(values: readonly T[]): T[] {
  return values.filter((value, index) => values.indexOf(value) === index)
}

export function modelForProvider(provider: AIProviderMode, settings = getSettings()): string {
  switch (provider) {
    case 'openai':
    case 'codex-cli':
      return settings.openaiModel || 'gpt-5.4'
    case 'google':
      return settings.googleModel || 'gemini-3.1-flash-lite-preview'
    case 'claude-cli':
    case 'anthropic':
    default:
      return settings.anthropicModel || 'claude-opus-4-6'
  }
}

export function providerLabel(provider: AIProviderMode): string {
  switch (provider) {
    case 'openai':
      return 'OpenAI'
    case 'google':
      return 'Google Gemini'
    case 'claude-cli':
      return 'Claude CLI'
    case 'codex-cli':
      return 'Codex CLI'
    case 'anthropic':
    default:
      return 'Anthropic Claude'
  }
}

function fallbackProviders(settings: AppSettings): AIProviderMode[] {
  return orderedUnique((settings.aiFallbackOrder?.length
    ? settings.aiFallbackOrder
    : ['anthropic', 'openai', 'google']) as AIProviderMode[])
}

function preferredProviderForJob(jobType: AIJobType, settings: AppSettings): AIProviderMode {
  const job = JOB_DEFINITIONS[jobType]
  return settings[job.providerPreferenceKey]
    ?? settings.aiProvider
    ?? 'anthropic'
}

function applyStrategyProviderFallback(
  preferred: AIProviderMode,
  settings: AppSettings,
): AIProviderMode[] {
  if (providerUsesCLI(preferred)) {
    return [preferred]
  }
  return orderedUnique([preferred, ...fallbackProviders(settings)])
}

function isQuotaOrAuthError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const maybeError = error as { status?: number; code?: string; type?: string; message?: string; error?: { code?: string | number; status?: string; type?: string } }
  return maybeError.status === 401
    || maybeError.status === 403
    || maybeError.status === 429
    || maybeError.status === 400
    || maybeError.code === 'insufficient_quota'
    || maybeError.type === 'insufficient_quota'
    || maybeError.error?.code === 'insufficient_quota'
    || maybeError.error?.code === 429
    || maybeError.error?.status === 'RESOURCE_EXHAUSTED'
    || maybeError.error?.type === 'credit_balance_too_low'
    || (typeof maybeError.message === 'string' && maybeError.message.toLowerCase().includes('credit balance'))
}

function friendlyProviderError(error: unknown, label: string): Error {
  if (!error || typeof error !== 'object') {
    return new Error(`${label} request failed. Please try again.`)
  }
  const maybeError = error as { status?: number; message?: string; error?: { code?: number; status?: string; type?: string } }
  if (
    maybeError.error?.type === 'credit_balance_too_low'
    || (maybeError.status === 400 && typeof maybeError.message === 'string' && maybeError.message.toLowerCase().includes('credit balance'))
  ) {
    return new Error(`${label} credit balance is too low. Top up that provider or change the routing in Settings.`)
  }
  if ((maybeError.status ?? maybeError.error?.code) === 429 || maybeError.error?.status === 'RESOURCE_EXHAUSTED') {
    return new Error(`${label} quota exceeded. Change providers, lower cost settings, or try again later.`)
  }
  if ((maybeError.status ?? maybeError.error?.code) === 401 || (maybeError.status ?? maybeError.error?.code) === 403) {
    return new Error(`${label} rejected the configured credentials. Check the key or switch providers in Settings.`)
  }
  return new Error(`${label} request failed. Please try again.`)
}

export function promptCachingPolicyForJob(jobType: AIJobType): AIJobDefinition['cachePolicy'] {
  return JOB_DEFINITIONS[jobType].cachePolicy
}

function redactAIText(input: string, settings: AppSettings): string {
  let output = input
  if (settings.aiRedactEmails) {
    output = output.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
  }
  if (settings.aiRedactFilePaths) {
    output = output
      .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, '[redacted-path]')
      .replace(/(?:^|[\s(])\/(?:Users|home|tmp|var|private|mnt)\/[^\s)]+/g, (match) => match[0] === '/' ? '[redacted-path]' : `${match[0]}[redacted-path]`)
  }
  return output
}

async function resolveProviderConfigsForJob(jobType: AIJobType, settings: AppSettings): Promise<ResolvedProviderConfig[]> {
  const orderedProviders = applyStrategyProviderFallback(preferredProviderForJob(jobType, settings), settings)
  const configs: ResolvedProviderConfig[] = []

  for (const provider of orderedProviders) {
    const apiKey = await getApiKey(provider)
    if (!providerUsesCLI(provider) && !apiKey) continue

    configs.push({
      provider,
      apiKey,
      model: modelForProvider(provider, settings),
    })
  }

  if (configs.length === 0) {
    throw new Error('No AI provider is configured for this job. Check AI Settings.')
  }

  return configs
}

export async function executeTextAIJob(
  payload: {
    jobType: AIJobType
    screen?: AISurface
    triggerSource: AIInvocationSource
    systemPrompt: string
    userMessage: string
    prior?: Array<{ role: 'user' | 'assistant'; content: string }>
  },
  runner: (
    config: ResolvedProviderConfig,
    systemPrompt: string,
    prior: Array<{ role: 'user' | 'assistant'; content: string }>,
    userMessage: string,
  ) => Promise<ProviderTextResponse>,
): Promise<{ text: string; config: ResolvedProviderConfig; usage: AIProviderUsage | null; cachePolicy: AIJobDefinition['cachePolicy'] }> {
  const settings = await getSettingsAsync()
  const definition = JOB_DEFINITIONS[payload.jobType]
  const eventId = randomUUID()
  const startedAt = Date.now()
  const prior = payload.prior ?? []
  const systemPrompt = redactAIText(payload.systemPrompt, settings)
  const userMessage = redactAIText(payload.userMessage, settings)
  const sanitizedPrior = prior.map((message) => ({
    role: message.role,
    content: redactAIText(message.content, settings),
  }))
  const configs = await resolveProviderConfigsForJob(payload.jobType, settings)

  startAIUsageEvent(getDb(), {
    id: eventId,
    jobType: payload.jobType,
    screen: payload.screen ?? definition.screen,
    triggerSource: payload.triggerSource,
    provider: configs[0]?.provider ?? null,
    model: configs[0]?.model ?? null,
    startedAt,
  })

  let lastError: unknown = null
  let lastConfig: ResolvedProviderConfig | null = null

  for (const config of configs) {
    try {
      const response = await runner(config, systemPrompt, sanitizedPrior, userMessage)
      const completedAt = Date.now()
      const usage = response.usage ?? null
      const cacheHit = Boolean((usage?.cacheReadTokens ?? 0) > 0)

      finishAIUsageEvent(getDb(), {
        id: eventId,
        provider: config.provider,
        model: config.model,
        success: true,
        completedAt,
        latencyMs: completedAt - startedAt,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        cacheReadTokens: usage?.cacheReadTokens ?? null,
        cacheWriteTokens: usage?.cacheWriteTokens ?? null,
        cacheHit,
      })
      capture('ai_job_completed', {
        job_type: payload.jobType,
        screen: payload.screen ?? definition.screen,
        provider: config.provider,
        model: config.model,
        trigger_source: payload.triggerSource,
        latency_ms: completedAt - startedAt,
        input_tokens: usage?.inputTokens ?? null,
        output_tokens: usage?.outputTokens ?? null,
        cache_hit: cacheHit,
        cache_policy: definition.cachePolicy,
      })

      return {
        text: response.text,
        config,
        usage,
        cachePolicy: definition.cachePolicy,
      }
    } catch (error) {
      lastError = error
      lastConfig = config
      if (!isQuotaOrAuthError(error)) {
        break
      }
    }
  }

  const completedAt = Date.now()
  const friendlyError = friendlyProviderError(lastError, providerLabel(lastConfig?.provider ?? configs[0]?.provider ?? 'anthropic'))

  finishAIUsageEvent(getDb(), {
    id: eventId,
    provider: lastConfig?.provider ?? null,
    model: lastConfig?.model ?? null,
    success: false,
    failureReason: friendlyError.message,
    completedAt,
    latencyMs: completedAt - startedAt,
  })
  capture('ai_job_failed', {
    job_type: payload.jobType,
    screen: payload.screen ?? definition.screen,
    provider: lastConfig?.provider ?? null,
    model: lastConfig?.model ?? null,
    trigger_source: payload.triggerSource,
    latency_ms: completedAt - startedAt,
    failure_reason: friendlyError.message,
    cache_policy: definition.cachePolicy,
  })

  throw friendlyError
}
