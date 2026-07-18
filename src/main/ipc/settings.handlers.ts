import { app, ipcMain } from 'electron'
import { ANALYTICS_EVENT, sanitizeSettingsChangedKeys } from '@shared/analytics'
import {
  getSettingsAsync,
  setSettings,
  hasApiKey,
  setApiKey,
  clearApiKey,
} from '../services/settings'
import { capture } from '../services/analytics'
import { recordTrackingPauseTransition } from '../services/tracking'
import { syncLinuxLaunchOnLogin } from '../services/linuxDesktop'
import { validateProviderConnection } from '../services/providerValidation'
import { getMcpServerConfig, isMcpServerRunning, startMcpServer, stopMcpServer } from '../services/mcpServer'
import { detectFocusApps, discoverMcpServers } from '../services/enrichmentDiscovery'
import { IPC } from '@shared/types'
import type { AIProvider, AIProviderMode, AppSettings, EnrichmentSourcesState } from '@shared/types'
import { invalidateProjectionScope } from '../core/projections/invalidation'
import { getDb } from '../services/database'
import { resetProviderBreaker } from '../services/providerCircuitBreaker'
import { assertRealDayExternalAccessAllowed, isRealDayHarness } from '../lib/realDayHarness'

export function registerSettingsHandlers(): void {
  ipcMain.handle(IPC.SETTINGS.GET, async () => {
    return getSettingsAsync()
  })

  // Discovered optional enrichment sources: MCP servers
  // from the Claude Desktop config plus focus tools on this machine. Discovery
  // only — nothing is launched or called from here.
  ipcMain.handle(IPC.SETTINGS.GET_ENRICHMENT_SOURCES, async (): Promise<EnrichmentSourcesState> => {
    const settings = await getSettingsAsync()
    const enabled = settings.enrichmentSources ?? {}
    if (isRealDayHarness()) {
      return { mcpServers: [], focusApps: [] }
    }
    return {
      mcpServers: discoverMcpServers().map((server) => ({
        name: server.name,
        transport: server.transport,
        enabled: enabled[`mcp:${server.name}`] ?? false,
      })),
      focusApps: detectFocusApps().map((focus) => ({
        app: focus.app,
        installed: focus.installed,
        enabled: enabled[`focus:${focus.app}`] ?? false,
      })),
    }
  })

  ipcMain.handle(IPC.SETTINGS.SET, async (_e, partial: Partial<AppSettings>) => {
    const previous = await getSettingsAsync()
    const rawChangedKeys = Object.keys(partial).filter((key) => (
      JSON.stringify(previous[key as keyof AppSettings]) !== JSON.stringify(partial[key as keyof AppSettings])
    ))
    const changedKeys = sanitizeSettingsChangedKeys(rawChangedKeys)
    const trackingPauseChanged = 'trackingPaused' in partial
      && Boolean(previous.trackingPaused) !== Boolean(partial.trackingPaused)
    const trackingPauseAt = trackingPauseChanged ? Date.now() : null

    await setSettings(partial)

    if (trackingPauseAt !== null) {
      recordTrackingPauseTransition(Boolean(partial.trackingPaused), 'settings', trackingPauseAt)
    }

    if (!isRealDayHarness() && 'launchOnLogin' in partial && app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: Boolean(partial.launchOnLogin) })
      await syncLinuxLaunchOnLogin(Boolean(partial.launchOnLogin))
    }

    // Only reload Insights when an AI model/provider value actually changed —
    // not merely because the key was present in the saved partial (F42). Saving
    // unrelated settings no longer triggers a full Insights projection reload.
    const AI_INVALIDATING_KEYS = ['aiProvider', 'anthropicModel', 'openaiModel', 'googleModel', 'openrouterModel']
    if (rawChangedKeys.some((key) => AI_INVALIDATING_KEYS.includes(key))) {
      invalidateProjectionScope('insights', 'ai_settings_changed')
    }

    // Provider circuit breaker: picking a provider in Settings is the
    // user saying "try this one now" — never make them wait out a cooldown
    // that a background job tripped on a DIFFERENT provider selection, and
    // never make a fresh pick of the SAME provider wait either (they may
    // have just fixed billing on the provider's own dashboard).
    if (rawChangedKeys.includes('aiProvider') && partial.aiProvider) {
      resetProviderBreaker(getDb(), partial.aiProvider, 'provider_changed')
    }
    if (rawChangedKeys.includes('aiChatProvider') && partial.aiChatProvider) {
      resetProviderBreaker(getDb(), partial.aiChatProvider, 'provider_changed')
    }

    if (!isRealDayHarness() && 'mcpServerEnabled' in partial) {
      if (partial.mcpServerEnabled) {
        startMcpServer()
      } else {
        stopMcpServer()
      }
    } else if (!isRealDayHarness() && isMcpServerRunning()) {
      // The MCP subprocess reads the exclusion set from env at spawn time. If a
      // privacy-relevant setting changes while it's running, respawn it so the
      // new exclusions take effect immediately instead of at the next launch —
      // otherwise an MCP client could keep reading data the user just excluded.
      const PRIVACY_KEYS = ['trackingControlsEnabled', 'trackingExcludedApps', 'trackingExcludedSites', 'trackingPaused']
      if (rawChangedKeys.some((key) => PRIVACY_KEYS.includes(key))) {
        stopMcpServer()
        startMcpServer()
      }
    }

    if (changedKeys.length > 0) {
      capture(ANALYTICS_EVENT.SETTINGS_CHANGED, {
        settings_changed_keys: changedKeys,
        surface: 'settings',
        trigger: 'settings',
      })
    }
  })

  ipcMain.handle(IPC.SETTINGS.HAS_API_KEY, async (_e, provider?: AIProviderMode) => {
    const resolvedProvider = provider ?? (await getSettingsAsync()).aiProvider ?? 'anthropic'
    return hasApiKey(resolvedProvider)
  })

  ipcMain.handle(IPC.SETTINGS.SET_API_KEY, async (_e, key: string, provider?: AIProviderMode) => {
    assertRealDayExternalAccessAllowed('credential-store')
    const resolvedProvider = provider ?? (await getSettingsAsync()).aiProvider ?? 'anthropic'
    if (key.trim()) {
      await setApiKey(resolvedProvider, key.trim())
    } else {
      await clearApiKey(resolvedProvider)
    }
    invalidateProjectionScope('insights', 'ai_credentials_changed')
    // A re-pasted key is the user saying "this should work now" — give it a
    // clean slate instead of a leftover cooldown from the old key.
    resetProviderBreaker(getDb(), resolvedProvider, 'key_changed')
  })

  ipcMain.handle(IPC.SETTINGS.CLEAR_API_KEY, async (_e, provider?: AIProviderMode) => {
    assertRealDayExternalAccessAllowed('credential-store')
    const resolvedProvider = provider ?? (await getSettingsAsync()).aiProvider ?? 'anthropic'
    await clearApiKey(resolvedProvider)
    invalidateProjectionScope('insights', 'ai_credentials_changed')
    resetProviderBreaker(getDb(), resolvedProvider, 'key_changed')
  })

  ipcMain.handle(IPC.SETTINGS.VALIDATE_API_KEY, async (_e, payload: { provider: AIProvider; key: string }) => {
    return validateProviderConnection(payload.provider, payload.key)
  })

  ipcMain.handle(IPC.MCP.GET_CONFIG, () => getMcpServerConfig())
}
