// Chat answered by the local Claude Code CLI driving Daylens' own MCP tools.
// Claude Code runs the agent loop; Daylens supplies the tools and the prompt.
//
// Missing versus the in-app agent: citations, context-packet inspection,
// memory writes, correction previews, token streaming. The answer arrives
// whole.
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

/** True when this machine can answer chat through Claude Code: the CLI is the
 *  chosen provider and the MCP server it would drive is resolvable. */
export function claudeCodeChatAvailable(): boolean {
  try {
    return getMcpServerConfig() != null
  } catch {
    return false
  }
}

interface ClaudeCodeJsonResult {
  result?: unknown
  session_id?: unknown
  is_error?: unknown
  subtype?: unknown
}

export async function runClaudeCodeChat(input: {
  threadId: string
  question: string
  systemPrompt: string
  model: string | null
  executablePath: string
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<string> {
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
    '--output-format', 'json',
    '--mcp-config', configPath,
    // The Daylens server and nothing else: no file edits, no shell, no network.
    '--allowedTools', 'mcp__daylens',
    '--append-system-prompt', input.systemPrompt,
    ...(input.model ? ['--model', input.model] : []),
    ...(resumeSession ? ['--resume', resumeSession] : []),
  ]

  try {
    const raw = await runCli(input.executablePath, args, input.signal, input.timeoutMs ?? 180_000)
    let parsed: ClaudeCodeJsonResult
    try {
      parsed = JSON.parse(raw) as ClaudeCodeJsonResult
    } catch {
      // A CLI that answered in plain prose still answered.
      return raw.trim()
    }
    if (typeof parsed.session_id === 'string' && parsed.session_id) {
      sessionByThread.set(input.threadId, parsed.session_id)
    }
    const text = typeof parsed.result === 'string' ? parsed.result.trim() : ''
    if (parsed.is_error === true || !text) {
      throw new Error(
        typeof parsed.subtype === 'string' && parsed.subtype
          ? `Claude Code could not finish the answer (${parsed.subtype}).`
          : 'Claude Code returned no answer.',
      )
    }
    return text
  } finally {
    fs.promises.unlink(configPath).catch(() => undefined)
  }
}

function runCli(
  executablePath: string,
  args: string[],
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executablePath, args, {
      // Claude Code reads CLAUDE.md from its cwd; home keeps a chat answer from
      // being steered by whatever repository happens to be open.
      cwd: os.homedir(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn: () => void) => { if (!settled) { settled = true; cleanup(); fn() } }

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(() => reject(new Error('Claude Code took too long to answer.')))
    }, timeoutMs)

    const onAbort = () => {
      child.kill('SIGTERM')
      finish(() => reject(abortError()))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    function cleanup() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', (error) => finish(() => reject(error)))
    child.on('close', (code) => finish(() => {
      if (code === 0) return resolve(stdout)
      const detail = stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300)
      reject(new Error(detail || `Claude Code exited with code ${code}.`))
    }))
  })
}
