// Chat answered by the local Claude Code CLI driving Daylens' own MCP tools.
// Claude Code runs the agent loop; Daylens supplies the tools and the prompt.
//
// Missing versus the in-app agent: citations, context-packet inspection,
// memory writes, correction previews.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getMcpServerConfig } from '../services/mcpServer'
import { abortError } from '../lib/aiCancellation'

/** Claude Code's own turn identity, so a follow-up keeps the thread's context.
 *  In memory only: losing it costs context, never correctness. */
const sessionByThread = new Map<string, string>()

// Claude Code's own tools, none of which a question about the person's day
// needs. Listing them by name is unavoidable — there is no "MCP only" switch —
// so a future Claude Code release can add a tool this list misses. That costs
// context and a wasted turn, never access: --allowedTools still denies it.
const BUILT_IN_TOOLS = [
  'Task', 'Artifact', 'Bash', 'CronCreate', 'CronDelete', 'CronList', 'DesignSync',
  'Edit', 'EnterWorktree', 'ExitWorktree', 'Glob', 'Grep', 'Monitor', 'NotebookEdit',
  'PushNotification', 'Read', 'RemoteTrigger', 'ReportFindings', 'ScheduleWakeup',
  'SendMessage', 'Skill', 'TaskOutput', 'TaskStop', 'TodoWrite', 'ToolSearch',
  'WebFetch', 'WebSearch', 'Write',
]

/** True when this machine can answer chat through Claude Code: the CLI is the
 *  chosen provider and the MCP server it would drive is resolvable. */
export function claudeCodeChatAvailable(): boolean {
  try {
    return getMcpServerConfig() != null
  } catch {
    return false
  }
}

export interface ClaudeCodeChatInput {
  threadId: string
  question: string
  systemPrompt: string
  model: string | null
  executablePath: string
  /** Answer text as it is written. */
  onDelta?: (delta: string) => void | Promise<void>
  /** What the agent is doing while it gathers evidence. The answer only starts
   *  once the tool calls are done, so without this the person watches a blank
   *  for the longest part of the turn. */
  onStatus?: (label: string) => void
  signal?: AbortSignal
  timeoutMs?: number
}

export async function runClaudeCodeChat(input: ClaudeCodeChatInput): Promise<string> {
  const mcp = getMcpServerConfig()
  if (!mcp) throw new Error('The Daylens MCP server could not be located, so Claude Code has no tools to answer with.')
  if (input.signal?.aborted) throw abortError()

  // The CLI reads this file itself; removed in the finally below.
  const configPath = path.join(os.tmpdir(), `daylens-mcp-${randomUUID().slice(0, 8)}.json`)
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: { daylens: { command: mcp.command, args: mcp.args, env: mcp.env } },
  }))

  const resumeSession = sessionByThread.get(input.threadId)
  const args = [
    '-p', input.question,
    // Deltas as they are written, so the answer appears instead of the person
    // watching "Thinking" for half a minute. --verbose is required for
    // stream-json under --print.
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--mcp-config', configPath,
    // Without these the turn loads every plugin, skill and MCP server on the
    // machine: measured at 102k tokens of context for a one-sentence answer,
    // and it blocks on third-party servers that are failing or unauthorised.
    '--strict-mcp-config',
    '--setting-sources', '',
    '--disable-slash-commands',
    // The safety boundary: a tool outside this is denied at execution, which a
    // write probe confirms.
    '--allowedTools', 'mcp__daylens',
    // Denying them as well is about cost, not safety. Permission denial stops
    // the call but the tool is still described to the model, which spends the
    // turn reaching for a Write it cannot have.
    '--disallowedTools', BUILT_IN_TOOLS.join(','),
    // Replaces Claude Code's coding-agent prompt rather than appending to it.
    // Daylens' agent prompt is a complete operating contract, and the default
    // is a large set of instructions about editing files this turn cannot do.
    '--system-prompt', input.systemPrompt,
    ...(input.model ? ['--model', input.model] : []),
    ...(resumeSession ? ['--resume', resumeSession] : []),
  ]

  try {
    return await runStreamingCli(input, args)
  } finally {
    fs.promises.unlink(configPath).catch(() => undefined)
  }
}

interface StreamLine {
  type?: string
  subtype?: string
  session_id?: string
  is_error?: boolean
  result?: string
  event?: { type?: string; delta?: { type?: string; text?: string } }
  message?: { content?: Array<{ type?: string; name?: string }> }
}

const TOOL_STATUS: Record<string, string> = {
  getDaySummary: 'Reading your day',
  getWeekSummary: 'Reading your week',
  getDayComparison: 'Comparing your days',
  getAppUsage: 'Checking time in your apps and sites',
  searchSessions: 'Searching your timeline',
  searchArtifacts: 'Looking through files and pages',
  searchFileMentions: 'Looking for that file',
  getBlockAtTime: 'Looking at that time of day',
  getGitActivity: 'Checking what you committed',
  getCalendarEvents: 'Checking your calendar',
  getAttributionContext: 'Checking who that work was for',
  listClients: 'Checking your clients',
  getWindowTitleContext: 'Reading what was on screen',
  getLongestFocusStretch: 'Finding your longest stretch',
  getDistractionProfile: 'Looking at where focus broke',
  getMostSurprisingFact: 'Looking for what stands out',
}

function statusForTool(toolName: string): string {
  return TOOL_STATUS[toolName.replace(/^mcp__daylens__/, '')] ?? 'Looking through your day'
}

function runStreamingCli(input: ClaudeCodeChatInput, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(input.executablePath, args, {
      // Claude Code reads CLAUDE.md from its cwd; home keeps a chat answer from
      // being steered by whatever repository happens to be open.
      cwd: os.homedir(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let streamed = ''
    let finalResult: string | null = null
    let failure: string | null = null
    let stderr = ''
    let pending = ''
    let settled = false

    const finish = (fn: () => void) => { if (!settled) { settled = true; cleanup(); fn() } }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(() => reject(new Error('Claude Code took too long to answer.')))
    }, input.timeoutMs ?? 180_000)
    const onAbort = () => {
      child.kill('SIGTERM')
      finish(() => reject(abortError()))
    }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    function cleanup() {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', onAbort)
    }

    const handleLine = (line: string) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let parsed: StreamLine
      try {
        parsed = JSON.parse(trimmed) as StreamLine
      } catch {
        return
      }
      if (parsed.session_id) sessionByThread.set(input.threadId, parsed.session_id)

      if (parsed.type === 'stream_event' && parsed.event?.type === 'content_block_delta') {
        const delta = parsed.event.delta
        if (delta?.type === 'text_delta' && delta.text) {
          streamed += delta.text
          void input.onDelta?.(delta.text)
        }
        return
      }
      if (parsed.type === 'assistant' && input.onStatus) {
        for (const part of parsed.message?.content ?? []) {
          if (part.type === 'tool_use' && part.name) input.onStatus(statusForTool(part.name))
        }
        return
      }
      if (parsed.type === 'result') {
        if (parsed.is_error) {
          failure = parsed.subtype
            ? `Claude Code could not finish the answer (${parsed.subtype}).`
            : 'Claude Code returned no answer.'
        } else if (typeof parsed.result === 'string') {
          finalResult = parsed.result.trim()
        }
      }
    }

    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString()
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) handleLine(line)
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', (error) => finish(() => reject(error)))
    child.on('close', (code) => finish(() => {
      if (pending) handleLine(pending)
      if (failure) return reject(new Error(failure))
      // The streamed deltas are what the person already read; the result field
      // is the same text. Preferring the streamed copy keeps the transcript and
      // the screen identical.
      const answer = streamed.trim() || finalResult || ''
      if (code === 0 && answer) return resolve(answer)
      const detail = stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300)
      reject(new Error(detail || `Claude Code exited with code ${code}.`))
    }))
  })
}
