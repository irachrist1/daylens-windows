// run_command: consent-gated READ access to the terminal for the chat agent.
//
// systemTools.ts's "no arbitrary shell" philosophy is deliberately relaxed
// HERE by owner decision (Q9), but with the same posture the git tool set:
//
//   1. Policy gate OUTSIDE the model: settings.terminalAccessEnabled, DEFAULT
//      FALSE. Off → an honest refusal the model can relay, never a prompt —
//      and toggling it off revokes any "allow for this session" approval.
//   2. Allowlist-first: only a fixed set of read-only inspection binaries may
//      run; git is restricted to the same read-only subcommand allowlist the
//      git tool uses (branch is forced to --list, mutating branch flags are
//      refused); node/npm are version/listing-only. Obviously destructive
//      argv (rm, sudo, kill, launchctl, git push/reset/clean, ...) is named
//      and refused — this is a capability for the agent to INSPECT its
//      environment, never a write path.
//   3. No shell, ever: execFile with an argv array — no interpolation, no
//      pipes, no redirection. A minimal child env (plus the no-prompt/no-lock
//      git guards for git); 15s timeout; 64KB output.
//   4. cwd must resolve inside the user home directory or inside an existing
//      MODEL-READABLE file-access grant root — the same roots whose contents
//      the file tools may disclose. An 'indexed' grant never qualifies:
//      indexing does not make content model-readable, and neither does this
//      tool. Path-like ARGUMENTS are pinned to the same root: an argument
//      that looks like a path must realpath-resolve inside the resolved cwd,
//      so `cat /etc/hosts` or `grep -r x ../outside` cannot ride an allowed
//      cwd out of the granted workspace. Conservative by design — the tool
//      inspects the granted workspace, not the filesystem.
//   5. First use per app session raises the SAME in-chat permission card file
//      reads use (the ask_user file_permission path in chatAgent); the user
//      can allow once, allow for the session, or deny. Session approvals are
//      keyed per chat thread when the thread is known, and consent requests
//      are serialized so two parallel calls never race one renderer card.
//   6. Every executed call is logged to the disclosure ledger BEFORE its
//      output is returned toward the model, with the agent's mandatory
//      `reason` and the full command line as the disclosed artifact.
//      Disclosure-before-output is a guarantee: no ledger, no execution; a
//      failed ledger write withholds the output.
import { tool } from 'ai'
import { z } from 'zod'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type Database from 'better-sqlite3'
import { getSettings } from '../services/settings'
import { minimalChildEnv } from '../lib/childEnv'
import { fileVersionFingerprint, listFileAccessGrants, recordFileDisclosure, type FileDisclosureRow } from '../services/fileAccess'
import { GIT_READ_SUBCOMMANDS, FORBIDDEN_GIT_ARG, FORBIDDEN_BRANCH_ARG, GIT_ENV } from './systemTools'

const execFileAsync = promisify(execFile)

const COMMAND_TIMEOUT_MS = 15_000
const MAX_OUTPUT_BYTES = 64 * 1024

// Read-only inspection binaries. Anything not listed is refused — new
// capabilities are new allowlist entries, reviewed one by one. `ps` and `env`
// are deliberately absent: both can exfiltrate other processes' or this
// process's environment (keys, tokens) and carry little inspection value.
const PLAIN_READ_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'stat', 'file', 'du', 'df',
  'uname', 'sw_vers', 'date', 'whoami', 'id', 'which', 'uptime',
  'grep', 'rg', 'pwd', 'hostname',
])
// Version/listing-only binaries: these can execute arbitrary code with the
// wrong args (node -e, npm exec), so only these exact argv shapes run.
const VERSION_ONLY_ARGS: Record<string, ReadonlySet<string>> = {
  node: new Set(['--version', '-v']),
  npm: new Set(['--version', '-v', 'ls']),
  python3: new Set(['--version', '-V']),
}
// Named destructive binaries get an explicit "destructive" refusal (clearer
// than a generic not-allowlisted miss); everything else off-list is refused
// by the allowlist anyway. `ps` and `env` are named here so their refusal
// explains itself instead of reading like an oversight.
const DESTRUCTIVE_COMMANDS = new Set([
  'rm', 'rmdir', 'unlink', 'sudo', 'su', 'shutdown', 'reboot', 'halt', 'poweroff',
  'mkfs', 'dd', 'kill', 'killall', 'pkill', 'launchctl', 'systemctl', 'crontab',
  'chmod', 'chown', 'chflags', 'mv', 'cp', 'ln', 'curl', 'wget', 'ssh', 'scp',
  'osascript', 'open', 'defaults', 'diskutil', 'nvram', 'shred', 'srm',
  'ps', 'env', 'printenv',
])
// Git subcommands that mutate — named so the refusal says "destructive"
// instead of merely "not allowlisted".
const DESTRUCTIVE_GIT_SUBCOMMANDS = new Set([
  'push', 'reset', 'clean', 'checkout', 'restore', 'rebase', 'merge', 'commit',
  'stash', 'gc', 'prune', 'remote', 'fetch', 'pull', 'config', 'am', 'apply', 'worktree',
])

const TERMINAL_OFF_REASON =
  'Terminal access is off. The user can turn it on in Settings → Agent file access (Terminal access). '
  + 'Answer from the activity database and file tools instead.'
const PERMISSION_DENIED_REASON =
  'The user declined to run this command. Answer from the data you already have.'
const PERMISSION_REQUIRED_REASON =
  'Running a command needs the user\'s permission and no permission prompt is available in this run.'
const LEDGER_REQUIRED_REASON =
  'Commands only run when their disclosure can be recorded first, and no disclosure ledger is available here. '
  + 'Answer from the data you already have.'
const LEDGER_WRITE_FAILED_REASON =
  'The command ran, but its disclosure could not be recorded, so the output was withheld. '
  + 'Disclosure-before-output is a guarantee, not best effort.'

export type TerminalAccessAnswer = 'allow_once' | 'allow_session' | 'deny'

export interface TerminalToolDeps {
  /** Where the disclosure ledger and file-access grants live. REQUIRED for
   *  execution: without a ledger, run_command refuses (disclosure-first). */
  db?: Database.Database
  homeDir?: string
  threadId?: number | null
  /** provider:model the output would be disclosed to. */
  destination?: string
  /** Cancels an in-flight child process when the turn is aborted. */
  signal?: AbortSignal
  /** Raises the in-chat permission card (the file_permission path). Absent →
   *  the tool refuses with permissionRequired rather than running silently. */
  requestTerminalAccess?: (request: { command: string; args: string[]; cwd: string; reason: string }) => Promise<TerminalAccessAnswer>
  onDisclosure?: (disclosure: FileDisclosureRow) => void
}

// "Allow for this session" survives turns (tool instances are rebuilt per
// turn) but never the app process, never a Settings toggle-off, and never
// leaks across chat threads: approvals are keyed per thread when the thread
// is known, with a single process-wide key only for thread-less harnesses.
const sessionApprovals = new Set<string>()

export function __resetTerminalSessionApproval(): void {
  sessionApprovals.clear()
}

// The renderer holds ONE consent-card slot. Two parallel run_command calls
// each raising a card would collapse into one visible prompt, so consent
// requests are serialized through a module-level promise chain — one card at
// a time, in arrival order.
let consentQueue: Promise<unknown> = Promise.resolve()
function enqueueConsent<T>(task: () => Promise<T>): Promise<T> {
  const next = consentQueue.then(task, task)
  consentQueue = next.then(() => undefined, () => undefined)
  return next
}

type ArgvCheck = { ok: true; argv: string[] } | { ok: false; reason: string }

/** Allowlist-first argv policy. Returns the argv to EXECUTE (git branch is
 *  forced into --list mode) — never run the raw input. Exported for direct
 *  testing. */
export function checkTerminalArgv(command: string, args: string[]): ArgvCheck {
  if (command.includes('/') || command.includes('\\') || /\s/.test(command)) {
    return { ok: false, reason: 'Use a bare command name from the allowlist — paths are not accepted.' }
  }
  if (DESTRUCTIVE_COMMANDS.has(command)) {
    return { ok: false, reason: `"${command}" is destructive or reads outside this tool's read-only contract, so it is refused.` }
  }
  if (command === 'git') {
    const subcommandIndex = args.findIndex((arg) => !arg.startsWith('-'))
    const subcommand = subcommandIndex >= 0 ? args[subcommandIndex] : undefined
    if (!subcommand) return { ok: false, reason: 'git needs a read-only subcommand (log, show, diff, status, shortlog, branch, rev-parse, describe).' }
    if (DESTRUCTIVE_GIT_SUBCOMMANDS.has(subcommand)) {
      return { ok: false, reason: `"git ${subcommand}" mutates the repository or the network, so it is refused.` }
    }
    if (!GIT_READ_SUBCOMMANDS.has(subcommand)) {
      return { ok: false, reason: `"git ${subcommand}" is not on the read-only allowlist.` }
    }
    if (args.some((arg) => FORBIDDEN_GIT_ARG.test(arg))) {
      return { ok: false, reason: 'A git argument on the deny list was rejected.' }
    }
    // `branch` mutates through flags (-D, -M, -f, --set-upstream-to, ...):
    // same policy as systemTools' git tool — refuse the mutating flags AND
    // force list mode so `git branch <name>` can never create a branch.
    if (subcommand === 'branch') {
      if (args.some((arg) => FORBIDDEN_BRANCH_ARG.test(arg))) {
        return { ok: false, reason: 'A git branch argument on the deny list was rejected.' }
      }
      const argv = [...args]
      argv.splice(subcommandIndex + 1, 0, '--list')
      return { ok: true, argv }
    }
    return { ok: true, argv: args }
  }
  const versionOnly = VERSION_ONLY_ARGS[command]
  if (versionOnly) {
    if (args.length === 1 && versionOnly.has(args[0])) return { ok: true, argv: args }
    return { ok: false, reason: `"${command}" may only run with: ${[...versionOnly].join(', ')}.` }
  }
  if (PLAIN_READ_COMMANDS.has(command)) return { ok: true, argv: args }
  return {
    ok: false,
    reason: `"${command}" is not on the read-only allowlist. Allowed: ${[...PLAIN_READ_COMMANDS].sort().join(', ')}, git (read subcommands), node/npm/python3 (--version).`,
  }
}

function insideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function resolveAllowedCwd(
  requested: string,
  homeDir: string,
  db: Database.Database | undefined,
): Promise<{ ok: true; real: string } | { ok: false; reason: string }> {
  if (!path.isAbsolute(requested)) return { ok: false, reason: 'cwd must be an absolute path.' }
  let real: string
  try {
    real = await fs.realpath(requested)
    if (!(await fs.stat(real)).isDirectory()) return { ok: false, reason: 'cwd is not a directory.' }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  try {
    const realHome = await fs.realpath(homeDir)
    if (insideRoot(realHome, real)) return { ok: true, real }
  } catch { /* fall through to grants */ }
  if (db) {
    try {
      // Only grants whose state makes CONTENT model-readable count as command
      // roots — command output is content. An 'indexed' grant (local
      // extraction only) never escalates into terminal readability.
      for (const grant of listFileAccessGrants(db)) {
        if (grant.state !== 'model_readable') continue
        if (insideRoot(path.normalize(grant.path), real)) return { ok: true, real }
      }
    } catch { /* no grants table — home-only */ }
  }
  return { ok: false, reason: 'cwd must be inside your home directory or a folder with an existing file-access grant.' }
}

/** The path floor for ARGUMENTS: anything path-shaped must realpath-resolve
 *  inside the resolved cwd. Non-path args (flags, patterns, refs) pass
 *  untouched. Conservative by design — an argument that merely LOOKS like a
 *  path (contains '/') is held to the same rule, because refusing an odd
 *  pattern is recoverable and reading /etc/hosts is not. */
export async function checkPathArguments(
  args: string[],
  realCwd: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  for (const arg of args) {
    const pathLike = arg.startsWith('/') || arg.startsWith('~') || arg.startsWith('.') || arg.includes('/')
    if (!pathLike) continue
    if (arg.startsWith('~')) {
      return { ok: false, reason: `"${arg}" was refused: "~" paths are not accepted — use a path inside the working directory.` }
    }
    let real: string
    try {
      real = await fs.realpath(path.resolve(realCwd, arg))
    } catch {
      return { ok: false, reason: `"${arg}" was refused: it does not resolve to an existing path inside the working directory. This tool only inspects the granted workspace.` }
    }
    if (!insideRoot(realCwd, real)) {
      return { ok: false, reason: `"${arg}" was refused: it resolves outside the working directory. This tool only inspects the granted workspace.` }
    }
  }
  return { ok: true }
}

function isMaxBufferError(error: NodeJS.ErrnoException): boolean {
  return error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(error.message ?? '')
}

export function buildTerminalTools(deps: TerminalToolDeps = {}) {
  // "Allow once" covers exactly this turn, like the file tools' set.
  let allowOnceRemaining = 0
  const approvalKey = deps.threadId != null ? `thread:${deps.threadId}` : 'process'
  const approved = () => sessionApprovals.has(approvalKey)

  return {
    run_command: tool({
      description: 'Run ONE read-only allowlisted command (ls, cat, head, grep, git log/status/..., node --version, ...) via argv — no shell, no pipes, no redirection, 15s timeout, 64KB output. Path arguments must stay inside the working directory. For inspecting the local environment when the database and file tools cannot answer. Consent-gated: off by default in Settings, and the first use asks the user. The reason you give is shown to the user.',
      inputSchema: z.object({
        command: z.string().min(1).describe('Bare binary name from the allowlist, e.g. "ls" or "git"'),
        args: z.array(z.string()).max(16).optional().describe('Arguments as an argv array — never a shell string'),
        cwd: z.string().min(1).describe('Absolute working directory inside the user home or a granted folder'),
        reason: z.string().min(12).describe('Why the database and file tools cannot answer this — shown verbatim to the user.'),
      }),
      execute: async ({ command, args, cwd, reason }) => {
        // 1. The policy gate, outside the model. Default false. Turning the
        // setting off revokes every session approval — flipping it back on
        // starts from "ask again", never from a stale yes.
        if (!getSettings().terminalAccessEnabled) {
          sessionApprovals.clear()
          return { found: false, reason: TERMINAL_OFF_REASON }
        }
        // 2. Allowlist-first argv policy. Execute the checked argv (git
        // branch comes back forced into --list mode), never the raw input.
        const argvCheck = checkTerminalArgv(command, args ?? [])
        if (!argvCheck.ok) return { found: false, reason: argvCheck.reason }
        const argv = argvCheck.argv
        // 3. cwd floor: home dir or a model-readable grant root.
        const resolvedCwd = await resolveAllowedCwd(cwd, deps.homeDir ?? os.homedir(), deps.db)
        if (!resolvedCwd.ok) return { found: false, reason: resolvedCwd.reason }
        // 4. Path-like arguments are pinned inside the resolved cwd.
        const pathArgs = await checkPathArguments(argv, resolvedCwd.real)
        if (!pathArgs.ok) return { found: false, reason: pathArgs.reason }
        // 5. Disclosure-before-output is a guarantee: without a ledger there
        // is nowhere to record the disclosure, so nothing runs.
        if (!deps.db) return { found: false, reason: LEDGER_REQUIRED_REASON }
        // 6. First use per session pauses the turn on the permission card.
        // Consent requests are serialized so parallel calls raise their cards
        // one at a time (the renderer holds a single card slot).
        if (!approved() && allowOnceRemaining <= 0) {
          if (!deps.requestTerminalAccess) {
            return { found: false, permissionRequired: true, reason: PERMISSION_REQUIRED_REASON }
          }
          const answer = await enqueueConsent<TerminalAccessAnswer>(async () => {
            // A queued call whose session approval landed while it waited
            // must not raise a second card.
            if (approved()) return 'allow_session'
            return deps.requestTerminalAccess!({ command, args: argv, cwd: resolvedCwd.real, reason })
          })
          if (answer === 'allow_session') sessionApprovals.add(approvalKey)
          else if (answer === 'allow_once') allowOnceRemaining += 1
          else return { found: false, reason: PERMISSION_DENIED_REASON }
        }
        if (!approved()) allowOnceRemaining -= 1

        let stdout = ''
        let stderr = ''
        let failed: string | null = null
        let truncated = false
        try {
          const result = await execFileAsync(command, argv, {
            cwd: resolvedCwd.real,
            timeout: COMMAND_TIMEOUT_MS,
            maxBuffer: MAX_OUTPUT_BYTES,
            // git never prompts for credentials and never takes optional
            // locks — read-only means read-only even for a hung terminal.
            env: minimalChildEnv(command === 'git' ? GIT_ENV : undefined),
            shell: false,
            signal: deps.signal,
          })
          stdout = result.stdout
          stderr = result.stderr
        } catch (error) {
          const errno = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean }
          stdout = errno.stdout ?? ''
          stderr = errno.stderr ?? ''
          if (isMaxBufferError(errno)) {
            // Overflow is a truncation, not a failure: the partial output IS
            // the answer, honestly marked as cut off.
            truncated = true
          } else {
            failed = errno.killed
              ? `The command was stopped after ${COMMAND_TIMEOUT_MS / 1000}s.`
              : errno.message ?? String(error)
          }
        }
        truncated = truncated || stdout.length > MAX_OUTPUT_BYTES
        stdout = stdout.slice(0, MAX_OUTPUT_BYTES)
        stderr = stderr.slice(0, 4 * 1024)

        // 7. Ledger first, output second: every EXECUTED call records a
        // disclosure row — the full command line as the disclosed artifact,
        // located at the resolved cwd, with the agent's reason — before
        // anything returns toward the model. A failed write withholds the
        // output: disclosure-before-output is a guarantee, not best-effort.
        const commandLine = [command, ...argv].join(' ')
        try {
          const output = stdout + stderr
          const row = recordFileDisclosure(deps.db, {
            threadId: deps.threadId ?? null,
            filePath: resolvedCwd.real,
            displayName: commandLine,
            versionFingerprint: fileVersionFingerprint({ size: output.length, mtimeMs: Date.now() }, output),
            excerptStart: 0,
            excerptEnd: output.length,
            reason: `run_command: ${commandLine} — ${reason}`,
            destination: deps.destination ?? 'unknown',
          })
          deps.onDisclosure?.(row)
        } catch {
          return { found: false, reason: LEDGER_WRITE_FAILED_REASON }
        }

        if (failed) {
          return { found: false, reason: failed, stdout: stdout || undefined, stderr: stderr || undefined }
        }
        return { found: true, command, args: argv, cwd: resolvedCwd.real, stdout, stderr: stderr || undefined, truncated }
      },
    }),
  }
}
