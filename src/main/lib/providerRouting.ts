import type { AIProviderMode, AppSettings } from '@shared/types'

// Invariant #12: every AI surface runs on the provider the user picked in
// Settings (`aiProvider`). The single exception is the AI chat tab, where the
// user may explicitly pick a different provider for that one conversation
// (`aiChatProvider`). That override is visible and user-initiated — never a
// silent background swap. Block naming, summaries, reports, briefs and wraps
// all follow `aiProvider`. This pure helper is the one place that rule lives,
// kept free of electron imports so it can be unit-tested directly.
export function selectJobProvider(
  usesChatOverride: boolean,
  settings: Pick<AppSettings, 'aiProvider' | 'aiChatProvider'>,
): AIProviderMode {
  if (usesChatOverride) {
    return settings.aiChatProvider ?? settings.aiProvider ?? 'anthropic'
  }
  return settings.aiProvider ?? 'anthropic'
}

/** The settings write to actually persist, given what is being changed.
 *
 *  Changing the provider retires a chat pin set earlier, unless the same write
 *  states a new one. The chat picker only offers API providers, so a pin left
 *  behind after switching to a CLI provider is unreachable from the chat UI:
 *  Settings would say Claude CLI while chat kept billing the old account. */
export function applyProviderChangeToSettings(
  previous: Pick<AppSettings, 'aiProvider' | 'aiChatProvider'>,
  partial: Partial<AppSettings>,
): Partial<AppSettings> {
  const providerChanged = partial.aiProvider != null && partial.aiProvider !== previous.aiProvider
  const statesItsOwnPin = partial.aiChatProvider != null
  if (!providerChanged || statesItsOwnPin || previous.aiChatProvider === undefined) return partial
  return { ...partial, aiChatProvider: undefined }
}
