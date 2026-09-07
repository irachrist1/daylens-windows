import { accountProvider, chatProvider } from '@shared/aiProviderState'
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
  return usesChatOverride ? chatProvider(settings) : accountProvider(settings)
}

/** The settings write to actually persist, given what is being changed.
 *
 *  Changing the provider retires a chat pin set earlier, unless the same write
 *  states a new one. A leftover pin after a Settings switch is how Settings
 *  can say Claude CLI while chat keeps calling the previous account. */
export function applyProviderChangeToSettings(
  previous: Pick<AppSettings, 'aiProvider' | 'aiChatProvider'>,
  partial: Partial<AppSettings>,
): Partial<AppSettings> {
  const providerChanged = partial.aiProvider != null && partial.aiProvider !== previous.aiProvider
  const statesItsOwnPin = partial.aiChatProvider != null
  const clearsPin = partial.aiChatProvider === null || partial.aiChatProvider === undefined
  if (providerChanged && !statesItsOwnPin && previous.aiChatProvider !== undefined) {
    return { ...partial, aiChatProvider: undefined }
  }
  if ('aiChatProvider' in partial && clearsPin) {
    return { ...partial, aiChatProvider: undefined }
  }
  return partial
}
