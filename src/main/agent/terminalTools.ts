// run_command: consent-gated READ access to the terminal for the chat agent.
//
// systemTools.ts's "no arbitrary shell" philosophy is deliberately relaxed
// HERE by owner decision (Q9), but with the same posture the git tool set:
//
//   1. Policy gate OUTSIDE the model: settings.terminalAccessEnabled, DEFAULT
//      FALSE. Off → an honest refusal the model can relay, never a prompt.
//   2. Allowlist-first: only a fixed set of read-only inspection binaries may
//      run; git is restricted to the same read-only subcommand allowlist the
//      git tool uses; node/npm are version/listing-only. Obviously destructive
//      argv (rm, sudo, kill, launchctl, git push/reset/clean, ...) is named
//      and refused — this is a capability for the agent to INSPECT its
//      environment, never a write path.
//   3. No shell, ever: execFile with an argv array — no interpolation, no
//      pipes, no redirection. A minimal child env; 15s timeout; 64KB output.
//   4. cwd must resolve inside the user home directory or inside an existing
//      file-access grant root — the same roots the file tools may touch.
//   5. First use per app session raises the SAME in-chat permission card file
//      reads use (the ask_user file_permission path in chatAgent); the user
//      can allow once, allow for the session, or deny.
//   6. Every executed call is logged to the disclosure ledger BEFORE its
//      output is returned toward the model, with the agent's mandatory
//      `reason` — the trail and Settings → Agent file access show why.
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
import { GIT_READ_SUBCOMMANDS, FORBIDDEN_GIT_ARG } from './systemTools'

const execFileAsync = promisify(execFile)

const COMMAND_TIMEOUT_MS = 15_000
const MAX_OUTPUT_BYTES = 64 * 1024

// Read-only inspection binaries. Anything not listed is refused — new
// capabilities are new allowlist entries, reviewed one by one.
const PLAIN_READ_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'stat', 'file', 'du', 'df',
  'uname', 'sw_vers', 'date', 'whoami', 'id', 'which', 'ps', 'uptime',
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
// by the allowlist anyway.
const DESTRUCTIVE_COMMANDS = new Set([
  'rm', 'rmdir', 'unlink', 'sudo', 'su', 'shutdown', 'reboot', 'halt', 'poweroff',
  'mkfs', 'dd', 'kill', 'killall', 'pkill', 'launchctl', 'systemctl', 'crontab',
  'chmod', 'chown', 'chflags', 'mv', 'cp', 'ln', 'curl', 'wget', 'ssh', 'scp',
  'osascript', 'open', 'defaults', 'diskutil', 'nvram', 'shred', 'srm',
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

export type TerminalAccessAnswer = 'allow_once' | 'allow_session' | 'deny'

export interface TerminalToolDeps {
  /** Where the disclosure ledger and file-access grants live. */
  db?: Database.Database
  homeDir?: string
  threadId?: number | null
  /** provider:model the output would be disclosed to. */
  destination?: string
  /** Raises the in-chat permission card (the file_permission path). Absent →
   *  the tool refuses with permissionRequired rather than running silently. */
  requestTerminalAccess?: (request: { command: string; args: string[]; cwd: string; reason: string }) => Promise<TerminalAccessAnswer>
  onDisclosure?: (disclosure: FileDisclosureRow) => void
}

// "Allow for this session" survives turns (tool instances are rebuilt per
// turn) but never the app process.
let sessionApproved = false

export function __resetTerminalSessionApproval(): void {
  sessionApproved = false
}

type ArgvCheck = { ok: true } | { ok: false; reason: string }

/** Allowlist-first argv policy. Exported for direct testing. */
export function checkTerminalArgv(command: string, args: string[]): ArgvCheck {
  if (command.includes('/') || command.includes('\\') || /\s/.test(command)) {
    return { ok: false, reason: 'Use a bare command name from the allowlist — paths are not accepted.' }
  }
  if (DESTRUCTIVE_COMMANDS.has(command)) {
    return { ok: false, reason: `"${command}" is destructive or writes outside this tool's read-only contract, so it is refused.` }
  }
  if (command === 'git') {
    const subcommand = args.find((arg) => !arg.startsWith('-'))
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
    return { ok: true }
  }
  const versionOnly = VERSION_ONLY_ARGS[command]
  if (versionOnly) {
    if (args.length === 1 && versionOnly.has(args[0])) return { ok: true }
    return { ok: false, reason: `"${command}" may only run with: ${[...versionOnly].join(', ')}.` }
  }
  if (PLAIN_READ_COMMANDS.has(command)) return { ok: true }
  return {
    ok: false,
    reason: `"${command}" is not on the read-only allowlist. Allowed: ${[...PLAIN_READ_COMMANDS].sort().join(', ')}, git (read subcommands), node/npm/python3 (--version).`,
  }
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
    const relative = path.relative(realHome, real)
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return { ok: true, real }
  } catch { /* fall through to grants */ }
  if (db) {
    try {
      for (const grant of listFileAccessGrants(db)) {
        const relative = path.relative(path.normalize(grant.path), real)
        if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return { ok: true, real }
      }
    } catch { /* no grants table — home-only */ }
  }
  return { ok: false, reason: 'cwd must be inside your home directory or a folder with an existing file-access grant.' }
}

export function buildTerminalTools(deps: TerminalToolDeps = {}) {
  // "Allow once" covers exactly this turn, like the file tools' set.
  let allowOnceRemaining = 0

  return {
    run_command: tool({
      description: 'Run ONE read-only allowlisted command (ls, cat, head, grep, ps, git log/status/..., node --version, ...) via argv — no shell, no pipes, no redirection, 15s timeout, 64KB output. For inspecting the local environment when the database and file tools cannot answer. Consent-gated: off by default in Settings, and the first use asks the user. The reason you give is shown to the user.',
      inputSchema: z.object({
        command: z.string().min(1).describe('Bare binary name from the allowlist, e.g. "ls" or "git"'),
        args: z.array(z.string()).max(16).optional().describe('Arguments as an argv array — never a shell string'),
        cwd: z.string().min(1).describe('Absolute working directory inside the user home or a granted folder'),
        reason: z.string().min(12).describe('Why the database and file tools cannot answer this — shown verbatim to the user.'),
      }),
      execute: async ({ command, args, cwd, reason }) => {
        // 1. The policy gate, outside the model. Default false.
        if (!getSettings().terminalAccessEnabled) {
          return { found: false, reason: TERMINAL_OFF_REASON }
        }
        const argv = args ?? []
        // 2. Allowlist-first argv policy.
        const argvCheck = checkTerminalArgv(command, argv)
        if (!argvCheck.ok) return { found: false, reason: argvCheck.reason }
        // 3. cwd floor: home dir or an existing grant root.
        const resolvedCwd = await resolveAllowedCwd(cwd, deps.homeDir ?? os.homedir(), deps.db)
        if (!resolvedCwd.ok) return { found: false, reason: resolvedCwd.reason }
        // 4. First use per session pauses the turn on the permission card.
        if (!sessionApproved && allowOnceRemaining <= 0) {
          if (!deps.requestTerminalAccess) {
            return { found: false, permissionRequired: true, reason: PERMISSION_REQUIRED_REASON }
          }
          const answer = await deps.requestTerminalAccess({ command, args: argv, cwd: resolvedCwd.real, reason })
          if (answer === 'allow_session') sessionApproved = true
          else if (answer === 'allow_once') allowOnceRemaining = 1
          else return { found: false, reason: PERMISSION_DENIED_REASON }
        }
        if (!sessionApproved) allowOnceRemaining -= 1

        let stdout = ''
        let stderr = ''
        let failed: string | null = null
        try {
          const result = await execFileAsync(command, argv, {
            cwd: resolvedCwd.real,
            timeout: COMMAND_TIMEOUT_MS,
            maxBuffer: MAX_OUTPUT_BYTES,
            env: minimalChildEnv(),
            shell: false,
          })
          stdout = result.stdout
          stderr = result.stderr
        } catch (error) {
          const errno = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean }
          stdout = errno.stdout ?? ''
          stderr = errno.stderr ?? ''
          failed = errno.killed
            ? `The command was stopped after ${COMMAND_TIMEOUT_MS / 1000}s.`
            : errno.message ?? String(error)
        }
        const truncated = stdout.length > MAX_OUTPUT_BYTES
        stdout = stdout.slice(0, MAX_OUTPUT_BYTES)
        stderr = stderr.slice(0, 4 * 1024)

        // 5. Ledger first, output second: every EXECUTED call records a
        // disclosure row with the agent's reason before anything returns
        // toward the model.
        if (deps.db) {
          try {
            const output = stdout + stderr
            const row = recordFileDisclosure(deps.db, {
              threadId: deps.threadId ?? null,
              filePath: resolvedCwd.real,
              versionFingerprint: fileVersionFingerprint({ size: output.length, mtimeMs: Date.now() }, output),
              excerptStart: 0,
              excerptEnd: output.length,
              reason: `run_command: ${[command, ...argv].join(' ')} — ${reason}`,
              destination: deps.destination ?? 'unknown',
            })
            deps.onDisclosure?.(row)
          } catch { /* a pre-ledger DB never blocks the honest result below */ }
        }

        if (failed) {
          return { found: false, reason: failed, stdout: stdout || undefined, stderr: stderr || undefined }
        }
        return { found: true, command, args: argv, cwd: resolvedCwd.real, stdout, stderr: stderr || undefined, truncated }
      },
    }),
  }
}
