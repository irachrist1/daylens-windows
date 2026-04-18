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

function hasCacheControl(block: AnthropicTextBlock | undefined): boolean {
  return block?.cache_control?.type === 'ephemeral'
}

function containsCacheControl(content: string | AnthropicTextBlock[]): boolean {
  return Array.isArray(content) && content.some((block) => hasCacheControl(block))
}

function assertPromptCachingShape(
  payload: AnthropicPromptInput,
  prior: AnthropicConversationMessage[],
  options?: AITextJobExecutionOptions,
): void {
  const cachingEnabled = Boolean(options?.promptCachingEnabled && options.cachePolicy !== 'off')
  const finalMessage = payload.messages[payload.messages.length - 1]

  if (!cachingEnabled) {
    if (payload.cache_control) {
      throw new Error('Anthropic prompt caching shape invalid: top-level cache_control should be absent when caching is disabled.')
    }
    if (Array.isArray(payload.system) && payload.system.some((block) => hasCacheControl(block))) {
      throw new Error('Anthropic prompt caching shape invalid: system blocks should not carry cache_control when caching is disabled.')
    }
    if (payload.messages.some((message) => containsCacheControl(message.content))) {
      throw new Error('Anthropic prompt caching shape invalid: messages should not carry cache_control when caching is disabled.')
    }
    return
  }

  if (options?.cachePolicy === 'stable_prefix') {
    if (!Array.isArray(payload.system) || payload.system.length !== 1 || !hasCacheControl(payload.system[0])) {
      throw new Error('Anthropic stable_prefix caching requires an explicit system breakpoint.')
    }
    const expectsAutomaticCaching = prior.length > 0
    if (Boolean(payload.cache_control) !== expectsAutomaticCaching) {
      throw new Error('Anthropic stable_prefix caching should use top-level automatic caching only for multi-turn requests.')
    }
    if (payload.messages.some((message) => containsCacheControl(message.content))) {
      throw new Error('Anthropic stable_prefix caching should not add message-level cache_control markers.')
    }
    if (!finalMessage || finalMessage.role !== 'user' || Array.isArray(finalMessage.content)) {
      throw new Error('Anthropic stable_prefix caching should leave the newest user turn as plain message content.')
    }
    return
  }

  if (options?.cachePolicy === 'repeated_payload') {
    if (payload.cache_control) {
      throw new Error('Anthropic repeated_payload caching should not add top-level automatic caching.')
    }
    if (Array.isArray(payload.system)) {
      throw new Error('Anthropic repeated_payload caching should leave the system prompt unwrapped.')
    }
    if (payload.messages.slice(0, -1).some((message) => containsCacheControl(message.content))) {
      throw new Error('Anthropic repeated_payload caching should keep prior turns unmarked.')
    }
    if (
      !finalMessage
      || finalMessage.role !== 'user'
      || !Array.isArray(finalMessage.content)
      || finalMessage.content.length !== 1
      || !hasCacheControl(finalMessage.content[0])
    ) {
      throw new Error('Anthropic repeated_payload caching should mark only the final user payload.')
    }
  }
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

  const payload: AnthropicPromptInput = {
    cache_control: useAutomaticCacheBreakpoint ? cacheControl ?? undefined : undefined,
    system: systemPromptForOptions(systemPrompt, cacheControl, options),
    messages,
  }

  assertPromptCachingShape(payload, prior, options)
  return payload
}
