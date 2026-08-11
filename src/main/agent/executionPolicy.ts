// Chat-side execution-policy choke point (WO-74 / REQ-AIA-RT-002).
//
// Background AI already enters provider work through executeTextAIJob, which
// applies rate limits, spend guardrails, quota cooldowns, usage retention, and
// prompt-cache policy. Chat historically counted provider calls but did not
// wait on the shared rate-limit bucket, and never applied the job definition's
// stable_prefix cache policy through the AI SDK.
//
// This module is the owned-lane adapter: it reuses the existing rate-limiter
// and job cache-policy vocabulary without editing those unowned services, and
// shapes Anthropic prompt-cache markers in the AI SDK message form so the
// Context packet and answer contract stay unchanged.
import type { SystemModelMessage } from '@ai-sdk/provider-utils'
import type { AIProviderMode } from '@shared/types'
import {
  withProviderRateLimit,
  type ProviderRateLimitOptions,
} from '../services/aiRateLimiter'

/** Same vocabulary as JOB_DEFINITIONS / AITextJobExecutionOptions.cachePolicy. */
export type ChatCachePolicy = 'off' | 'stable_prefix' | 'repeated_payload'

export type ChatSystemPrompt = string | SystemModelMessage | Array<SystemModelMessage>

export interface ChatExecutionPolicy {
  provider: AIProviderMode
  cachePolicy: ChatCachePolicy
  promptCachingEnabled: boolean
  /** Rate-limiter log label; defaults to chat_answer. */
  label?: string
}

/**
 * Gate one chat provider stream/turn behind the shared per-provider rate
 * limiter. The limiter records the call and retries transient 429s; spend and
 * quota controls for background AI stay on executeTextAIJob.
 *
 * Accepts a sync or async starter so streamText() (sync result, async
 * iteration) can pass through without wrapping the whole token stream.
 */
export async function withChatProviderExecution<T>(
  provider: AIProviderMode,
  fn: () => T | Promise<T>,
  options: ProviderRateLimitOptions = {},
): Promise<T> {
  return withProviderRateLimit(provider, async () => await fn(), {
    label: options.label ?? 'chat_answer',
    maxAttempts: options.maxAttempts,
  })
}

/**
 * Apply the selected prompt-cache policy to the stable system prefix without
 * altering the Context packet or the answer contract. Only Anthropic honors
 * the AI SDK cacheControl marker today; other providers keep a plain string.
 */
export function applyChatPromptCacheToSystem(
  stableSystem: string,
  dynamicSystem: string | null | undefined,
  policy: Pick<ChatExecutionPolicy, 'provider' | 'cachePolicy' | 'promptCachingEnabled'>,
): ChatSystemPrompt {
  const dynamic = dynamicSystem?.trim() ? dynamicSystem.trim() : null
  const useAnthropicCache = policy.provider === 'anthropic'
    && policy.promptCachingEnabled
    && policy.cachePolicy === 'stable_prefix'
    && stableSystem.length > 0

  if (!useAnthropicCache) {
    return dynamic ? `${stableSystem}\n\n${dynamic}` : stableSystem
  }

  const messages: SystemModelMessage[] = [{
    role: 'system',
    content: stableSystem,
    providerOptions: {
      anthropic: { cacheControl: { type: 'ephemeral' } },
    },
  }]
  if (dynamic) {
    messages.push({ role: 'system', content: dynamic })
  }
  return messages
}
