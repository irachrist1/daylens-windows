// AI service — runs in the main process only and routes to the selected provider.
// Renderer communicates via IPC (never direct SDK access)
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { GoogleGenAI, type Content as GoogleContent } from '@google/genai'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  appendConversationMessage,
  clearConversation,
  getConversationMessages,
  getOrCreateConversation,
  getAppSummariesForRange,
  getPeakHours,
  getSessionsForRange,
  getWebsiteSummariesForRange,
  getRecentFocusSessions,
  getCategoryOverrides,
  upsertWorkContextInsight,
} from '../db/queries'
import { routeInsightsQuestion, type TemporalContext } from '../lib/insightsQueryRouter'
import { deriveWorkEvidenceSummary } from '../lib/workEvidence'
import { getDb } from './database'
import { getApiKey, getSettings, getSettingsAsync } from './settings'
import { computeEnhancedFocusScore } from '../lib/focusScore'
import type { AIProviderMode, AppCategorySuggestion, WorkContextBlock, WorkContextInsight } from '@shared/types'
import { fallbackNarrativeForBlock, userVisibleLabelForBlock } from './workBlocks'

const GOOGLE_CLIENT_HEADER = 'daylens-windows/1.0.0'
const BLOCK_INSIGHT_TIMEOUT_MS = 12_000

interface ResolvedProviderConfig {
  provider: AIProviderMode
  apiKey: string | null
  model: string
}

type ConversationMessage = { role: 'user' | 'assistant'; content: string }

interface CLIToolDetectionResult {
  claude: string | null
  codex: string | null
}

interface CodexExecCapabilities {
  supportsOutputLastMessage: boolean
  supportsSandbox: boolean
  supportsConfig: boolean
}

interface ResolvedCLITool {
  executablePath: string
  codexExecCapabilities: CodexExecCapabilities | null
}

class CLIProviderError extends Error {
  readonly code: 'not_found' | 'non_zero_exit' | 'timeout' | 'launch_failed'

  constructor(code: CLIProviderError['code'], message: string) {
    super(message)
    this.name = 'CLIProviderError'
    this.code = code
  }
}

const CLI_TIMEOUT_MS = 180_000
const conversationTemporalContext = new Map<number, TemporalContext | null>()
const cliToolCache: Partial<Record<'claude' | 'codex', Promise<ResolvedCLITool | null>>> = {}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    void promise
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch((error) => {
        clearTimeout(timer)
        reject(error)
      })
  })
}

function cliBinaryCandidates(tool: 'claude' | 'codex'): string[] {
  const appData = process.env.APPDATA
  const userProfile = process.env.USERPROFILE
  return [
    appData ? path.join(appData, 'npm', `${tool}.cmd`) : null,
    userProfile ? path.join(userProfile, 'AppData', 'Roaming', 'npm', `${tool}.cmd`) : null,
    userProfile ? path.join(userProfile, '.local', 'bin', `${tool}.cmd`) : null,
    userProfile ? path.join(userProfile, '.volta', 'bin', `${tool}.cmd`) : null,
    userProfile ? path.join(userProfile, '.npm-global', 'bin', `${tool}.cmd`) : null,
  ].filter((candidate): candidate is string => Boolean(candidate))
}

function uniquePathEntries(entries: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []

  for (const entry of entries) {
    if (!entry) continue
    const trimmed = entry.trim()
    if (!trimmed) continue
    const key = process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push(trimmed)
  }

  return normalized
}

function buildCLIPath(executablePath: string, currentPath?: string): string {
  const appData = process.env.APPDATA
  const userProfile = process.env.USERPROFILE
  const programFiles = process.env.ProgramFiles
  const programFilesX86 = process.env['ProgramFiles(x86)']

  return uniquePathEntries([
    path.dirname(executablePath),
    appData ? path.join(appData, 'npm') : null,
    userProfile ? path.join(userProfile, 'AppData', 'Roaming', 'npm') : null,
    userProfile ? path.join(userProfile, '.local', 'bin') : null,
    userProfile ? path.join(userProfile, '.volta', 'bin') : null,
    userProfile ? path.join(userProfile, '.npm-global', 'bin') : null,
    programFiles ? path.join(programFiles, 'nodejs') : null,
    programFilesX86 ? path.join(programFilesX86, 'nodejs') : null,
    ...(currentPath ? currentPath.split(path.delimiter) : []),
  ]).join(path.delimiter)
}

function buildCLIEnv(executablePath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: buildCLIPath(executablePath, process.env.PATH),
  }
}

async function findCLIToolPath(tool: 'claude' | 'codex'): Promise<string | null> {
  for (const candidate of cliBinaryCandidates(tool)) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      // Try the next candidate.
    }
  }

  return new Promise((resolve) => {
    const child = spawn('where.exe', [tool], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(null)
        return
      }
      const match = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean)
      resolve(match ?? null)
    })
  })
}

async function runCLIHelpCommand(executablePath: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(executablePath, args, {
      env: buildCLIEnv(executablePath),
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let finished = false
    const timer = setTimeout(() => {
      if (finished) return
      finished = true
      child.kill()
      resolve(`${stdout}\n${stderr}`.trim())
    }, 10_000)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve('')
    })
    child.on('close', () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve(`${stdout}\n${stderr}`.trim())
    })
  })
}

async function inspectCodexExecCapabilities(executablePath: string): Promise<CodexExecCapabilities> {
  const [codexHelp, codexExecHelp] = await Promise.all([
    runCLIHelpCommand(executablePath, ['--help']),
    runCLIHelpCommand(executablePath, ['exec', '--help']),
  ])

  const combinedHelp = `${codexHelp}\n${codexExecHelp}`
  return {
    supportsOutputLastMessage: combinedHelp.includes('--output-last-message'),
    supportsSandbox: combinedHelp.includes('--sandbox'),
    supportsConfig: combinedHelp.includes('--config'),
  }
}

async function resolveCLITool(tool: 'claude' | 'codex'): Promise<ResolvedCLITool | null> {
  if (!cliToolCache[tool]) {
    cliToolCache[tool] = (async () => {
      const executablePath = await findCLIToolPath(tool)
      if (!executablePath) return null

      return {
        executablePath,
        codexExecCapabilities: tool === 'codex'
          ? await inspectCodexExecCapabilities(executablePath)
          : null,
      }
    })()
  }

  return cliToolCache[tool] ?? null
}

async function resolveCLIToolPath(tool: 'claude' | 'codex'): Promise<string | null> {
  const resolved = await resolveCLITool(tool)
  return resolved?.executablePath ?? null
}

export async function detectCLITools(): Promise<CLIToolDetectionResult> {
  const [claude, codex] = await Promise.all([
    resolveCLIToolPath('claude'),
    resolveCLIToolPath('codex'),
  ])
  return { claude, codex }
}

function providerUsesCLI(provider: AIProviderMode): provider is 'claude-cli' | 'codex-cli' {
  return provider === 'claude-cli' || provider === 'codex-cli'
}

function uniqueProviders(preferredProvider: AIProviderMode): AIProviderMode[] {
  return [
    preferredProvider,
    'google',
    'anthropic',
    'openai',
  ].filter((provider, index, providers) => providers.indexOf(provider) === index) as AIProviderMode[]
}

async function resolveProviderConfigs(): Promise<ResolvedProviderConfig[]> {
  const settings = await getSettingsAsync()
  const preferred = settings.aiProvider ?? 'anthropic'

  // CLI providers only participate if they are the user's selected provider AND installed.
  // They are never auto-inserted into the fallback chain because a missing binary throws
  // a non-quota error that would abort the entire chain before reaching API providers.
  let orderedProviders: AIProviderMode[]
  if (providerUsesCLI(preferred)) {
    orderedProviders = [preferred]
  } else {
    orderedProviders = uniqueProviders(preferred)
  }

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
    throw new Error('No API key configured for the selected AI provider')
  }

  return configs
}

function modelForProvider(provider: AIProviderMode, settings = getSettings()): string {
  switch (provider) {
    case 'openai':
    case 'codex-cli':
      return settings.openaiModel || 'gpt-5.4'
    case 'google':
      return settings.googleModel || 'gemini-3.1-flash-lite-preview'
    case 'claude-cli':
      return settings.anthropicModel || 'claude-opus-4-6'
    case 'anthropic':
    default:
      return settings.anthropicModel || 'claude-opus-4-6'
  }
}

function providerLabel(provider: AIProviderMode): string {
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

function openAIInputFromHistory(messages: ConversationMessage[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }))
}

function isQuotaOrAuthError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const maybeError = error as { status?: number; code?: string; type?: string; error?: { code?: string | number; status?: string; type?: string } }
  return maybeError.status === 401
    || maybeError.status === 403
    || maybeError.status === 429
    || maybeError.code === 'insufficient_quota'
    || maybeError.type === 'insufficient_quota'
    || maybeError.error?.code === 'insufficient_quota'
    || maybeError.error?.code === 429
    || maybeError.error?.status === 'RESOURCE_EXHAUSTED'
}

function friendlyProviderError(error: unknown, providerLabel: string): Error {
  if (!error || typeof error !== 'object') {
    return new Error(`${providerLabel} request failed. Please try again.`)
  }
  const maybeError = error as { status?: number; message?: string; error?: { code?: number; status?: string; message?: string } }

  // Rate limit / quota exhausted
  const status = maybeError.status ?? maybeError.error?.code
  if (status === 429 || maybeError.error?.status === 'RESOURCE_EXHAUSTED') {
    return new Error(`${providerLabel} quota exceeded. You've hit the free-tier limit — check your plan at the provider's dashboard, or switch AI providers in Settings.`)
  }
  // Auth failure
  if (status === 401 || status === 403) {
    return new Error(`${providerLabel} rejected the API key. Please check it in Settings.`)
  }
  return new Error(`${providerLabel} request failed. Please try again.`)
}

async function sendWithFallback(
  systemPrompt: string,
  prior: ConversationMessage[],
  userMessage: string,
): Promise<{ text: string; config: ResolvedProviderConfig }> {
  const configs = await resolveProviderConfigs()
  let lastError: unknown = null
  let lastConfig: ResolvedProviderConfig | null = null

  for (const config of configs) {
    try {
      const text = await sendWithProvider(config, systemPrompt, prior, userMessage)
      return { text, config }
    } catch (error) {
      lastError = error
      lastConfig = config
      if (!isQuotaOrAuthError(error)) {
        throw error
      }
    }
  }

  const label = lastConfig ? providerLabel(lastConfig.provider) : 'AI provider'
  throw friendlyProviderError(lastError, label)
}

function googleHistoryFromMessages(messages: ConversationMessage[]): GoogleContent[] {
  // Google requires strictly alternating user/model roles.
  // Strip consecutive same-role messages, keeping only the last one in each run
  // so corrupted histories (e.g. from a prior failed request) don't break the call.
  const filtered: ConversationMessage[] = []
  for (const message of messages) {
    const last = filtered[filtered.length - 1]
    if (last && last.role === message.role) {
      filtered[filtered.length - 1] = message
    } else {
      filtered.push(message)
    }
  }
  return filtered.map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }],
  }))
}

async function sendWithAnthropic(
  config: ResolvedProviderConfig,
  systemPrompt: string,
  prior: ConversationMessage[],
  userMessage: string,
): Promise<string> {
  const client = new Anthropic({ apiKey: config.apiKey ?? '' })
  const response = await client.messages.create({
    model: config.model,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [
      ...prior.map((message) => ({ role: message.role, content: message.content })),
      { role: 'user', content: userMessage },
    ],
  })

  return response.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('')
}

async function sendWithOpenAI(
  config: ResolvedProviderConfig,
  systemPrompt: string,
  prior: ConversationMessage[],
  userMessage: string,
): Promise<string> {
  const client = new OpenAI({ apiKey: config.apiKey ?? '' })
  const response = await client.responses.create({
    model: config.model,
    instructions: systemPrompt,
    input: openAIInputFromHistory([
      ...prior,
      { role: 'user', content: userMessage },
    ]),
    max_output_tokens: 1024,
    store: false,
  })

  return response.output_text || ''
}

async function sendWithGoogle(
  config: ResolvedProviderConfig,
  systemPrompt: string,
  prior: ConversationMessage[],
  userMessage: string,
): Promise<string> {
  const ai = new GoogleGenAI({
    apiKey: config.apiKey ?? '',
    httpOptions: {
      headers: {
        'x-goog-api-client': GOOGLE_CLIENT_HEADER,
      },
    },
  })
  const chat = ai.chats.create({
    model: config.model,
    config: {
      systemInstruction: systemPrompt,
    },
    history: googleHistoryFromMessages(prior),
  })

  const response = await chat.sendMessage({ message: userMessage })
  let text: string
  try {
    text = response.text ?? ''
  } catch {
    throw new Error('Gemini blocked the response. Try rephrasing or switch AI provider in Settings.')
  }
  if (!text) {
    throw new Error('Gemini returned an empty response. Try rephrasing your question.')
  }
  return text
}

async function runCLIProvider(
  tool: 'claude' | 'codex',
  prompt: string,
  model?: string,
): Promise<string> {
  const resolvedTool = await resolveCLITool(tool)
  if (!resolvedTool) {
    throw new CLIProviderError('not_found', `${tool} CLI not found`)
  }
  const { executablePath, codexExecCapabilities } = resolvedTool

  const tmpFilePath = path.join(os.tmpdir(), `daylens-${tool}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
  const args = tool === 'claude'
    ? ['-p', '--output-format', 'text', ...(model ? ['--model', model] : []), prompt]
    : (() => {
        const nextArgs = ['exec', '--skip-git-repo-check']
        if (codexExecCapabilities?.supportsSandbox) {
          nextArgs.push('--sandbox', 'read-only')
        }
        if (codexExecCapabilities?.supportsConfig) {
          nextArgs.push('--config', 'model_reasoning_effort="low"')
        }
        nextArgs.push('--color', 'never')
        if (codexExecCapabilities?.supportsOutputLastMessage) {
          nextArgs.push('--output-last-message', tmpFilePath)
        }
        if (model) {
          nextArgs.push('--model', model)
        }
        nextArgs.push(prompt)
        return nextArgs
      })()

  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(executablePath, args, {
        env: buildCLIEnv(executablePath),
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })

      let stdout = ''
      let stderr = ''
      let finished = false
      const timer = setTimeout(() => {
        if (finished) return
        finished = true
        child.kill()
        reject(new CLIProviderError('timeout', `${tool} CLI timed out after ${CLI_TIMEOUT_MS / 1000}s`))
      }, CLI_TIMEOUT_MS)

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      child.on('error', (error) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        reject(new CLIProviderError('launch_failed', error.message))
      })
      child.on('close', async (code) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        try {
          const fileOutput = tool === 'codex' && codexExecCapabilities?.supportsOutputLastMessage
            ? (await fs.readFile(tmpFilePath, 'utf8').catch(() => '')).trim()
            : ''
          const finalOutput = (tool === 'codex' && fileOutput ? fileOutput : stdout).trim()
          if (code !== 0) {
            reject(new CLIProviderError('non_zero_exit', (stderr || finalOutput || `${tool} exited with code ${code ?? 1}`).trim()))
            return
          }
          resolve(finalOutput)
        } catch (error) {
          reject(error)
        }
      })
    })

    return output
  } finally {
    if (tool === 'codex' && codexExecCapabilities?.supportsOutputLastMessage) {
      await fs.unlink(tmpFilePath).catch(() => undefined)
    }
  }
}

async function sendWithProvider(
  config: ResolvedProviderConfig,
  systemPrompt: string,
  prior: ConversationMessage[],
  userMessage: string,
): Promise<string> {
  switch (config.provider) {
    case 'claude-cli':
    case 'codex-cli': {
      const existingCLIPrompt = [
        prior.length > 0
          ? `Conversation so far:\n${prior.map((message) => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`).join('\n\n')}`
          : null,
        `User: ${userMessage}`,
      ].filter(Boolean).join('\n\n')
      const cliPrompt = `System context:\n${systemPrompt}\n\n${existingCLIPrompt}`
      return runCLIProvider(config.provider === 'claude-cli' ? 'claude' : 'codex', cliPrompt, config.model)
    }
    case 'openai':
      return sendWithOpenAI(config, systemPrompt, prior, userMessage)
    case 'google':
      return sendWithGoogle(config, systemPrompt, prior, userMessage)
    case 'anthropic':
    default:
      return sendWithAnthropic(config, systemPrompt, prior, userMessage)
  }
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${seconds}s`
}

function dayBounds(date: Date): [number, number] {
  const from = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  return [from, from + 86_400_000]
}

function countSwitches(sessions: { bundleId: string }[]): number {
  let switches = 0
  for (let i = 1; i < sessions.length; i++) {
    if (sessions[i].bundleId !== sessions[i - 1].bundleId) {
      switches++
    }
  }
  return switches
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function formatShortDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

function formatDateTimeLabel(ms: number): string {
  return `${formatShortDate(ms)} at ${formatClock(ms)}`
}

function uniqueAppNames(names: string[]): string[] {
  return names.filter((name, index) => names.indexOf(name) === index)
}

function sessionEndMs(session: { startTime: number; endTime: number | null; durationSeconds: number }): number {
  return session.endTime ?? (session.startTime + session.durationSeconds * 1000)
}

function buildRecentFocusContext(): string {
  try {
    const db = getDb()
    const sessions = getRecentFocusSessions(db, 5)
    if (sessions.length === 0) return 'Recent focus sessions: none recorded.'

    const lines = sessions.map((session) => {
      const apps = uniqueAppNames(
        getSessionsForRange(db, session.startTime, sessionEndMs(session))
          .map((item) => item.appName),
      ).slice(0, 5)

      const plan = session.plannedApps.length > 0
        ? session.plannedApps.join(', ')
        : 'not set'
      const observed = apps.length > 0 ? apps.join(', ') : 'none tracked'
      const target = session.targetMinutes ? `, target ${session.targetMinutes}m` : ''

      return `- ${formatDateTimeLabel(session.startTime)}: ${session.label || 'Focus session'} for ${formatDuration(session.durationSeconds)}${target}; planned apps ${plan}; observed apps ${observed}`
    })

    return ['Recent focus sessions:', ...lines].join('\n')
  } catch {
    return 'Recent focus sessions: unavailable.'
  }
}

function parseTimeParts(hourRaw: string, minuteRaw?: string, meridiemRaw?: string): { hour: number; minute: number } | null {
  let hour = Number(hourRaw)
  const minute = Number(minuteRaw ?? '0')
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute > 59) return null

  const meridiem = meridiemRaw?.toLowerCase()
  if (meridiem === 'am') {
    if (hour === 12) hour = 0
  } else if (meridiem === 'pm') {
    if (hour < 12) hour += 12
  }

  if (hour < 0 || hour > 23) return null
  return { hour, minute }
}

function parseTemporalLookup(userMessage: string): { label: string; targetMs: number; dayStart: number; dayEnd: number } | null {
  const lower = userMessage.toLowerCase()
  const now = new Date()

  const relativeFirst = lower.match(/\b(today|yesterday)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/)
  const timeFirst = lower.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s+(today|yesterday)\b/)
  const isoDate = lower.match(/\b(\d{4}-\d{2}-\d{2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/)

  let baseDate: Date | null = null
  let label = ''
  let timeParts: { hour: number; minute: number } | null = null

  if (relativeFirst) {
    baseDate = new Date(now)
    if (relativeFirst[1] === 'yesterday') baseDate.setDate(baseDate.getDate() - 1)
    label = relativeFirst[1]
    timeParts = parseTimeParts(relativeFirst[2], relativeFirst[3], relativeFirst[4])
  } else if (timeFirst) {
    baseDate = new Date(now)
    if (timeFirst[4] === 'yesterday') baseDate.setDate(baseDate.getDate() - 1)
    label = timeFirst[4]
    timeParts = parseTimeParts(timeFirst[1], timeFirst[2], timeFirst[3])
  } else if (isoDate) {
    const [year, month, day] = isoDate[1].split('-').map(Number)
    baseDate = new Date(year, month - 1, day)
    label = isoDate[1]
    timeParts = parseTimeParts(isoDate[2], isoDate[3], isoDate[4])
  }

  if (!baseDate || !timeParts) return null

  baseDate.setHours(timeParts.hour, timeParts.minute, 0, 0)
  const dayStart = new Date(baseDate)
  dayStart.setHours(0, 0, 0, 0)
  const dayEnd = new Date(dayStart)
  dayEnd.setDate(dayEnd.getDate() + 1)

  return {
    label,
    targetMs: baseDate.getTime(),
    dayStart: dayStart.getTime(),
    dayEnd: dayEnd.getTime(),
  }
}

function buildSpecificTimeContext(userMessage: string): string {
  try {
    const lookup = parseTemporalLookup(userMessage)
    if (!lookup) return ''

    const db = getDb()
    const daySessions = getSessionsForRange(db, lookup.dayStart, lookup.dayEnd)
    const containing = daySessions.find((session) => {
      const end = sessionEndMs(session)
      return lookup.targetMs >= session.startTime && lookup.targetMs < end
    })
    const windowStart = lookup.targetMs - 45 * 60 * 1000
    const windowEnd = lookup.targetMs + 45 * 60 * 1000
    const nearby = daySessions
      .filter((session) => sessionEndMs(session) > windowStart && session.startTime < windowEnd)
      .slice(0, 5)
    const nearbySites = getWebsiteSummariesForRange(db, windowStart, windowEnd).slice(0, 3)
    const focusSession = getRecentFocusSessions(db, 50).find((session) => {
      const end = sessionEndMs(session)
      return lookup.targetMs >= session.startTime && lookup.targetMs < end
    })

    const lines: string[] = [
      `Specific timeline lookup for ${lookup.label} (${formatDateTimeLabel(lookup.targetMs)}):`,
    ]

    if (containing) {
      lines.push(
        `- Foreground app at that time: ${containing.appName} (${containing.category}), ${formatClock(containing.startTime)}-${formatClock(sessionEndMs(containing))}.`,
      )
    } else {
      lines.push('- No foreground app session covers that exact time.')
    }

    if (nearby.length > 0) {
      lines.push(
        `- Nearby sessions: ${nearby.map((session) => `${session.appName} ${formatClock(session.startTime)}-${formatClock(sessionEndMs(session))}`).join(', ')}.`,
      )
    }

    if (focusSession) {
      const plan = focusSession.plannedApps.length > 0
        ? focusSession.plannedApps.join(', ')
        : 'not set'
      lines.push(
        `- Focus session overlap: ${focusSession.label || 'Focus session'} for ${formatDuration(focusSession.durationSeconds)}${focusSession.targetMinutes ? ` with ${focusSession.targetMinutes}m target` : ''}; planned apps ${plan}.`,
      )
    }

    if (nearbySites.length > 0) {
      lines.push(
        `- Browser evidence near that time: ${nearbySites.map((site) => `${site.domain} (${formatDuration(site.totalSeconds)})`).join(', ')}.`,
      )
    }

    return lines.join('\n')
  } catch {
    return ''
  }
}

function buildDayContext(): string {
  try {
    const db = getDb()
    const settings = getSettings()
    const now = new Date()
    const [todayFrom, todayTo] = dayBounds(now)
    const summaries = getAppSummariesForRange(db, todayFrom, todayTo)
    const todaySessions = getSessionsForRange(db, todayFrom, todayTo)
    const websites = getWebsiteSummariesForRange(db, todayFrom, todayTo)
    const todayEvidence = deriveWorkEvidenceSummary({
      appSummaries: summaries,
      sessions: todaySessions,
      websiteSummaries: websites,
    })
    const peakHours = getPeakHours(db, todayTo - 14 * 86_400_000, todayTo) ?? undefined

    const totalSec = summaries.reduce((s, a) => s + a.totalSeconds, 0)
    const focusSec = summaries.filter((a) => a.isFocused).reduce((s, a) => s + a.totalSeconds, 0)
    const switchesPerHour = totalSec > 0 ? countSwitches(todaySessions) / (totalSec / 3600) : 0
    const focusScore = computeEnhancedFocusScore({
      focusedSeconds: focusSec,
      totalSeconds: totalSec,
      switchesPerHour,
      sessions: todaySessions.map((session) => ({
        durationSeconds: session.durationSeconds,
        isFocused: session.isFocused,
      })),
      peakHours,
      currentHour: now.getHours(),
    })
    const goalHours = settings.dailyFocusGoalHours ?? 4
    const goalSec = goalHours * 3600

    // User identity & goals
    const userName = settings.userName || 'the user'
    const goalsStr = settings.userGoals?.length
      ? settings.userGoals.join(', ')
      : 'not specified'
    const goalPct = goalSec > 0 ? Math.round((focusSec / goalSec) * 100) : 0

    // Focus sessions
    const focusSessions = getRecentFocusSessions(db, 10).filter((s) => {
      return s.startTime >= todayFrom && s.startTime < todayTo
    })
    const todayFocusSessionCount = focusSessions.length
    const longestFocusSession = focusSessions.reduce((m, s) => Math.max(m, s.durationSeconds), 0)
    const totalFocusSessionSec = focusSessions.reduce((s, x) => s + x.durationSeconds, 0)

    // Category overrides
    const overrides = getCategoryOverrides(db)
    const overrideEntries = Object.entries(overrides)

    // Time context
    const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    const dayStr = now.toLocaleDateString('en-US', { weekday: 'long' })

    if (summaries.length === 0 && websites.length === 0) {
      return [
        `User: ${userName}`,
        `Goals: ${goalsStr}`,
        `Daily focus goal: ${goalHours}h target, currently at 0m (0%)`,
        `Current time: ${timeStr}, ${dayStr}`,
        '',
        'No activity recorded yet today.',
      ].join('\n')
    }

    const topCategories = new Map<string, number>()
    for (const summary of summaries) {
      topCategories.set(summary.category, (topCategories.get(summary.category) ?? 0) + summary.totalSeconds)
    }
    const topApps = summaries
      .slice(0, 5)
      .map((a) => `${a.appName} (${formatDuration(a.totalSeconds)}, ${a.category})`)
      .join(', ')
    const topSites = websites
      .slice(0, 5)
      .map((site) => `${site.domain} (${formatDuration(site.totalSeconds)})`)
      .join(', ')
    const topCategoryList = [...topCategories.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([category, seconds]) => `${category} (${formatDuration(seconds)})`)
      .join(', ')

    const recentDays: string[] = []
    for (let offset = 1; offset <= 6; offset++) {
      const date = new Date(todayFrom - offset * 86_400_000)
      const [fromMs, toMs] = dayBounds(date)
      const daySummaries = getAppSummariesForRange(db, fromMs, toMs)
      const daySessions = getSessionsForRange(db, fromMs, toMs)
      if (daySummaries.length === 0) continue
      const dayTotal = daySummaries.reduce((sum, item) => sum + item.totalSeconds, 0)
      const dayFocus = daySummaries.filter((item) => item.isFocused).reduce((sum, item) => sum + item.totalSeconds, 0)
      const daySwitchesPerHour = dayTotal > 0 ? countSwitches(daySessions) / (dayTotal / 3600) : 0
      const dayFocusScore = computeEnhancedFocusScore({
        focusedSeconds: dayFocus,
        totalSeconds: dayTotal,
        switchesPerHour: daySwitchesPerHour,
        sessions: daySessions.map((session) => ({
          durationSeconds: session.durationSeconds,
          isFocused: session.isFocused,
        })),
      })
      const topApp = daySummaries[0]
      recentDays.push(
        `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}: ` +
        `${formatDuration(dayTotal)} total, focus score ${dayFocusScore}, top app ${topApp?.appName ?? 'n/a'}`,
      )
    }

    const recentFocusContext = buildRecentFocusContext()

    return [
      `User: ${userName}`,
      `Goals: ${goalsStr}`,
      `Daily focus goal: ${goalHours}h target, currently at ${formatDuration(focusSec)} (${goalPct}%)`,
      `Current time: ${timeStr}, ${dayStr}`,
      '',
      todayFocusSessionCount > 0
        ? `Focus sessions today: ${todayFocusSessionCount} session${todayFocusSessionCount > 1 ? 's' : ''}, longest ${formatDuration(longestFocusSession)}, total ${formatDuration(totalFocusSessionSec)}`
        : 'Focus sessions today: none',
      overrideEntries.length > 0
        ? `User has recategorized: ${overrideEntries.map(([id, cat]) => `${id} → ${cat}`).join(', ')}`
        : '',
      '',
      'Data notes:',
      '- App totals are grounded in tracked foreground-window sessions.',
      '- Focus score is derived from focused app categories and may not fully capture productive browser work.',
      '- Website timing comes from local browser evidence and may be approximate.',
      '',
      'Today:',
      `- Total tracked time: ${formatDuration(totalSec)}`,
      `- Focus score: ${focusScore} (${formatDuration(focusSec)} in focused apps)`,
      `- Evidence summary: ${todayEvidence.evidenceText}`,
      `- Top categories: ${topCategoryList || 'none yet'}`,
      `- Top apps: ${topApps || 'none yet'}`,
      `- Top websites: ${topSites || 'none yet'}`,
      '',
      recentDays.length > 0 ? 'Recent days:' : '',
      ...recentDays.map((line) => `- ${line}`),
      '',
      recentFocusContext,
    ]
      .filter((l) => l !== '')
      .join('\n')
  } catch {
    return ''
  }
}

function escapeJsonBlock(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return fenced?.[1]?.trim() ?? raw.trim()
}

function parseWorkBlockInsight(raw: string): WorkContextInsight | null {
  const candidate = escapeJsonBlock(raw)
  try {
    const parsed = JSON.parse(candidate) as { label?: unknown; narrative?: unknown }
    return {
      label: typeof parsed.label === 'string' ? parsed.label.trim() : null,
      narrative: typeof parsed.narrative === 'string' ? parsed.narrative.trim() : null,
    }
  } catch {
    const labelMatch = candidate.match(/label\s*:\s*(.+)/i)
    const narrativeMatch = candidate.match(/narrative\s*:\s*([\s\S]+)/i)
    if (!labelMatch && !narrativeMatch) return null
    return {
      label: labelMatch?.[1]?.trim() ?? null,
      narrative: narrativeMatch?.[1]?.trim() ?? null,
    }
  }
}

function workBlockPrompt(block: WorkContextBlock): string {
  const durationMinutes = Math.max(1, Math.round((block.endTime - block.startTime) / 60_000))

  // Top websites with duration — highest-signal evidence (browser/AI work)
  const websiteLines = block.websites.slice(0, 5).map((site) => {
    const dur = formatDuration(site.totalSeconds)
    const title = site.topTitle ? ` (${site.topTitle.slice(0, 60)})` : ''
    return `  ${site.domain}${title} — ${dur}`
  })

  // Native window titles (non-browser) — document/file context
  const pages = block.keyPages.filter(Boolean).slice(0, 5)

  // Top apps with duration and category
  const appLines = block.topApps.slice(0, 5).map((app) => {
    return `  ${app.appName} (${app.category}) — ${formatDuration(app.totalSeconds)}`
  })

  // Category time breakdown
  const catLines = (Object.entries(block.categoryDistribution) as Array<[string, number]>)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([cat, sec]) => `  ${cat}: ${formatDuration(sec)}`)

  const switchNote = block.switchCount >= 5
    ? `App transitions observed: ${block.switchCount}.`
    : block.switchCount >= 2
      ? `App transitions observed: ${block.switchCount}.`
      : ''

  const lines = [
    'Analyze this Daylens work block.',
    'Return strict JSON: {"label":"...","narrative":"..."}',
    'label: 3-7 word title-case. NEVER return a bare category name ("Browsing", "Development").',
    'narrative: 1-2 plain sentences. Evidence-led, no hype, no "the user" prefix.',
    'Priority rules:',
    '  - Website titles > window titles > app names > category.',
    '  - Browser+AI only ≠ Development → call it Research or Planning.',
    '  - Do NOT return "Building & Testing" without a code editor or terminal in the evidence.',
    '',
    `Duration: ${durationMinutes} minutes`,
    `Dominant category: ${block.dominantCategory}`,
    switchNote,
    '',
    websiteLines.length > 0 ? `Website evidence (highest priority):\n${websiteLines.join('\n')}` : 'Websites: none',
    pages.length > 0 ? `Window titles:\n${pages.map((p) => `  ${p}`).join('\n')}` : 'Window titles: none',
    appLines.length > 0 ? `Apps used:\n${appLines.join('\n')}` : 'Apps: none',
    catLines.length > 0 ? `Category breakdown:\n${catLines.join('\n')}` : '',
    `Rule-based label (override this if evidence supports better): ${userVisibleLabelForBlock(block)}`,
  ].filter(Boolean)

  return lines.join('\n')
}

function parseSuggestedCategory(raw: string): AppCategorySuggestion | null {
  const candidate = escapeJsonBlock(raw)
  try {
    const parsed = JSON.parse(candidate) as { category?: unknown; reason?: unknown }
    const category = typeof parsed.category === 'string' ? parsed.category.trim() : null
    const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : null
    return {
      suggestedCategory: isAppCategory(category) ? category : null,
      reason,
    }
  } catch {
    const normalized = candidate.trim().toLowerCase()
    if (isAppCategory(normalized)) {
      return { suggestedCategory: normalized, reason: null }
    }
    return null
  }
}

function isAppCategory(value: string | null): value is import('@shared/types').AppCategory {
  return value !== null && [
    'development',
    'communication',
    'research',
    'writing',
    'aiTools',
    'design',
    'browsing',
    'meetings',
    'entertainment',
    'email',
    'productivity',
    'social',
    'system',
    'uncategorized',
  ].includes(value)
}

function appCategorySuggestionPrompt(bundleId: string, appName: string): string {
  return [
    'Classify this app into one Daylens category.',
    'Return strict JSON: {"category":"...","reason":"..."}',
    'Allowed categories: development, communication, research, writing, aiTools, design, browsing, meetings, entertainment, email, productivity, social, system, uncategorized',
    'Use uncategorized only if the app identity is genuinely ambiguous.',
    `Bundle or executable: ${bundleId || 'Unknown'}`,
    `App name: ${appName || 'Unknown'}`,
  ].join('\n')
}

export async function suggestAppCategory(bundleId: string, appName: string): Promise<AppCategorySuggestion> {
  const systemPrompt = [
    'You are Daylens.',
    'You classify productivity apps conservatively.',
    'Prefer email for mail clients, communication for chat clients, browsing only for real web browsers.',
    'Return only valid JSON.',
  ].join(' ')

  try {
    const { text } = await sendWithFallback(systemPrompt, [], appCategorySuggestionPrompt(bundleId, appName))
    const parsed = parseSuggestedCategory(text)
    if (parsed?.suggestedCategory) return parsed
  } catch {
    // Fall through to no-suggestion result.
  }

  return {
    suggestedCategory: null,
    reason: null,
  }
}

export async function generateWorkBlockInsight(block: WorkContextBlock): Promise<WorkContextInsight> {
  const systemPrompt = [
    'You are Daylens.',
    'You label productivity timeline blocks from local activity evidence.',
    'Be concrete, restrained, and evidence-led.',
    'Never mention the model provider.',
    'If the evidence is weak, keep the label generic but still useful.',
    'Return only valid JSON.',
  ].join(' ')

  try {
    const { text } = await withTimeout(
      sendWithFallback(systemPrompt, [], workBlockPrompt(block)),
      BLOCK_INSIGHT_TIMEOUT_MS,
      'Block insight timed out',
    )
    const parsed = parseWorkBlockInsight(text)

    const insight = {
      label: parsed?.label || userVisibleLabelForBlock(block),
      narrative: parsed?.narrative || fallbackNarrativeForBlock(block),
    }
    if (!block.isLive) {
      upsertWorkContextInsight(getDb(), {
        startMs: block.startTime,
        endMs: block.endTime,
        insight,
        sourceBlockIds: [block.id],
      })
    }
    return insight
  } catch {
    const insight = {
      label: userVisibleLabelForBlock(block),
      narrative: fallbackNarrativeForBlock(block),
    }
    if (!block.isLive && block.aiLabel) {
      upsertWorkContextInsight(getDb(), {
        startMs: block.startTime,
        endMs: block.endTime,
        insight,
        sourceBlockIds: [block.id],
      })
    }
    return insight
  }
}

export async function sendMessage(userMessage: string): Promise<string> {
  const db = getDb()
  const conversationId = getOrCreateConversation(db)
  const previousContext = conversationTemporalContext.get(conversationId) ?? null

  const routed = await routeInsightsQuestion(userMessage, new Date(), previousContext, db)
  if (routed) {
    appendConversationMessage(db, conversationId, 'user', userMessage)
    appendConversationMessage(db, conversationId, 'assistant', routed.answer)
    conversationTemporalContext.set(conversationId, routed.resolvedContext)
    return routed.answer
  }

  const history = getConversationMessages(db, conversationId)
  // Sanitize prior: remove any trailing user messages (orphaned from a previous
  // failed request under the old code that inserted user messages before the API
  // call). Consecutive user messages at the end would violate the alternating
  // role requirement and cause the API to reject or mishandle the request.
  const prior = history.slice()
  while (prior.length > 0 && prior[prior.length - 1].role === 'user') {
    prior.pop()
  }

  const dayContext = buildDayContext()
  const specificTimeContext = buildSpecificTimeContext(userMessage)
  const { userName } = getSettings()
  const persona = userName
    ? `You are Daylens, a personal productivity coach helping ${userName} understand their time.`
    : `You are Daylens, a personal productivity coach embedded in a local screen-time tracker.`
  const providerConfigs = await resolveProviderConfigs()
  const preferredConfig = providerConfigs[0]
  const systemPrompt =
    persona + ' You have access to tracked local activity data and should answer as a careful analyst, not a hype machine.\n\n' +
    'When answering:\n' +
    '- Always speak as Daylens, never as a generic model or raw provider persona\n' +
    `- If the user asks what model or provider is powering this chat, say that they are chatting with Daylens and that this conversation is currently set to ${providerLabel(preferredConfig.provider)} using the model ${preferredConfig.model}\n` +
    '- Lead with specific tracked facts when available\n' +
    '- Separate tracked facts from interpretation or advice\n' +
    '- If the data is insufficient to answer accurately, say so directly\n' +
    '- Never imply certainty about the exact task the user was doing unless the data explicitly supports it\n' +
    '- For time-specific questions, prefer exact foreground-app evidence and say when no exact session exists\n' +
    '- Treat website timing as approximate browser evidence unless the question is only about websites\n' +
    '- If you include recommendations, clearly label them as suggestions\n' +
    '- Prefer short headings like "Tracked facts" and "Suggestions" when both are present\n' +
    '- Keep responses concise and grounded\n\n' +
    (dayContext
      ? `Tracked local data context:\n${dayContext}`
      : 'No activity has been recorded yet today. If the user asks about stats, say tracking needs more time to collect evidence.') +
    (specificTimeContext ? `\n\nSpecific historical context:\n${specificTimeContext}` : '')

  const { text: assistantText } = await sendWithFallback(systemPrompt, prior, userMessage)

  // Don't save an empty assistant response — it would corrupt future prior
  // history and cause the AI to receive empty content blocks.
  if (!assistantText.trim()) {
    throw new Error('The AI returned an empty response. Please try again.')
  }

  appendConversationMessage(db, conversationId, 'user', userMessage)
  appendConversationMessage(db, conversationId, 'assistant', assistantText)
  conversationTemporalContext.set(conversationId, {
    date: new Date(),
    timeWindow: null,
  })
  return assistantText
}

export function getAIHistory(): { role: 'user' | 'assistant'; content: string }[] {
  const db = getDb()
  const conversationId = getOrCreateConversation(db)
  return getConversationMessages(db, conversationId)
}

export function clearAIHistory(): void {
  const db = getDb()
  const conversationId = getOrCreateConversation(db)
  clearConversation(db, conversationId)
  conversationTemporalContext.delete(conversationId)
}

export async function testCLITool(tool: 'claude' | 'codex'): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  try {
    const expectedToken = `DAYLENS_OK_${Math.random().toString(36).slice(2, 8).toUpperCase()}`
    const output = await runCLIProvider(
      tool,
      `System context:\nYou are a test runner. Reply with exactly ${expectedToken} and nothing else.\n\nUser: Reply with exactly ${expectedToken} and nothing else.`,
    )
    const normalizedOutput = output.trim()
    if (normalizedOutput !== expectedToken) {
      return {
        ok: false,
        error: `Unexpected CLI output: ${normalizedOutput.slice(0, 120) || '(empty response)'}`,
      }
    }
    return { ok: true, output: normalizedOutput }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
