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
import { buildAssistantEvidencePack } from '../core/query/assistantEvidence'
import { resolveDayContext, findClientByName, resolveClientQuery } from '../core/query/attributionResolvers'
import { invalidateProjectionScope } from '../core/projections/invalidation'
import { getDb } from './database'
import { getSettings } from './settings'
import { computeEnhancedFocusScore } from '../lib/focusScore'
import type { AppCategorySuggestion, DayTimelinePayload, WorkContextBlock, WorkContextInsight } from '@shared/types'
import { executeTextAIJob, modelForProvider, providerLabel, type ProviderTextResponse, type ResolvedProviderConfig } from './aiOrchestration'
import {
  fallbackNarrativeForBlock,
  getTimelineDayPayload,
  getWorkflowSummaries,
  userVisibleLabelForBlock,
} from './workBlocks'

const GOOGLE_CLIENT_HEADER = 'daylens-windows/1.0.0'
const BLOCK_INSIGHT_TIMEOUT_MS = 12_000

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

function openAIInputFromHistory(messages: ConversationMessage[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }))
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
): Promise<ProviderTextResponse> {
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

  return {
    text: response.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join(''),
    usage: {
      inputTokens: response.usage.input_tokens ?? null,
      outputTokens: response.usage.output_tokens ?? null,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? null,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? null,
    },
  }
}

async function sendWithOpenAI(
  config: ResolvedProviderConfig,
  systemPrompt: string,
  prior: ConversationMessage[],
  userMessage: string,
): Promise<ProviderTextResponse> {
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

  return {
    text: response.output_text || '',
    usage: {
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
      cacheReadTokens: response.usage?.input_tokens_details?.cached_tokens ?? null,
      cacheWriteTokens: null,
    },
  }
}

async function sendWithGoogle(
  config: ResolvedProviderConfig,
  systemPrompt: string,
  prior: ConversationMessage[],
  userMessage: string,
): Promise<ProviderTextResponse> {
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
  return {
    text,
    usage: null,
  }
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
): Promise<ProviderTextResponse> {
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
      return {
        text: await runCLIProvider(config.provider === 'claude-cli' ? 'claude' : 'codex', cliPrompt, config.model),
        usage: null,
      }
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

function buildTodayBlocksContext(): string {
  try {
    const db = getDb()
    const now = new Date()
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    const dateStr = `${year}-${month}-${day}`
    const payload = getTimelineDayPayload(db, dateStr, null)

    // Only non-trivial blocks (>= 3 min). If nothing non-trivial, still show a short line.
    const blocks = payload.blocks.filter((b) => b.endTime - b.startTime >= 3 * 60_000)
    if (blocks.length === 0) return ''

    const lines = blocks.slice(0, 12).map((block) => {
      const minutes = Math.max(1, Math.round((block.endTime - block.startTime) / 60_000))
      const label = userVisibleLabelForBlock(block)
      const timeRange = `${formatClock(block.startTime)}-${formatClock(block.endTime)}`
      const topApps = block.topApps
        .filter((app) => app.category !== 'system')
        .slice(0, 3)
        .map((app) => app.appName)
      const topSites = block.websites
        .slice(0, 3)
        .map((site) => site.domain.replace(/^www\./, ''))
      const keyPage = block.keyPages.find((t) => t.trim().length > 0)

      const parts = [
        `${timeRange} (${minutes}m) — ${label}`,
      ]
      if (topApps.length > 0) parts.push(`apps: ${topApps.join(', ')}`)
      if (topSites.length > 0) parts.push(`sites: ${topSites.join(', ')}`)
      if (keyPage) parts.push(`key: ${keyPage.slice(0, 80)}`)
      if (block.label.override) parts.push(`user labeled: ${block.label.override}`)
      return `- ${parts.join(' • ')}`
    })

    return ['Today\'s work blocks (chronological):', ...lines].join('\n')
  } catch {
    return ''
  }
}

function buildWorkflowsContext(): string {
  try {
    const db = getDb()
    const workflows = getWorkflowSummaries(db, 14)
    const meaningful = workflows.filter((w) => w.occurrenceCount >= 2).slice(0, 6)
    if (meaningful.length === 0) return ''

    const lines = meaningful.map((w) => {
      const apps = w.canonicalApps.slice(0, 4).join(' + ')
      return `- "${w.label}" (${w.dominantCategory}): ${w.occurrenceCount}× in last 14 days${apps ? ` — ${apps}` : ''}`
    })
    return ['Recurring workflows (last 14 days):', ...lines].join('\n')
  } catch {
    return ''
  }
}

function buildHourlyShapeContext(sessions: { startTime: number; durationSeconds: number; category: string }[]): string {
  if (sessions.length === 0) return ''
  // Build a coarse morning / midday / afternoon / evening profile from today's sessions.
  const buckets: Record<string, Map<string, number>> = {
    morning: new Map(),   // 5-11
    midday: new Map(),    // 11-14
    afternoon: new Map(), // 14-18
    evening: new Map(),   // 18-23
    night: new Map(),     // 23-5
  }
  for (const s of sessions) {
    const hour = new Date(s.startTime).getHours()
    const bucket =
      hour >= 5 && hour < 11 ? 'morning'
      : hour >= 11 && hour < 14 ? 'midday'
      : hour >= 14 && hour < 18 ? 'afternoon'
      : hour >= 18 && hour < 23 ? 'evening'
      : 'night'
    const current = buckets[bucket].get(s.category) ?? 0
    buckets[bucket].set(s.category, current + s.durationSeconds)
  }
  const parts: string[] = []
  for (const [name, map] of Object.entries(buckets)) {
    if (map.size === 0) continue
    const topCat = [...map.entries()].sort((a, b) => b[1] - a[1])[0]
    if (!topCat || topCat[1] < 300) continue // skip buckets with < 5 min
    parts.push(`${name}: mostly ${topCat[0]} (${formatDuration(topCat[1])})`)
  }
  if (parts.length === 0) return ''
  return `Time-of-day shape: ${parts.join('; ')}`
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

function buildStructuredEvidenceContext(): string {
  try {
    const now = new Date()
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const db = getDb()
    const pack = buildAssistantEvidencePack(db, dateStr)

    const dayCtx = resolveDayContext(dateStr, db)
    const workSessions = dayCtx.sessions.slice(0, 12).map((s) => ({
      id: s.work_session_id,
      start: s.start,
      end: s.end,
      duration_ms: s.duration_ms,
      active_ms: s.active_ms,
      client: s.client,
      project: s.project,
      confidence: s.confidence,
      apps: s.apps.slice(0, 5),
      evidence: s.evidence.slice(0, 5),
    }))

    return JSON.stringify({
      date: pack.date,
      generatedAt: pack.generatedAt,
      totals: pack.totals,
      attribution_summary: {
        captured_ms: dayCtx.day_summary.captured_ms,
        active_ms: dayCtx.day_summary.active_ms,
        attributed_ms: dayCtx.day_summary.attributed_ms,
        ambiguous_ms: dayCtx.day_summary.ambiguous_ms,
        unattributed_ms: dayCtx.day_summary.unattributed_ms,
      },
      work_sessions: workSessions,
      topApps: pack.topApps.map((app) => ({
        appName: app.appName,
        category: app.category,
        totalSeconds: app.totalSeconds,
        canonicalAppId: app.canonicalAppId ?? null,
      })),
      topWebsites: pack.topWebsites.map((site) => ({
        domain: site.domain,
        totalSeconds: site.totalSeconds,
        topTitle: site.topTitle,
      })),
      blocks: pack.timeline.blocks,
      workflows: pack.workflows.map((workflow) => ({
        label: workflow.label,
        dominantCategory: workflow.dominantCategory,
        occurrenceCount: workflow.occurrenceCount,
        canonicalApps: workflow.canonicalApps,
      })),
      focusSessions: pack.focusSessions.map((session) => ({
        label: session.label,
        durationSeconds: session.durationSeconds,
        targetMinutes: session.targetMinutes ?? null,
        plannedApps: session.plannedApps,
      })),
      appSpotlights: pack.appSpotlights.map((app) => ({
        displayName: app.displayName,
        totalSeconds: app.totalSeconds,
        topArtifacts: app.topArtifacts.slice(0, 4).map((artifact) => artifact.displayTitle),
        pairedApps: app.pairedApps.slice(0, 4).map((entry) => entry.displayName),
        workflows: app.workflowAppearances.slice(0, 4).map((workflow) => workflow.label),
      })),
      ambiguous_segments: dayCtx.ambiguous_segments.slice(0, 5),
      caveats: [
        ...pack.caveats,
        'work_sessions are attributed via the pipeline; always separate attributed from ambiguous time.',
        'When answering "how many hours on X", use work_sessions with client/project fields — not raw app totals.',
      ],
    }, null, 2)
  } catch {
    return ''
  }
}

function buildAttributionDayContext(dateStr: string): string {
  try {
    const payload = resolveDayContext(dateStr, getDb())
    if (payload.sessions.length === 0) return ''
    return JSON.stringify(payload, null, 2)
  } catch {
    return ''
  }
}

function buildAttributionClientContext(userMessage: string): string {
  try {
    const clientMatch = userMessage.match(
      /(?:hours?\s+(?:on|for|with|at)\s+|client\s+|project\s+)['"]?([A-Za-z][\w\s&.-]{1,40})['"]?/i,
    )
    if (!clientMatch) return ''
    const db = getDb()
    const client = findClientByName(clientMatch[1].trim(), db)
    if (!client) return ''

    const now = new Date()
    const weekAgo = new Date(now)
    weekAgo.setDate(weekAgo.getDate() - 7)
    weekAgo.setHours(0, 0, 0, 0)
    const payload = resolveClientQuery(
      client.id, weekAgo.getTime(), now.getTime(),
      userMessage, db,
    )
    if (!payload) return ''
    return JSON.stringify(payload, null, 2)
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
    const todayBlocksContext = buildTodayBlocksContext()
    const workflowsContext = buildWorkflowsContext()
    const structuredEvidenceContext = buildStructuredEvidenceContext()
    const hourlyShapeContext = buildHourlyShapeContext(
      todaySessions.map((s) => ({
        startTime: s.startTime,
        durationSeconds: s.durationSeconds,
        category: s.category,
      })),
    )

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
      'Today (totals):',
      `- Total tracked time: ${formatDuration(totalSec)}`,
      `- Focus score: ${focusScore} (${formatDuration(focusSec)} in focused apps)`,
      `- Evidence summary: ${todayEvidence.evidenceText}`,
      `- Top categories: ${topCategoryList || 'none yet'}`,
      `- Top apps: ${topApps || 'none yet'}`,
      `- Top websites: ${topSites || 'none yet'}`,
      hourlyShapeContext ? `- ${hourlyShapeContext}` : '',
      '',
      todayBlocksContext,
      '',
      workflowsContext,
      '',
      recentDays.length > 0 ? 'Recent days (trend):' : '',
      ...recentDays.map((line) => `- ${line}`),
      '',
      recentFocusContext,
      structuredEvidenceContext ? 'Structured evidence pack (JSON):' : '',
      structuredEvidenceContext,
      '',
      'Data notes:',
      '- App totals come from tracked foreground-window sessions — reliable.',
      '- Work blocks are segmented by the local heuristic; labels may be rule-based or AI-generated.',
      '- Website timing comes from local browser evidence and may undercount background tabs.',
      '- Focus score weights focused categories (development, writing, design, etc.); browser work may be productive but read as unfocused.',
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

// Cache AI category suggestions to avoid re-sending identical classification requests.
// Keyed by "bundleId::appName" (lowercased). Survives for the lifetime of the process.
const _categorySuggestionCache = new Map<string, AppCategorySuggestion>()

export async function suggestAppCategory(bundleId: string, appName: string): Promise<AppCategorySuggestion> {
  const cacheKey = `${bundleId}::${appName}`.toLowerCase()
  const cached = _categorySuggestionCache.get(cacheKey)
  if (cached) return cached

  const systemPrompt = [
    'You are Daylens.',
    'You classify productivity apps conservatively.',
    'Prefer email for mail clients, communication for chat clients, browsing only for real web browsers.',
    'Return only valid JSON.',
  ].join(' ')

  try {
    const { text } = await executeTextAIJob(
      {
        jobType: 'attribution_assist',
        screen: 'background',
        triggerSource: 'system',
        systemPrompt,
        userMessage: appCategorySuggestionPrompt(bundleId, appName),
      },
      sendWithProvider,
    )
    const parsed = parseSuggestedCategory(text)
    if (parsed?.suggestedCategory) {
      _categorySuggestionCache.set(cacheKey, parsed)
      return parsed
    }
  } catch {
    // Fall through to no-suggestion result.
  }

  const noSuggestion: AppCategorySuggestion = { suggestedCategory: null, reason: null }
  _categorySuggestionCache.set(cacheKey, noSuggestion)
  return noSuggestion
}

export async function generateWorkBlockInsight(
  block: WorkContextBlock,
  options?: { jobType?: 'block_label_preview' | 'block_label_finalize' | 'block_cleanup_relabel'; triggerSource?: 'system' | 'background' },
): Promise<WorkContextInsight> {
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
      executeTextAIJob(
        {
          jobType: options?.jobType ?? (block.isLive ? 'block_label_preview' : 'block_label_finalize'),
          screen: 'timeline_day',
          triggerSource: options?.triggerSource ?? (block.isLive ? 'system' : 'background'),
          systemPrompt,
          userMessage: workBlockPrompt(block),
        },
        sendWithProvider,
      ),
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

const queuedBlockInsightJobs = new Set<string>()
let lastCleanupAnchorDate: string | null = null
const BLOCK_FINALIZE_QUIET_MS = 90_000
const CLEANUP_LOOKBACK_DAYS = 3
const CLEANUP_BLOCK_LIMIT = 8

function shiftDateString(dateStr: string, offset: number): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  const next = new Date(year, month - 1, day)
  next.setDate(next.getDate() + offset)
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`
}

async function runBlockInsightJob(
  block: WorkContextBlock,
  jobType: 'block_label_finalize' | 'block_cleanup_relabel',
): Promise<void> {
  if (queuedBlockInsightJobs.has(`${jobType}:${block.id}`)) return
  queuedBlockInsightJobs.add(`${jobType}:${block.id}`)

  try {
    await generateWorkBlockInsight(block, { jobType, triggerSource: 'background' })
    invalidateProjectionScope('timeline', `ai:${jobType}`)
    invalidateProjectionScope('apps', `ai:${jobType}`)
    invalidateProjectionScope('insights', `ai:${jobType}`)
  } catch (error) {
    console.warn(`[ai] ${jobType} failed for block ${block.id}:`, error)
  } finally {
    queuedBlockInsightJobs.delete(`${jobType}:${block.id}`)
  }
}

async function runOvernightCleanup(anchorDate: string): Promise<void> {
  const settings = getSettings()
  if (!settings.aiBackgroundEnrichment) return

  const db = getDb()
  const queued: WorkContextBlock[] = []
  for (let offset = 0; offset > -CLEANUP_LOOKBACK_DAYS; offset--) {
    const dateStr = shiftDateString(anchorDate, offset)
    const payload = getTimelineDayPayload(db, dateStr, null)
    for (const block of payload.blocks) {
      if (block.isLive) continue
      if (block.label.override?.trim()) continue
      if (block.aiLabel?.trim()) continue
      queued.push(block)
      if (queued.length >= CLEANUP_BLOCK_LIMIT) break
    }
    if (queued.length >= CLEANUP_BLOCK_LIMIT) break
  }

  for (const block of queued) {
    await runBlockInsightJob(block, 'block_cleanup_relabel')
  }
}

export function scheduleTimelineAIJobs(payload: DayTimelinePayload): void {
  const settings = getSettings()
  if (!settings.aiBackgroundEnrichment) return

  const now = Date.now()
  for (const block of payload.blocks) {
    if (block.isLive) continue
    if (block.label.override?.trim()) continue
    if (block.aiLabel?.trim()) continue
    if (now - block.endTime < BLOCK_FINALIZE_QUIET_MS) continue
    void runBlockInsightJob(block, 'block_label_finalize')
  }

  if (lastCleanupAnchorDate === payload.date) return
  lastCleanupAnchorDate = payload.date
  void runOvernightCleanup(payload.date)
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
  const now = new Date()
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const attributionDayCtx = buildAttributionDayContext(todayStr)
  const attributionClientCtx = buildAttributionClientContext(userMessage)
  const settings = getSettings()
  const { userName } = settings
  const persona = userName
    ? `You are Daylens, a personal productivity coach helping ${userName} understand their time.`
    : `You are Daylens, a personal productivity coach embedded in a local screen-time tracker.`
  const preferredProvider = settings.aiChatProvider ?? settings.aiProvider ?? 'anthropic'
  const preferredConfig = {
    provider: preferredProvider,
    model: modelForProvider(preferredProvider, settings),
  }
  const systemPrompt =
    persona + ' You have access to tracked local activity data — app sessions, website visits, attributed work sessions, and recurring workflows.\n\n' +
    'Your job is to synthesize, not recite. The user can already see raw totals in the UI. They come to you to understand what the day actually looked like and what was getting done.\n\n' +
    'How to think:\n' +
    '- Work sessions are the primary data unit. Each has a client, project, confidence score, app roles, and evidence trail. Use these to answer "what was I working on" and "how much time on X".\n' +
    '- For client/project questions, use attributed work_sessions. Report attributed hours first, then ambiguous time separately. Never silently include ambiguous time in attributed totals.\n' +
    '- Read the work-block structure for additional context. Blocks group related activity with labels, apps, and websites.\n' +
    '- Connect apps to intent: Chrome + docs.google.com + a specific title probably means a specific document; Cursor + GitHub likely means code on a specific repo; Slack + a long block means a conversation thread.\n' +
    '- Notice patterns: recurring workflows show habitual projects or rituals. Time-of-day shape shows when the user focuses vs. communicates.\n' +
    '- Prefer the specific over the generic. "Drafted the Q2 planning doc in Google Docs around 10-11am, then switched to Slack for 30m" beats "You spent 2h in Chrome."\n' +
    '- When the evidence is ambiguous, say "looks like" or "probably" rather than inventing specifics. Don\'t hallucinate project names or document titles that aren\'t in the evidence.\n\n' +
    'How to write:\n' +
    '- Conversational, grounded, slightly social — a thoughtful friend who reviewed your day, not a dashboard.\n' +
    '- Lead with the story of the day (what the user was doing and when), then surface totals only if the user asked or if a number matters.\n' +
    '- Keep it short. 2-5 sentences for most questions. Use bullet points only when listing distinct blocks or suggestions.\n' +
    '- Reference block time ranges and labels when they add specificity: "between 9:30 and 11:00 you were in a research block on arxiv and Claude".\n' +
    '- Never say "the user" — address them directly ("you").\n' +
    '- Always speak as Daylens, never as a raw model/provider persona.\n' +
    `- If asked what model is powering this chat: say you are Daylens, currently routed through ${providerLabel(preferredConfig.provider)} (${preferredConfig.model}).\n` +
    '- If the data genuinely doesn\'t answer the question, say so plainly and offer what you can infer.\n' +
    '- For recommendations, keep them concrete and tied to observed patterns — not generic productivity advice.\n\n' +
    (dayContext
      ? `Tracked local data context:\n${dayContext}`
      : 'No activity has been recorded yet today. If the user asks about stats, say tracking needs more time to collect evidence.') +
    (specificTimeContext ? `\n\nSpecific historical context:\n${specificTimeContext}` : '') +
    (attributionDayCtx ? `\n\nAttribution-layer work sessions (JSON):\n${attributionDayCtx}` : '') +
    (attributionClientCtx ? `\n\nClient/project attribution context (JSON):\n${attributionClientCtx}` : '')

  const { text: assistantText } = await executeTextAIJob(
    {
      jobType: 'chat_answer',
      screen: 'ai_chat',
      triggerSource: 'user',
      systemPrompt,
      userMessage,
      prior,
    },
    sendWithProvider,
  )

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
