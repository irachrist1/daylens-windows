import type { AITextJobExecutionOptions } from './aiOrchestration'

export type AnthropicConversationMessage = {
  role: 'user' | 'assistant'
  content: string
}

type AnthropicCacheControl = {
  type: 'ephemeral'
}

type AnthropicTextBlock = {
  type: 'text'
  text: string
  cache_control?: AnthropicCacheControl
}

export type AnthropicPromptInput = {
  system: string | AnthropicTextBlock[]
  messages: Array<{
    role: 'user' | 'assistant'
    content: string | AnthropicTextBlock[]
  }>
  cache_control?: AnthropicCacheControl
}

function cacheControlForOptions(options?: AITextJobExecutionOptions): AnthropicCacheControl | null {
  if (!options?.promptCachingEnabled) return null
  if (options.cachePolicy === 'off') return null
  return { type: 'ephemeral' }
}

function shouldUseAutomaticCacheBreakpoint(
  prior: AnthropicConversationMessage[],
  options?: AITextJobExecutionOptions,
): boolean {
  return Boolean(
    options?.promptCachingEnabled
    && options.cachePolicy === 'stable_prefix'
    && prior.length > 0,
  )
}

function systemPromptForOptions(
  systemPrompt: string,
  cacheControl: AnthropicCacheControl | null,
  options?: AITextJobExecutionOptions,
): string | AnthropicTextBlock[] {
  if (!cacheControl || options?.cachePolicy !== 'stable_prefix') return systemPrompt
  return [{ type: 'text', text: systemPrompt, cache_control: cacheControl }]
}

// Daylens uses two Anthropic prompt-caching shapes:
// - stable_prefix:
//   - all jobs keep the reusable system prompt on an explicit breakpoint
//   - multi-turn jobs also use Anthropic's top-level automatic breakpoint so
//     the reusable conversation prefix can advance between turns
// - repeated_payload: cache the full request by marking the final user payload
export function buildAnthropicPromptInput(
  systemPrompt: string,
  prior: AnthropicConversationMessage[],
  userMessage: string,
  options?: AITextJobExecutionOptions,
): AnthropicPromptInput {
  const cacheControl = cacheControlForOptions(options)
  const useAutomaticCacheBreakpoint = shouldUseAutomaticCacheBreakpoint(prior, options)
  const messages: AnthropicPromptInput['messages'] = prior.map((message) => ({
    role: message.role,
    content: message.content,
  }))

  if (cacheControl && options?.cachePolicy === 'repeated_payload') {
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: userMessage, cache_control: cacheControl }],
    })
  } else {
    messages.push({ role: 'user', content: userMessage })
  }

  return {
    cache_control: useAutomaticCacheBreakpoint ? cacheControl ?? undefined : undefined,
    system: systemPromptForOptions(systemPrompt, cacheControl, options),
    messages,
  }
}
