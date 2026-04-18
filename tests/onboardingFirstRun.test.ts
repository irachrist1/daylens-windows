import test from 'node:test'
import assert from 'node:assert/strict'
import type { AppSettings } from '../src/shared/types.ts'
import { nextMacStageAfterGrantedPermission } from '../src/shared/onboarding.ts'
import { createDefaultOnboardingState, shouldStartTrackingForSettings } from '../src/main/lib/onboardingState.ts'
import { validateProviderConnection } from '../src/main/services/providerValidation.ts'

function buildSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  const onboardingState = overrides.onboardingState ?? createDefaultOnboardingState(false)
  return {
    analyticsOptIn: false,
    launchOnLogin: true,
    theme: 'system',
    onboardingComplete: false,
    onboardingState,
    userName: '',
    userGoals: [],
    firstLaunchDate: 0,
    feedbackPromptShown: false,
    aiProvider: 'anthropic',
    anthropicModel: 'claude-opus-4-6',
    openaiModel: 'gpt-5.4',
    googleModel: 'gemini-3.1-flash-lite-preview',
    aiFallbackOrder: ['anthropic', 'openai', 'google'],
    aiModelStrategy: 'balanced',
    aiChatProvider: 'anthropic',
    aiBlockNamingProvider: 'google',
    aiSummaryProvider: 'anthropic',
    aiArtifactProvider: 'openai',
    aiBackgroundEnrichment: true,
    aiActiveBlockPreview: false,
    aiPromptCachingEnabled: true,
    aiSpendSoftLimitUsd: 10,
    aiRedactFilePaths: false,
    aiRedactEmails: false,
    dailySummaryEnabled: true,
    morningNudgeEnabled: true,
    distractionAlertThresholdMinutes: 10,
    ...overrides,
  }
}

test('new onboarding defaults to a welcome-first flow', () => {
  const state = createDefaultOnboardingState(false)
  assert.equal(state.flowVersion >= 2, true)
  assert.equal(state.stage, 'welcome')
  assert.equal(state.personalizationState, 'pending')
  assert.equal(state.aiSetupState, 'pending')
})

test('tracking startup stays blocked on mac until permission is granted', () => {
  const settings = buildSettings({
    onboardingState: {
      ...createDefaultOnboardingState(false),
      platform: 'macos',
      trackingPermissionState: 'missing',
    },
  })
  assert.equal(shouldStartTrackingForSettings(settings), false)
})

test('provider validation catches mismatched key formats before network work', async () => {
  const result = await validateProviderConnection('anthropic', 'sk-test-openai-key')
  assert.equal(result.status, 'unsupported_format')
  assert.equal(result.detectedProvider, 'openai')
  assert.equal(result.canSaveAnyway, false)
})

test('mac permission flow requires relaunch before proof when granted in-place', () => {
  const nextStage = nextMacStageAfterGrantedPermission({
    currentStage: 'permission',
    permissionRequestedAt: Date.now(),
    origin: 'refresh',
  })
  assert.equal(nextStage, 'relaunch_required')
})

test('mac relaunch returns to verification instead of looping back to restart', () => {
  const nextStage = nextMacStageAfterGrantedPermission({
    currentStage: 'relaunch_required',
    permissionRequestedAt: Date.now(),
    origin: 'startup',
  })
  assert.equal(nextStage, 'verifying_permission')
})

test('verification stage advances into proof after relaunch succeeds', () => {
  const nextStage = nextMacStageAfterGrantedPermission({
    currentStage: 'verifying_permission',
    permissionRequestedAt: Date.now(),
    origin: 'refresh',
  })
  assert.equal(nextStage, 'proof')
})
