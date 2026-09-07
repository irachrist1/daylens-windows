// Provider sources for the model picker (DEV-201).
//
// The picker renders SOURCES, not a hardcoded provider list. A source is one
// way a model can be served, with honest availability and a cost basis:
//
//   managed       — Daylens pays the provider from the plan's credit allowance
//   byok          — the person's own API key; every question is metered in USD
//   subscription  — the person's own provider subscription through a detected
//                   local CLI; Daylens meters nothing
//
// This is the seam a bring-your-own-subscription provider (issue #5 — a
// Claude Code or ChatGPT/Codex subscription used directly, without the CLI
// hop) slots into: add a descriptor here with kind 'subscription' and a
// runtime adapter behind the existing provider contract, and the picker
// renders it with the right cost semantics without any picker changes. Per
// agent-runtime-and-context.md §Runtime contract, such an adapter is exposed
// only when the provider explicitly permits that use — the descriptor gate
// (`available`) is where that check surfaces to the person.

import {
  CLI_NOT_INSTALLED_REASON,
  isCliProvider,
  subscriptionSourceAvailability,
  type CLIProvider,
} from './aiProviderState'
import type { AIProviderMode, BillingAccessSnapshot } from './types'

export type AIModelSourceKind = 'managed' | 'byok' | 'subscription'

export type AIModelSourceCostBasis = 'allowance_usd' | 'metered_usd' | 'subscription_included'

export interface AIModelSource {
  /** Stable id: 'managed', 'byok:<provider>', 'subscription:<provider>'. */
  id: string
  kind: AIModelSourceKind
  /** Null for the managed source — Daylens routes it server-side. */
  provider: AIProviderMode | null
  label: string
  /** True only when this source can actually serve a turn right now. */
  available: boolean
  /** Plain-language reason when it cannot — never a silent absence. */
  unavailableReason: string | null
  costBasis: AIModelSourceCostBasis
}

interface SourceDef {
  provider: AIProviderMode
  kind: Extract<AIModelSourceKind, 'byok' | 'subscription'>
  label: string
  unavailableReason: string
}

// Order is display order: keys first (the common case), then CLI
// subscriptions. Managed is prepended when the build has a billing service.
const SOURCE_DEFS: SourceDef[] = [
  { provider: 'anthropic', kind: 'byok', label: 'Anthropic — your API key', unavailableReason: 'No Anthropic API key saved. Add one in Settings → AI.' },
  { provider: 'openai', kind: 'byok', label: 'OpenAI — your API key', unavailableReason: 'No OpenAI API key saved. Add one in Settings → AI.' },
  { provider: 'google', kind: 'byok', label: 'Google — your API key', unavailableReason: 'No Google AI Studio key saved. Add one in Settings → AI.' },
  { provider: 'openrouter', kind: 'byok', label: 'OpenRouter — your API key', unavailableReason: 'No OpenRouter API key saved. Add one in Settings → AI.' },
  { provider: 'claude-cli', kind: 'subscription', label: 'Claude CLI — your subscription', unavailableReason: CLI_NOT_INSTALLED_REASON['claude-cli'] },
  { provider: 'chatgpt-cli', kind: 'subscription', label: 'ChatGPT CLI — your subscription', unavailableReason: CLI_NOT_INSTALLED_REASON['chatgpt-cli'] },
  { provider: 'codex-cli', kind: 'subscription', label: 'Codex CLI — your subscription', unavailableReason: CLI_NOT_INSTALLED_REASON['codex-cli'] },
  { provider: 'gemini-cli', kind: 'subscription', label: 'Gemini CLI — your subscription', unavailableReason: CLI_NOT_INSTALLED_REASON['gemini-cli'] },
]

export function buildModelSources(input: {
  /** Per-provider key/CLI availability, as probed by the renderer. */
  providerAvailability: Partial<Record<AIProviderMode, boolean>>
  /** The validated billing snapshot; null when unknown. */
  billing: Pick<BillingAccessSnapshot, 'mode' | 'canUseAI' | 'message'> | null
  /** Chat hides CLIs that cannot drive the agent loop; Settings lists every CLI. */
  purpose?: 'chat' | 'all'
}): AIModelSource[] {
  const sources: AIModelSource[] = []

  // Managed source: shown whenever this build HAS a billing service, even when
  // the allowance is used up — an exhausted allowance must say why it is
  // unavailable, not vanish (ai-agent.md §Managed access).
  if (input.billing && input.billing.mode !== 'unavailable') {
    sources.push({
      id: 'managed',
      kind: 'managed',
      provider: null,
      label: 'Daylens managed AI',
      available: input.billing.canUseAI,
      unavailableReason: input.billing.canUseAI ? null : input.billing.message,
      costBasis: 'allowance_usd',
    })
  }

  const purpose = input.purpose ?? 'all'
  for (const def of SOURCE_DEFS) {
    const installed = input.providerAvailability[def.provider] ?? false
    const subscription = def.kind === 'subscription' && isCliProvider(def.provider)
      ? subscriptionSourceAvailability({
          provider: def.provider as CLIProvider,
          installed,
          purpose,
        })
      : { available: installed, unavailableReason: installed ? null : def.unavailableReason }
    sources.push({
      id: `${def.kind}:${def.provider}`,
      kind: def.kind,
      provider: def.provider,
      label: def.label,
      available: subscription.available,
      unavailableReason: subscription.unavailableReason,
      costBasis: def.kind === 'byok' ? 'metered_usd' : 'subscription_included',
    })
  }

  return sources
}
