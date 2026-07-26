import { randomUUID } from 'node:crypto'
import { countBackgroundAIUsageEventsSince, finishAIUsageEvent, startAIUsageEvent } from '../db/queries'
import { getDb } from './database'
import { capture, captureAIGeneration } from './analytics'
import { estimateUsageCostUsd } from './modelPricing'
import { ANALYTICS_EVENT, classifyFailureKind } from '@shared/analytics'
import { getApiKey, getSettings, getSettingsAsync } from './settings'
import { classifyProviderError, friendlyProviderError as friendlyProviderErrorClassified } from './providerErrors'
import { getBillingAccess, getManagedAIConfig } from './billing'
import { selectJobProvider } from '../lib/providerRouting'
import { getProviderBreakerState, recordProviderHardFailure, resetProviderBreaker } from './providerCircuitBreaker'
import { abortError, getAmbientAbortSignal, isAbortError } from '../lib/aiCancellation'
import { evaluateFeatureBudget, fireRunawaySpendAlertOnce } from './aiSpendGuardrails'
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
  transport?: 'direct' | 'managed'
  baseUrl?: string | null
  billingMode?: 'free_credit' | 'subscription' | 'local_pass' | 'own_key'
  feature?: string
}

export interface AIProviderUsage {
  inputTokens?: number | null
  outputTokens?: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
  costUsd?: number | null
}

export interface ProviderTextResponse {
  text: string
  usage?: AIProviderUsage | null
}

export interface AITextJobExecutionOptions {
  cachePolicy: 'off' | 'stable_prefix' | 'repeated_payload'
  promptCachingEnabled: boolean
  onDelta?: (delta: string) => void | Promise<void>
  // Output token cap for this job. Defaults to DEFAULT_MAX_OUTPUT_TOKENS when
  // omitted. Long-form jobs (reports, week reviews) override upward; chat
  // answers stay at the default.
  maxOutputTokens?: number
  // The chat turn's abort signal. Provider send functions
  // hand it to their SDK call so Stop aborts the in-flight HTTP request.
  signal?: AbortSignal
}

// R5 context-32k: the cap is an upper bound, not a target — the model still
// stops when the answer is done, and per-job timeouts bound any runaway. Every
// model in the tier table (Haiku 4.5, Sonnet 4.6, plus the Opus override)
// supports >=32k output, so the surfaces that were clipping rich summaries no
// longer truncate. Short jobs (block labels, follow-up chips) naturally emit a
// handful of tokens regardless of this ceiling.
const DEFAULT_MAX_OUTPUT_TOKENS = 32000
const LONG_FORM_MAX_OUTPUT_TOKENS = 32000

interface AIJobDefinition {
  jobType: AIJobType
  screen: AISurface
  foreground: boolean
  timeoutMs: number
  // Invariant #12: every AI surface runs on the single provider/model the user
  // picked in Settings. The only sanctioned exception is an explicit, visible
  // per-chat provider override in the AI tab — never a silent swap. Jobs that
  // belong to that chat surface set `usesChatOverride`; everything else (block
  // naming, summaries, reports, wraps) follows `settings.aiProvider`.
  usesChatOverride?: boolean
  cachePolicy: 'off' | 'stable_prefix' | 'repeated_payload'
  modelStrategy: Extract<AIModelStrategy, 'balanced' | 'quality' | 'economy'>
  // Override the default output token cap for this job. Defaults to
  // DEFAULT_MAX_OUTPUT_TOKENS when omitted.
  maxOutputTokens?: number
}

// ai_usage_events showed cache_read=0
// on EVERY job while repeated_payload jobs wrote cache tokens at the 1.25×
// write premium. A repeated_payload marker only pays when the byte-identical
// request is re-sent within the 5-minute TTL, and none of these payloads ever
// was (day/wrap/report payloads are date- and data-specific; repeats are served
// by in-process caches before reaching the provider). So repeated_payload is a
// pure surcharge and every former repeated_payload job now runs cachePolicy 'off'.
// stable_prefix stays only on conversational jobs, where a growing multi-turn
// prefix can genuinely be re-read.
const JOB_DEFINITIONS: Record<AIJobType, AIJobDefinition> = {
  block_label_preview: {
    jobType: 'block_label_preview',
    screen: 'timeline_day',
    foreground: false,
    timeoutMs: 8_000,
    cachePolicy: 'off',
    modelStrategy: 'economy',
  },
  block_label_finalize: {
    jobType: 'block_label_finalize',
    screen: 'timeline_day',
    foreground: false,
    timeoutMs: 12_000,
    cachePolicy: 'stable_prefix',
    modelStrategy: 'economy',
  },
  block_cleanup_relabel: {
    jobType: 'block_cleanup_relabel',
    screen: 'background',
    foreground: false,
    timeoutMs: 15_000,
    cachePolicy: 'stable_prefix',
    modelStrategy: 'balanced',
  },
  // The interpretation-agent relabel (agent-runtime-and-context.md §Agent
  // roles): the relabel family's tool-loop lane. Same tier and background
  // posture as block_cleanup_relabel — it replaces one relabel call with a
  // small tool loop, not a new billing surface. The loop runs through the AI
  // SDK (like chat_answer), so its usage is reported per turn via
  // recordInterpretationAgentUsage rather than executeTextAIJob.
  interpretation_agent: {
    jobType: 'interpretation_agent',
    screen: 'background',
    foreground: false,
    timeoutMs: 45_000,
    cachePolicy: 'off',
    modelStrategy: 'balanced',
  },
  day_summary: {
    jobType: 'day_summary',
    screen: 'timeline_day',
    foreground: true,
    timeoutMs: 15_000,
    cachePolicy: 'off',
    modelStrategy: 'balanced',
  },
  week_review: {
    jobType: 'week_review',
    screen: 'timeline_week',
    foreground: true,
    timeoutMs: 18_000,
    cachePolicy: 'off',
    modelStrategy: 'balanced',
    // Week review prose spans multiple days; give it the full 32k budget.
    maxOutputTokens: 32000,
  },
  app_narrative: {
    jobType: 'app_narrative',
    screen: 'app_detail',
    foreground: true,
    timeoutMs: 15_000,
    cachePolicy: 'off',
    modelStrategy: 'balanced',
    maxOutputTokens: 32000,
  },
  chat_answer: {
    jobType: 'chat_answer',
    screen: 'ai_chat',
    foreground: true,
    timeoutMs: 30_000,
    usesChatOverride: true,
    cachePolicy: 'stable_prefix',
    modelStrategy: 'quality',
  },
  chat_thread_title: {
    jobType: 'chat_thread_title',
    screen: 'ai_chat',
    foreground: true,
    timeoutMs: 8_000,
    usesChatOverride: true,
    cachePolicy: 'off',
    modelStrategy: 'economy',
  },
  chat_followup_suggestions: {
    jobType: 'chat_followup_suggestions',
    screen: 'ai_chat',
    foreground: true,
    timeoutMs: 8_000,
    usesChatOverride: true,
    cachePolicy: 'off',
    modelStrategy: 'economy',
  },
  report_generation: {
    jobType: 'report_generation',
    screen: 'ai_chat',
    foreground: true,
    timeoutMs: 60_000,
    cachePolicy: 'off',
    modelStrategy: 'quality',
    // No model pin: reports run on the same model the user picked in Settings,
    // like every other surface (invariant #12). A silent Opus swap here is
    // exactly the "nothing secretly switches" rule says we must not do.
    maxOutputTokens: LONG_FORM_MAX_OUTPUT_TOKENS,
  },
  attribution_assist: {
    jobType: 'attribution_assist',
    screen: 'background',
    foreground: false,
    timeoutMs: 15_000,
    cachePolicy: 'stable_prefix',
    modelStrategy: 'balanced',
  },
  wrapped_narrative: {
    jobType: 'wrapped_narrative',
    screen: 'timeline_day',
    foreground: true,
    // The deck rewrite made the response a full slide deck (one line per
    // slide + question + reflection), so the call needs more room than the
    // old five-field arc did. A 16-slide Sonnet deck runs ~15-25s. Overridable
    // for the offline benchmark, which tolerates a longer wait to measure
    // content rather than latency.
    timeoutMs: Number(process.env.WRAPPED_JOB_TIMEOUT_MS) || 40_000,
    cachePolicy: 'off',
    // The wrap is the showcase surface — "the most crafted
    // surface" — so it rides the QUALITY tier (Sonnet, not Haiku). On the
    // balanced/Haiku tier the deck opening kept failing the voice guard and
    // collapsing the whole wrap to the deterministic fallback. Taste-heavy
    // user-facing copy never rides a cheap tier.
    modelStrategy: 'quality',
  },
  // Weekly/monthly Wrapped narration. Mirrors wrapped_narrative but targets the
  // period aggregate (see services/wrappedPeriodNarrative.ts). Same provider
  // routing and tier as the daily variant — the payload is slightly larger
  // (per-day buckets) but prose quality expectations are identical.
  wrapped_period_narrative: {
    jobType: 'wrapped_period_narrative',
    screen: 'timeline_week',
    foreground: true,
    // A weekly deck is 20+ slides of prose; give it real time.
    timeoutMs: Number(process.env.WRAPPED_JOB_TIMEOUT_MS) || 45_000,
    cachePolicy: 'off',
    modelStrategy: 'quality',
  },
  // Ask-anything on a wrap slide, and answering the wrap's own curious
  // question. One short user-facing call, grounded in the same facts the
  // slide shows. It is the wrap talking back, so it rides the same quality
  // tier as the deck itself, not Haiku.
  wrapped_question: {
    jobType: 'wrapped_question',
    screen: 'timeline_day',
    foreground: true,
    timeoutMs: 20_000,
    cachePolicy: 'off',
    modelStrategy: 'quality',
  },
  // S1: interpret a natural-language search query into FTS terms + a one-line
  // intent. Uses the chat provider (so search rides the same key the user
  // chose), the cheapest model tier, and a single short call (R1 throttled).
  search_intent: {
    jobType: 'search_intent',
    screen: 'ai_chat',
    foreground: true,
    timeoutMs: 8_000,
    usesChatOverride: true,
    cachePolicy: 'off',
    modelStrategy: 'economy',
  },
  // Memory write extraction (memory.md §2.1): a quick single-shot call that
  // turns a "remember/forget/correct" instruction into structured ops before
  // the preview card is built. Cheap and off-screen, like attribution_assist.
  memory_write: {
    jobType: 'memory_write',
    screen: 'background',
    foreground: false,
    timeoutMs: 10_000,
    cachePolicy: 'off',
    modelStrategy: 'economy',
  },
  // Weekly brief (ai_chat surface): turns the deterministic weekly evidence
  // pack into editorial prose. Rides the chat provider override like
  // chat_answer, gets the full long-form output budget like week_review.
  weekly_brief: {
    jobType: 'weekly_brief',
    screen: 'timeline_week',
    foreground: true,
    timeoutMs: 30_000,
    usesChatOverride: true,
    cachePolicy: 'off',
    modelStrategy: 'quality',
    maxOutputTokens: LONG_FORM_MAX_OUTPUT_TOKENS,
  },
}

function providerUsesCLI(provider: AIProviderMode): provider is 'claude-cli' | 'chatgpt-cli' | 'gemini-cli' | 'codex-cli' {
  return provider === 'claude-cli' || provider === 'chatgpt-cli' || provider === 'gemini-cli' || provider === 'codex-cli'
}

// Model tier table — what runs at each cost level per provider.
//
// Tier intent:
//   economy  — background, high-volume, latency-tolerant jobs (block labeling, previews)
//   balanced — foreground summaries that need coherent prose but not frontier reasoning
//   quality  — interactive chat and complex queries where reasoning depth matters
//
// This table is a last-resort fallback only: under BYOK the user's chosen model
// (settings.<provider>Model) always wins, on every surface, including reports.
//
// ids verified against each provider's public
// docs. This table is a LAST-RESORT fallback: under BYOK the user's chosen model
// (settings.<provider>Model) always wins (see modelForProvider). The ids here
// stay a subset of what the Settings catalog (AI_PROVIDER_META) offers, so the
// fallback can never resolve to a model the UI doesn't list. The Google entries
// previously pointed at gemini-3.1-flash-lite-preview, which was shut down
// and replaced with the GA gemini-3.1-flash-lite / gemini-3.5-flash.
const ANTHROPIC_TIER_MODELS: Record<'economy' | 'balanced' | 'quality', string> = {
  economy: 'claude-haiku-4-5-20251001',   // Fast and cheap — block labels, previews
  balanced: 'claude-haiku-4-5-20251001',  // Summaries are fine with Haiku
  quality: 'claude-sonnet-5',             // Chat answers, attribution reasoning
}
const OPENAI_TIER_MODELS: Record<'economy' | 'balanced' | 'quality', string> = {
  economy: 'gpt-5.4-nano',
  balanced: 'gpt-5.4-mini',
  quality: 'gpt-5.5',
}

const GOOGLE_TIER_MODELS: Record<'economy' | 'balanced' | 'quality', string> = {
  economy: 'gemini-3.1-flash-lite',   // GA, cheapest/highest-RPM — keeps R1 budget low
  balanced: 'gemini-3.1-flash-lite',
  quality: 'gemini-3.5-flash',        // GA flagship
}

export function modelForProvider(
  provider: AIProviderMode,
  strategyOrSettings: AIModelStrategy | AppSettings = getSettings(),
  settings = getSettings(),
): string {
  // Simplified BYOK model: the one model the user picked for a provider is used
  // for every job. The legacy strategy argument is still accepted for call-site
  // compatibility, but it no longer changes the result — the user's chosen model
  // always wins. The per-tier tables remain only as last-resort defaults.
  const resolvedSettings: AppSettings =
    typeof strategyOrSettings === 'string' ? settings : strategyOrSettings

  switch (provider) {
    case 'openai':
    case 'chatgpt-cli':
    case 'codex-cli':
      return resolvedSettings.openaiModel || OPENAI_TIER_MODELS.quality
    case 'google':
    case 'gemini-cli':
      return resolvedSettings.googleModel || GOOGLE_TIER_MODELS.quality
    case 'openrouter':
      return resolvedSettings.openrouterModel || 'anthropic/claude-sonnet-4.6'
    case 'claude-cli':
    case 'anthropic':
    default:
      return resolvedSettings.anthropicModel || ANTHROPIC_TIER_MODELS.quality
  }
}

export function providerLabel(provider: AIProviderMode): string {
  switch (provider) {
    case 'openai':
      return 'OpenAI'
    case 'google':
      return 'Google Gemini'
    case 'openrouter':
      return 'OpenRouter'
    case 'claude-cli':
      return 'Claude CLI'
    case 'chatgpt-cli':
      return 'ChatGPT CLI'
    case 'gemini-cli':
      return 'Gemini CLI'
    case 'codex-cli':
      return 'Codex CLI'
    case 'anthropic':
    default:
      return 'Anthropic Claude'
  }
}

// BYOK routing (R2): each job resolves to the provider its definition declares
// via `providerPreferenceKey` — for chat that is `aiChatProvider`, which is
// exactly what the chat UI shows — falling back to the global `aiProvider`.
// This closes the latent seam where orchestration always ran on `aiProvider`
// while the chat surface displayed `aiChatProvider ?? aiProvider`. Still no
// cross-provider fallback (see applyStrategyProviderFallback): we never
// silently route to a provider the user did not choose.
function preferredProviderForJob(jobType: AIJobType, settings: AppSettings): AIProviderMode {
  // The selected provider in Settings is authoritative for every surface. Chat
  // is the one place a user can explicitly pick a different provider for that
  // conversation; when they have, honour it — otherwise chat also follows the
  // Settings choice. No background surface ever routes to a provider the user
  // didn't pick (that was the "Settings says Claude, re-analyze runs Gemini" bug).
  return selectJobProvider(Boolean(JOB_DEFINITIONS[jobType].usesChatOverride), settings)
}

function applyStrategyProviderFallback(preferred: AIProviderMode): AIProviderMode[] {
  return [preferred]
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

// Delegate to the shared classifier (R4 + R2) so every AI surface — chat,
// timeline re-analyze (T1), regenerate label (T2), reports — distinguishes a
// transient per-minute 429 from a hard quota/credit/auth wall, with branded
// copy and a structured code the renderer can act on.
function friendlyProviderError(error: unknown, label: string): Error {
  return friendlyProviderErrorClassified(error, label)
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

// Exported for the chat agent lane, which resolves its provider the
// same way every text job does — Settings choice, thread override, managed
// fallback — but runs the AI SDK loop instead of a single text call.
export async function resolveProviderConfigsForJob(
  jobType: AIJobType,
  settings: AppSettings,
  preferredProviderOverride?: AIProviderMode | null,
): Promise<ResolvedProviderConfig[]> {
  const preferredProvider = preferredProviderOverride ?? preferredProviderForJob(jobType, settings)
  const orderedProviders = applyStrategyProviderFallback(preferredProvider)
  const definition = JOB_DEFINITIONS[jobType]
  const configs: ResolvedProviderConfig[] = []

  for (const provider of orderedProviders) {
    const apiKey = await getApiKey(provider)
    if (!providerUsesCLI(provider) && !apiKey) continue

    configs.push({
      provider,
      apiKey,
      model: modelForProvider(provider, definition.modelStrategy, settings),
      transport: 'direct',
      billingMode: 'own_key',
      feature: jobType,
    })
  }

  if (configs.length === 0) {
    const managed = await getManagedAIConfig()
    if (managed) {
      // Managed transport: Daylens pays for these tokens, so route by job tier.
      // Economy AND balanced jobs (block labels, relabels, wraps, summaries)
      // ride the billing service's cheap alias when it advertises one; only
      // quality jobs (chat, reports, weekly brief) stay on the default managed
      // model. This mirrors ANTHROPIC_TIER_MODELS, where balanced == Haiku.
      // Invariant #12 is not in play here: managed users never pick a model in
      // Settings, and Usage reports the real model on every call.
      // NOTE: the value must be a LiteLLM *alias* the proxy knows
      // (litellm-config.yaml), never a raw provider model id — raw ids 404.
      const wantsEconomyTier = definition.modelStrategy !== 'quality'
      configs.push({
        provider: managed.provider,
        apiKey: managed.accessToken,
        model: wantsEconomyTier && managed.economyModel ? managed.economyModel : managed.model,
        transport: 'managed',
        baseUrl: managed.baseUrl,
        billingMode: managed.mode,
        feature: jobType,
      })
    }
  }

  if (configs.length === 0) {
    throw new Error('AI access is paused. Subscribe or add your own key in Settings.')
  }

  return configs
}

// Briefs & wraps no-credits gate: the wrap surfaces ask
// whether a provider is resolvable for the wrapped job BEFORE rendering, so they
// can show one "connect a provider in Settings" message instead of any content.
// This never makes a network call — it only checks that a key/CLI exists for the
// provider the user selected in Settings.
export async function getWrapProviderState(): Promise<{ connected: boolean; provider: string | null }> {
  const settings = await getSettingsAsync()
  const provider = preferredProviderForJob('wrapped_narrative', settings)
  const label = providerLabel(provider)
  if (providerUsesCLI(provider)) return { connected: true, provider: label }
  const apiKey = await getApiKey(provider)
  if (apiKey) return { connected: true, provider: label }
  const billing = await getBillingAccess()
  return {
    connected: billing.canUseAI,
    provider: billing.managed ? 'Daylens managed AI' : billing.providerLabel,
  }
}

// Hard daily budget breaker for unattended AI work. A stale production build
// once re-labeled the same three blocks every ~10s for days — tens of
// thousands of background calls, real weekly spend — because nothing between
// the scheduler and the provider ever said "enough". This is that "enough": every
// background call is counted in ai_usage_events, and past the cap the day's
// background work is refused at the single choke point every job runs through.
// User-triggered and system (wrap/brief) jobs are never blocked — a runaway
// there is visible on screen, and the user's explicit actions must always win.
// 250 Haiku-sized label calls ≈ $0.35/day worst case.
export const BACKGROUND_AI_DAILY_CALL_CAP = 250

export function backgroundAIBudgetExhausted(db: ReturnType<typeof getDb>, now = Date.now()): boolean {
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  return countBackgroundAIUsageEventsSince(db, midnight.getTime()) >= BACKGROUND_AI_DAILY_CALL_CAP
}

export async function executeTextAIJob(
  payload: {
    jobType: AIJobType
    screen?: AISurface
    triggerSource: AIInvocationSource
    systemPrompt: string
    userMessage: string
    prior?: Array<{ role: 'user' | 'assistant'; content: string }>
    preferredProviderOverride?: AIProviderMode | null
  },
  runner: (
    config: ResolvedProviderConfig,
    systemPrompt: string,
    prior: Array<{ role: 'user' | 'assistant'; content: string }>,
    userMessage: string,
    options: AITextJobExecutionOptions,
  ) => Promise<ProviderTextResponse>,
  streamOptions?: {
    onDelta?: (delta: string) => void | Promise<void>
  },
): Promise<{ text: string; config: ResolvedProviderConfig; usage: AIProviderUsage | null; cachePolicy: AIJobDefinition['cachePolicy'] }> {
  if (payload.triggerSource === 'background' && backgroundAIBudgetExhausted(getDb())) {
    throw new Error(
      `Background AI budget reached for today (${BACKGROUND_AI_DAILY_CALL_CAP} calls); skipping ${payload.jobType} until tomorrow.`,
    )
  }

  // A chat turn makes several provider calls (planner,
  // phrase, follow-ups). If the user already hit Stop, don't start the next one.
  const ambientSignal = getAmbientAbortSignal()
  if (ambientSignal?.aborted) throw abortError()

  const settings = await getSettingsAsync()
  const definition = JOB_DEFINITIONS[payload.jobType]

  // DEV-228 spend guardrails. Gate on the trigger alone, not the job type's
  // foreground flag: the scheduled evening wrap and weekly brief run
  // foreground job types with triggerSource 'system', and "stop background AI
  // immediately" must stop those too. Every call site the user explicitly
  // clicks passes triggerSource 'user' (verified: manual wrap, re-analyze,
  // chat), so neither guard can block something the user asked for.
  if (payload.triggerSource !== 'user') {
    if (settings.backgroundAiEnabled === false) {
      throw new Error(
        `Background AI is switched off; skipping ${payload.jobType}. Turn it back on in Settings → Usage.`,
      )
    }
    const verdict = evaluateFeatureBudget(getDb(), settings, payload.jobType)
    if (verdict.exhausted) {
      // The alert fires on the first blocked call — exactly when a runaway
      // loop would otherwise keep spending silently.
      fireRunawaySpendAlertOnce(verdict)
      capture(ANALYTICS_EVENT.AI_JOB_FAILED, {
        failure_kind: 'feature_budget_exhausted',
        job_type: payload.jobType,
        trigger_source: payload.triggerSource,
      })
      throw new Error(
        `${verdict.feature} hit its daily AI budget ($${verdict.spentUsd.toFixed(2)} of $${verdict.budgetUsd.toFixed(2)}); skipping ${payload.jobType} until tomorrow. Budgets live in Settings → Usage.`,
      )
    }
  }

  // Provider circuit breaker: machine-initiated runs of background job
  // types (`foreground: false` in JOB_DEFINITIONS) are refused outright while
  // the intended provider is cooling down from a quota/credit hard wall. This
  // never touches ai_usage_events — a skip is not a call — mirroring the
  // early-exit style of the background daily budget check above. Anything the
  // user explicitly asked for is never gated: foreground job types, and
  // background job types running with triggerSource 'user' (the manual
  // Analyze click runs block_cleanup_relabel as 'user'). Those still get one
  // honest attempt and the existing friendly error if the provider is out.
  if (!definition.foreground && payload.triggerSource !== 'user') {
    const intendedProvider = payload.preferredProviderOverride ?? preferredProviderForJob(payload.jobType, settings)
    const breaker = getProviderBreakerState(getDb(), intendedProvider)
    if (breaker.open) {
      const label = providerLabel(intendedProvider)
      const humanReason = breaker.reason === 'credit_exhausted' ? 'credit balance' : 'usage limit'
      console.warn(
        `[ai:breaker] skipping background ${payload.jobType} — ${label} ${humanReason} cooldown active until ${new Date(breaker.cooldownUntil ?? 0).toISOString()}`,
      )
      capture(ANALYTICS_EVENT.AI_PROVIDER_BREAKER_SKIPPED, {
        provider: intendedProvider,
        job_type: payload.jobType,
        reason: breaker.reason,
      })
      throw new Error(
        `Background AI paused for ${label}: its ${humanReason} tripped a cooldown. It resumes automatically, or fix it now in Settings → AI.`,
      )
    }
  }

  const executionOptions: AITextJobExecutionOptions = {
    cachePolicy: definition.cachePolicy,
    promptCachingEnabled: settings.aiPromptCachingEnabled ?? true,
    onDelta: streamOptions?.onDelta,
    maxOutputTokens: definition.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    signal: ambientSignal,
  }
  const eventId = randomUUID()
  const startedAt = Date.now()
  const prior = payload.prior ?? []
  const systemPrompt = redactAIText(payload.systemPrompt, settings)
  const userMessage = redactAIText(payload.userMessage, settings)
  const sanitizedPrior = prior.map((message) => ({
    role: message.role,
    content: redactAIText(message.content, settings),
  }))

  const configs = await resolveProviderConfigsForJob(payload.jobType, settings, payload.preferredProviderOverride)

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
      const response = await runner(config, systemPrompt, sanitizedPrior, userMessage, executionOptions)
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
        costUsd: usage?.costUsd ?? null,
        billingMode: config.billingMode ?? 'own_key',
      })
      // A successful call is the clearest possible signal the provider has
      // recovered — close its breaker immediately rather than waiting out
      // the rest of the cooldown.
      resetProviderBreaker(getDb(), config.provider, 'success')
      capture(ANALYTICS_EVENT.AI_JOB_COMPLETED, {
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
      captureAIGeneration({
        traceId: eventId,
        jobType: payload.jobType,
        provider: config.provider,
        model: config.model,
        latencyMs: completedAt - startedAt,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        cacheReadTokens: usage?.cacheReadTokens ?? null,
        cacheWriteTokens: usage?.cacheWriteTokens ?? null,
        daylensCostUsd: usage?.costUsd
          ?? estimateUsageCostUsd(config.model, usage?.inputTokens, usage?.outputTokens, usage?.cacheReadTokens, usage?.cacheWriteTokens),
        daylensCostSource: usage?.costUsd != null ? 'provider' : 'estimated',
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
      // A user-initiated Stop must not fall through to the next configured
      // provider — the whole turn is over.
      if (ambientSignal?.aborted || isAbortError(error)) {
        break
      }
      if (!isQuotaOrAuthError(error)) {
        break
      }
    }
  }

  const completedAt = Date.now()
  const friendlyError = friendlyProviderError(lastError, providerLabel(lastConfig?.provider ?? configs[0]?.provider ?? 'anthropic'))

  // A confirmed hard wall (quota/credit) opens the breaker for this provider
  // regardless of who triggered the call — the fact "this provider is out"
  // is true either way, even though only background dispatch above actually
  // consults it. Retry-After (when the provider gave one) sets how long.
  if (lastConfig) {
    const meta = classifyProviderError(lastError)
    if (meta.code === 'quota_exhausted' || meta.code === 'credit_exhausted') {
      recordProviderHardFailure(getDb(), lastConfig.provider, meta.code, meta.retryAfterSeconds ?? null, completedAt)
    }
  }

  finishAIUsageEvent(getDb(), {
    id: eventId,
    provider: lastConfig?.provider ?? null,
    model: lastConfig?.model ?? null,
    success: false,
    failureReason: friendlyError.message,
    completedAt,
    latencyMs: completedAt - startedAt,
    billingMode: lastConfig?.billingMode ?? 'own_key',
  })
  capture(ANALYTICS_EVENT.AI_JOB_FAILED, {
    failure_kind: classifyFailureKind(lastError),
    job_type: payload.jobType,
    screen: payload.screen ?? definition.screen,
    provider: lastConfig?.provider ?? null,
    model: lastConfig?.model ?? null,
    trigger_source: payload.triggerSource,
    latency_ms: completedAt - startedAt,
    cache_policy: definition.cachePolicy,
  })
  captureAIGeneration({
    traceId: eventId,
    jobType: payload.jobType,
    provider: lastConfig?.provider ?? null,
    model: lastConfig?.model ?? null,
    latencyMs: completedAt - startedAt,
    isError: true,
  })

  throw friendlyError
}

// Usage accounting for a chat agent turn. The agent lane makes its
// provider calls through the AI SDK, not executeTextAIJob, so it reports its
// summed per-turn usage here — one ai_usage_events row + the same analytics
// pair every other AI call emits, so Usage and cost tracking never miss chat.
export function recordChatAgentUsage(input: {
  config: ResolvedProviderConfig
  usage: AIProviderUsage | null
  startedAt: number
  success: boolean
  failureReason?: string | null
}): void {
  const eventId = randomUUID()
  const completedAt = Date.now()
  const latencyMs = completedAt - input.startedAt
  startAIUsageEvent(getDb(), {
    id: eventId,
    jobType: 'chat_answer',
    screen: 'ai_chat',
    triggerSource: 'user',
    provider: input.config.provider,
    model: input.config.model,
    startedAt: input.startedAt,
  })
  finishAIUsageEvent(getDb(), {
    id: eventId,
    provider: input.config.provider,
    model: input.config.model,
    success: input.success,
    failureReason: input.success ? undefined : (input.failureReason ?? 'agent turn failed'),
    completedAt,
    latencyMs,
    inputTokens: input.usage?.inputTokens ?? null,
    outputTokens: input.usage?.outputTokens ?? null,
    cacheReadTokens: input.usage?.cacheReadTokens ?? null,
    cacheWriteTokens: input.usage?.cacheWriteTokens ?? null,
    cacheHit: Boolean((input.usage?.cacheReadTokens ?? 0) > 0),
    costUsd: input.usage?.costUsd ?? null,
    billingMode: input.config.billingMode ?? 'own_key',
  })
  capture(input.success ? ANALYTICS_EVENT.AI_JOB_COMPLETED : ANALYTICS_EVENT.AI_JOB_FAILED, {
    job_type: 'chat_answer',
    screen: 'ai_chat',
    provider: input.config.provider,
    model: input.config.model,
    trigger_source: 'user',
    latency_ms: latencyMs,
    input_tokens: input.usage?.inputTokens ?? null,
    output_tokens: input.usage?.outputTokens ?? null,
    cache_hit: Boolean((input.usage?.cacheReadTokens ?? 0) > 0),
    cache_policy: 'off',
  })
  captureAIGeneration({
    traceId: eventId,
    jobType: 'chat_answer',
    provider: input.config.provider,
    model: input.config.model,
    latencyMs,
    inputTokens: input.usage?.inputTokens ?? null,
    outputTokens: input.usage?.outputTokens ?? null,
    cacheReadTokens: input.usage?.cacheReadTokens ?? null,
    cacheWriteTokens: input.usage?.cacheWriteTokens ?? null,
    daylensCostUsd: input.usage?.costUsd
      ?? estimateUsageCostUsd(input.config.model, input.usage?.inputTokens, input.usage?.outputTokens, input.usage?.cacheReadTokens, input.usage?.cacheWriteTokens),
    daylensCostSource: input.usage?.costUsd != null ? 'provider' : 'estimated',
    isError: !input.success,
  })
}

// Usage accounting for one interpretation-agent relabel turn. Same shape as
// recordChatAgentUsage: the agent loop makes its provider calls through the
// AI SDK, not executeTextAIJob, so it reports its summed per-turn usage here —
// one ai_usage_events row + the same analytics pair. The job_type is its own
// lane ('interpretation_agent', grouped under Timeline labeling in
// aiFeatures.ts) so Usage never hides the tool loop inside plain relabels.
export function recordInterpretationAgentUsage(input: {
  config: ResolvedProviderConfig
  usage: AIProviderUsage | null
  startedAt: number
  success: boolean
  failureReason?: string | null
  triggerSource: AIInvocationSource
}): void {
  const eventId = randomUUID()
  const completedAt = Date.now()
  const latencyMs = completedAt - input.startedAt
  startAIUsageEvent(getDb(), {
    id: eventId,
    jobType: 'interpretation_agent',
    screen: 'background',
    triggerSource: input.triggerSource,
    provider: input.config.provider,
    model: input.config.model,
    startedAt: input.startedAt,
  })
  finishAIUsageEvent(getDb(), {
    id: eventId,
    provider: input.config.provider,
    model: input.config.model,
    success: input.success,
    failureReason: input.success ? undefined : (input.failureReason ?? 'interpretation agent turn failed'),
    completedAt,
    latencyMs,
    inputTokens: input.usage?.inputTokens ?? null,
    outputTokens: input.usage?.outputTokens ?? null,
    cacheReadTokens: input.usage?.cacheReadTokens ?? null,
    cacheWriteTokens: input.usage?.cacheWriteTokens ?? null,
    cacheHit: Boolean((input.usage?.cacheReadTokens ?? 0) > 0),
    costUsd: input.usage?.costUsd ?? null,
    billingMode: input.config.billingMode ?? 'own_key',
  })
  capture(input.success ? ANALYTICS_EVENT.AI_JOB_COMPLETED : ANALYTICS_EVENT.AI_JOB_FAILED, {
    job_type: 'interpretation_agent',
    screen: 'background',
    provider: input.config.provider,
    model: input.config.model,
    trigger_source: input.triggerSource,
    latency_ms: latencyMs,
    input_tokens: input.usage?.inputTokens ?? null,
    output_tokens: input.usage?.outputTokens ?? null,
    cache_hit: Boolean((input.usage?.cacheReadTokens ?? 0) > 0),
    cache_policy: 'off',
  })
  captureAIGeneration({
    traceId: eventId,
    jobType: 'interpretation_agent',
    provider: input.config.provider,
    model: input.config.model,
    latencyMs,
    inputTokens: input.usage?.inputTokens ?? null,
    outputTokens: input.usage?.outputTokens ?? null,
    cacheReadTokens: input.usage?.cacheReadTokens ?? null,
    cacheWriteTokens: input.usage?.cacheWriteTokens ?? null,
    daylensCostUsd: input.usage?.costUsd
      ?? estimateUsageCostUsd(input.config.model, input.usage?.inputTokens, input.usage?.outputTokens, input.usage?.cacheReadTokens, input.usage?.cacheWriteTokens),
    daylensCostSource: input.usage?.costUsd != null ? 'provider' : 'estimated',
    isError: !input.success,
  })
}
