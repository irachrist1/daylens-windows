// Read-only machine tools for the chat agent: file reads, directory
// listings, and an allowlisted read-only git surface ("what did I ship"). No
// write, edit, delete, or arbitrary shell — new capabilities are new tools.
//
// Two layers of policy compose here (DEV-184, agent-runtime-and-context.md
// §File and document access):
//
//   1. The visible-home path FLOOR (resolveVisibleHomePath): the resolved real
//      path must sit inside the user home with no hidden/excluded segment.
//      This always runs first — no grant can resurrect what the floor denies.
//   2. The three-state grant model ABOVE the floor: metadata-level operations
//      (names, sizes, filename matches, repo rankings, git metadata) stay on
//      the floor policy — that is Observed-level information the product
//      already holds. CONTENT-bearing operations (read_file, the
//      content-matching arm of search_files, content-bearing git subcommands)
//      are deny-by-default: they require a covering model-readable grant, or
//      they pause the turn with an in-chat permission request ("Allow once /
//      Allow this folder / Deny"). Every content result records a
//      file_disclosures row BEFORE it is returned toward the model.
import { tool } from 'ai'
import { z } from 'zod'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import type Database from 'better-sqlite3'
import { sanitizeForModel } from '@shared/aiSanitize'
import { getTrackedWindowTitleCorpus } from '../db/queries'
import { minimalChildEnv } from '../lib/childEnv'
import {
  addFileAccessGrant,
  classifyFileSensitivity,
  fileVersionFingerprint,
  recordFileDisclosure,
  resolveFileAccess,
  type FileDisclosureRow,
} from '../services/fileAccess'

const execFileAsync = promisify(execFile)

const MAX_FILE_BYTES = 256 * 1024
const MAX_DIR_ENTRIES = 300
const MAX_GIT_OUTPUT = 64 * 1024
const GIT_TIMEOUT_MS = 15_000
const MAX_REPOSITORIES = 200
const MAX_SCAN_DIRECTORIES = 4_000
const MAX_SEARCH_FILES = 25_000
const MAX_SEARCH_RESULTS = 50
const MAX_SEARCH_FILE_BYTES = 1024 * 1024
const SEARCH_EXCLUDED_DIRECTORIES = new Set([
  'Library', 'AppData', 'Application Data', 'node_modules', '.git', '.ssh', '.gnupg', '.aws', '.config',
  'vendor', 'dist', 'build', 'coverage', 'Cache', 'Caches',
])
const SEARCHABLE_EXTENSIONS = new Set([
  '.txt', '.md', '.mdx', '.rtf', '.csv', '.tsv', '.json', '.yaml', '.yml',
  '.js', '.jsx', '.ts', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.swift', '.c', '.h', '.cpp', '.hpp', '.css', '.scss', '.html', '.xml',
  '.sql', '.sh', '.zsh', '.toml', '.ini', '.log',
])

// Read subcommands only. No config writes, no hooks, no fetch/push, and args
// that redirect output to files, re-point the repository, read files outside
// the repository (`diff --no-index`), or run configured external drivers are
// rejected below.
export const GIT_READ_SUBCOMMANDS = new Set(['log', 'show', 'diff', 'status', 'shortlog', 'branch', 'rev-parse', 'describe'])
export const FORBIDDEN_GIT_ARG = /^(--output|--exec-path|--upload-pack|--receive-pack|-c$|--config|--no-index|--ext-diff|--textconv|--git-dir|--work-tree)/
// `branch` mutates through flags, so it is forced to --list mode and its
// mutating flags are rejected outright.
const FORBIDDEN_BRANCH_ARG = /^(-d$|-D$|--delete|-m$|-M$|--move|-c$|-C$|--copy|-f$|--force|--edit-description|--set-upstream-to|--unset-upstream|-u$)/
// Flags that turn `git log` from metadata into file content (patches).
const GIT_PATCH_ARG = /^(-p$|-u$|--patch|--full-diff|-L)/
// Read-only means read-only even for opportunistic writes: never take
// optional locks (status index refresh) and never prompt for credentials.
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096))
  let suspicious = 0
  for (const byte of sample) {
    if (byte === 0) return true
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious += 1
  }
  return sample.length > 0 && suspicious / sample.length > 0.1
}

export type FileAccessAnswer = 'allow_once' | 'allow_folder' | 'deny'

export interface FileAccessToolContext {
  /** Where grants and disclosures live. Without it, content reads are denied. */
  db?: Database.Database
  threadId?: number | null
  /** provider:model the excerpt would be disclosed to. */
  destination: string
  /** Pause the turn and ask the user. Absent → deny with permissionRequired. */
  requestFileAccess?: (request: { path: string; sizeBytes: number | null; reason: string }) => Promise<FileAccessAnswer>
  /** Observes each recorded disclosure so the turn can surface citations. */
  onDisclosure?: (disclosure: FileDisclosureRow) => void
}

interface SystemToolDeps {
  db?: Database.Database
  homeDir?: string
  fileAccess?: FileAccessToolContext
}

const PERMISSION_REQUIRED_REASON =
  'Reading file contents needs your permission. The file exists and its metadata is visible, '
  + 'but no file-access grant covers it — grant it in the chat prompt or in Settings → Agent file access.'
const PERMISSION_DENIED_REASON =
  'The user declined to open this file. Its name and metadata stay visible, but the contents were not read.'

async function devRoots(homeDir: string): Promise<string[]> {
  const entries = await fs.readdir(homeDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('Dev-'))
    .map((entry) => path.join(homeDir, entry.name))
}

async function discoverGitDirectories(roots: string[]): Promise<string[]> {
  const repositories: string[] = []
  const queue = roots.map((root) => ({ directory: root, depth: 0 }))
  let visited = 0
  while (queue.length > 0 && repositories.length < MAX_REPOSITORIES && visited < MAX_SCAN_DIRECTORIES) {
    const current = queue.shift()
    if (!current) break
    visited += 1
    try {
      const gitPath = path.join(current.directory, '.git')
      const gitStat = await fs.stat(gitPath).catch(() => null)
      if (gitStat?.isDirectory() || gitStat?.isFile()) {
        repositories.push(current.directory)
        continue
      }
      if (current.depth >= 4) continue
      const entries = await fs.readdir(current.directory, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'vendor') continue
        queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 })
      }
    } catch {
      continue
    }
  }
  return repositories
}

function trackedEvidence(db: Database.Database | undefined, fromMs: number, toMs: number): string {
  if (!db) return ''
  try {
    return getTrackedWindowTitleCorpus(db, fromMs, toMs)
  } catch {
    return ''
  }
}

async function repositoryActivity(repoPath: string, since: string, until: string, evidence: string) {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', repoPath, '--no-pager', 'log', '--all', `--since=${since}`, `--until=${until}`, '--format=%ct%x00%an%x00%s'],
    { timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_GIT_OUTPUT, env: minimalChildEnv(GIT_ENV) },
  )
  const commits = stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [timestamp, author, subject] = line.split('\0')
    return { timestamp: Number(timestamp) * 1000, author, subject }
  })
  const repoName = path.basename(repoPath)
  const evidenceMatches = repoName.length >= 3
    ? evidence.split(repoName.toLowerCase()).length - 1
    : 0
  const lastCommitAt = commits.reduce((latest, commit) => Math.max(latest, commit.timestamp), 0) || null
  return {
    name: repoName,
    path: repoPath,
    commitsInRange: commits.length,
    lastCommitAt,
    trackedEvidenceMatches: evidenceMatches,
    recentCommits: commits.slice(0, 20),
  }
}

function containsAllTokens(value: string, tokens: string[]): boolean {
  const normalized = value.toLowerCase()
  return tokens.every((token) => normalized.includes(token))
}

function searchDirectoryAllowed(name: string): boolean {
  return !name.startsWith('.') && !SEARCH_EXCLUDED_DIRECTORIES.has(name)
}

const VISIBLE_HOME_DENIAL =
  'Only visible, non-private folders inside the user home directory are readable. '
  + 'Hidden folders, system data, credentials, dependencies, and build output are excluded.'

// Every machine-read tool shares one path policy: the resolved real path
// (symlinks followed) must sit inside the user home directory and contain no
// hidden or excluded segment. Enforced on the realpath so a symlink inside a
// visible folder cannot reach outside it. This is the deny FLOOR — the grant
// model composes on top and can never widen it.
export async function resolveVisibleHomePath(
  homeDir: string,
  requested: string,
): Promise<{ ok: true; real: string } | { ok: false; reason: string }> {
  if (!path.isAbsolute(requested)) return { ok: false, reason: 'Use an absolute path.' }
  let real: string
  let realHome: string
  try {
    realHome = await fs.realpath(homeDir)
    real = await fs.realpath(requested)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  const relative = path.relative(realHome, real)
  if (relative === '') return { ok: true, real }
  if (relative.startsWith('..') || path.isAbsolute(relative)) return { ok: false, reason: VISIBLE_HOME_DENIAL }
  if (relative.split(path.sep).some((segment) => !searchDirectoryAllowed(segment))) {
    return { ok: false, reason: VISIBLE_HOME_DENIAL }
  }
  return { ok: true, real }
}

async function defaultSearchRoots(homeDir: string): Promise<string[]> {
  const entries = await fs.readdir(homeDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory() && searchDirectoryAllowed(entry.name))
    .map((entry) => path.join(homeDir, entry.name))
}

async function validatedSearchRoots(homeDir: string, requested?: string[]): Promise<string[]> {
  const realHome = await fs.realpath(homeDir)
  const candidates = requested?.length ? requested : await defaultSearchRoots(realHome)
  const roots: string[] = []
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue
    try {
      const real = await fs.realpath(candidate)
      const relative = path.relative(realHome, real)
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue
      if (relative.split(path.sep).some((segment) => !searchDirectoryAllowed(segment))) continue
      if ((await fs.stat(real)).isDirectory()) roots.push(real)
    } catch {
      continue
    }
  }
  return [...new Set(roots)]
}

interface SearchContentPolicy {
  /** Content scanning (and its preview disclosure) only inside granted paths. */
  allowed: (filePath: string) => boolean
  /** Records the disclosure for one content preview BEFORE it is returned. */
  onContentMatch: (
    filePath: string,
    stat: { size: number; mtimeMs: number },
    content: string,
    preview: string,
  ) => void
}

async function searchHomeFiles(
  homeDir: string,
  query: string,
  requestedRoots?: string[],
  contentPolicy?: SearchContentPolicy,
) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  const roots = await validatedSearchRoots(homeDir, requestedRoots)
  const queue = [...roots]
  const matches: Array<{
    path: string
    name: string
    matchedBy: 'name' | 'content'
    preview: string | null
    sizeBytes: number
    modifiedAt: number
  }> = []
  let filesInspected = 0
  let contentSkippedForPermission = 0

  while (queue.length > 0 && filesInspected < MAX_SEARCH_FILES && matches.length < MAX_SEARCH_RESULTS) {
    const directory = queue.shift()
    if (!directory) break
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (matches.length >= MAX_SEARCH_RESULTS || filesInspected >= MAX_SEARCH_FILES) break
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (searchDirectoryAllowed(entry.name)) queue.push(entryPath)
        continue
      }
      if (!entry.isFile()) continue
      if (!searchDirectoryAllowed(entry.name)) continue
      filesInspected += 1
      let stat
      try {
        stat = await fs.stat(entryPath)
      } catch {
        continue
      }
      if (containsAllTokens(entry.name, tokens)) {
        // Filename matches are Observed-level metadata — no grant needed.
        matches.push({
          path: entryPath,
          name: entry.name,
          matchedBy: 'name',
          preview: null,
          sizeBytes: stat.size,
          modifiedAt: stat.mtimeMs,
        })
        continue
      }
      if (stat.size > MAX_SEARCH_FILE_BYTES || !SEARCHABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
      // Content matching discloses file text to the model (the preview line),
      // so it only runs inside a covering model-readable grant.
      if (!contentPolicy) continue
      if (!contentPolicy.allowed(entryPath)) {
        contentSkippedForPermission += 1
        continue
      }
      try {
        const buffer = await fs.readFile(entryPath)
        if (looksBinary(buffer)) continue
        const content = buffer.toString('utf8')
        if (!containsAllTokens(content, tokens)) continue
        const line = content.split(/\r?\n/).find((candidate) => containsAllTokens(candidate, tokens)) ?? ''
        const preview = sanitizeForModel(line.trim().slice(0, 240))
        contentPolicy.onContentMatch(entryPath, stat, content, preview)
        matches.push({
          path: entryPath,
          name: entry.name,
          matchedBy: 'content',
          preview,
          sizeBytes: stat.size,
          modifiedAt: stat.mtimeMs,
        })
      } catch {
        continue
      }
    }
  }

  matches.sort((left, right) => (
    Number(right.matchedBy === 'name') - Number(left.matchedBy === 'name')
    || right.modifiedAt - left.modifiedAt
  ))
  return {
    roots,
    matches,
    filesInspected,
    contentSkippedForPermission,
    truncated: filesInspected >= MAX_SEARCH_FILES || matches.length >= MAX_SEARCH_RESULTS,
  }
}

export function buildSystemTools(deps: SystemToolDeps = {}) {
  const fileCtx = deps.fileAccess
  const grantDb = fileCtx?.db ?? deps.db
  // "Allow once" answers cover exactly this turn: the set lives on the tool
  // instance, which chatAgent builds fresh for every turn.
  const allowOncePaths = new Set<string>()

  type GateResult =
    | { ok: true }
    | { ok: false; result: { found: false; permissionRequired?: boolean; reason: string } }

  /** The content gate: deny-by-default above the path floor. The floor has
   *  ALREADY passed when this runs — the gate can only narrow, never widen. */
  async function ensureModelReadable(
    realPath: string,
    options: { sizeBytes: number | null; reason: string; grantFolderPath?: string },
  ): Promise<GateResult> {
    if (allowOncePaths.has(realPath)) return { ok: true }
    if (!grantDb) {
      return { ok: false, result: { found: false, permissionRequired: true, reason: PERMISSION_REQUIRED_REASON } }
    }
    const decision = resolveFileAccess(grantDb, realPath)
    if (decision.access === 'model_readable') return { ok: true }
    if (decision.access === 'denied') {
      return { ok: false, result: { found: false, reason: decision.reason ?? PERMISSION_REQUIRED_REASON } }
    }
    if (decision.sensitivity === 'high') {
      // High sensitivity needs the explicit Settings permission in addition to
      // access — the in-chat card can never grant it.
      return {
        ok: false,
        result: {
          found: false,
          reason: 'This file looks high-sensitivity. Opening it needs an explicit high-sensitivity permission in Settings → Agent file access.',
        },
      }
    }
    if (!fileCtx?.requestFileAccess) {
      return { ok: false, result: { found: false, permissionRequired: true, reason: PERMISSION_REQUIRED_REASON } }
    }
    const answer = await fileCtx.requestFileAccess({
      path: realPath,
      sizeBytes: options.sizeBytes,
      reason: options.reason,
    })
    if (answer === 'allow_once') {
      allowOncePaths.add(realPath)
      return { ok: true }
    }
    if (answer === 'allow_folder') {
      addFileAccessGrant(grantDb, {
        scopeKind: 'folder',
        path: options.grantFolderPath ?? path.dirname(realPath),
        state: 'model_readable',
        source: 'chat',
      })
      return { ok: true }
    }
    return { ok: false, result: { found: false, reason: PERMISSION_DENIED_REASON } }
  }

  /** Records the disclosure ledger row. MUST run before the content is
   *  returned toward the model. Returns null only when no ledger exists. */
  function disclose(
    filePath: string,
    stat: { size: number; mtimeMs: number },
    content: Buffer | string,
    excerptStart: number,
    excerptEnd: number,
    reason: string,
  ): FileDisclosureRow | null {
    if (!grantDb) return null
    const row = recordFileDisclosure(grantDb, {
      threadId: fileCtx?.threadId ?? null,
      filePath,
      versionFingerprint: fileVersionFingerprint(stat, content),
      excerptStart,
      excerptEnd,
      reason,
      sensitivity: classifyFileSensitivity(filePath),
      destination: fileCtx?.destination ?? 'unknown',
    })
    fileCtx?.onDisclosure?.(row)
    return row
  }

  return {
    read_file: tool({
      description: 'Read a text file from a visible, non-private folder in the user home directory, read-only. Returns up to 256KB. Hidden folders, system data, credentials, dependencies, and build output are excluded, and reading contents requires the user\'s file-access permission (you may be paused to ask). Use absolute paths (the user\'s home is available in the environment note).',
      inputSchema: z.object({
        path: z.string().min(1).describe('Absolute file path inside the user home directory'),
        offsetBytes: z.number().int().min(0).optional(),
      }),
      execute: async ({ path: requestedPath, offsetBytes }) => {
        const resolved = await resolveVisibleHomePath(deps.homeDir ?? os.homedir(), requestedPath)
        if (!resolved.ok) return { found: false, reason: resolved.reason }
        const filePath = resolved.real
        try {
          const stat = await fs.stat(filePath)
          if (!stat.isFile()) return { found: false, reason: 'Not a regular file.' }
          const gate = await ensureModelReadable(filePath, {
            sizeBytes: stat.size,
            reason: 'The answer needs the contents of this file.',
          })
          if (!gate.ok) return gate.result
          const handle = await fs.open(filePath, 'r')
          try {
            const start = Math.min(offsetBytes ?? 0, stat.size)
            const length = Math.min(MAX_FILE_BYTES, stat.size - start)
            const buffer = Buffer.alloc(length)
            await handle.read(buffer, 0, length, start)
            if (looksBinary(buffer)) return { found: false, reason: 'Binary file — not readable as text.' }
            // Ledger first, content second: the disclosure row exists before
            // the excerpt is returned toward the model.
            const disclosure = disclose(
              filePath, stat, buffer, start, start + length,
              'read_file: the answer needed this file\'s contents.',
            )
            return {
              found: true,
              sizeBytes: stat.size,
              truncated: start + length < stat.size,
              versionFingerprint: disclosure?.version_fingerprint ?? null,
              excerptStart: start,
              excerptEnd: start + length,
              content: buffer.toString('utf8'),
            }
          } finally {
            await handle.close()
          }
        } catch (error) {
          return { found: false, reason: error instanceof Error ? error.message : String(error) }
        }
      },
    }),

    list_dir: tool({
      description: 'List a visible, non-private directory in the user home directory, read-only: names, kinds, sizes. Hidden folders, system data, credentials, dependencies, and build output are excluded.',
      inputSchema: z.object({ path: z.string().min(1).describe('Absolute directory path inside the user home directory') }),
      execute: async ({ path: requestedPath }) => {
        const resolved = await resolveVisibleHomePath(deps.homeDir ?? os.homedir(), requestedPath)
        if (!resolved.ok) return { found: false, reason: resolved.reason }
        const dirPath = resolved.real
        try {
          const allEntries = await fs.readdir(dirPath, { withFileTypes: true })
          const entries = allEntries.filter((entry) => searchDirectoryAllowed(entry.name))
          const listed = await Promise.all(entries.slice(0, MAX_DIR_ENTRIES).map(async (entry) => {
            const kind = entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'link' : 'file'
            let sizeBytes: number | null = null
            if (kind === 'file') {
              try {
                sizeBytes = (await fs.stat(path.join(dirPath, entry.name))).size
              } catch {
                sizeBytes = null
              }
            }
            return { name: entry.name, kind, sizeBytes }
          }))
          return { found: true, truncated: entries.length > MAX_DIR_ENTRIES, entries: listed }
        } catch (error) {
          return { found: false, reason: error instanceof Error ? error.message : String(error) }
        }
      },
    }),

    search_files: tool({
      description: 'Search visible, non-private folders in the user home directory by filename, and by text content inside folders the user has granted. Returns current local files with paths and, for granted files, short matching previews. Hidden folders, system data, credentials, dependencies, and build output are excluded.',
      inputSchema: z.object({
        query: z.string().min(2),
        roots: z.array(z.string().min(1)).max(8).optional().describe('Optional absolute folders inside the user home directory'),
      }),
      execute: async ({ query, roots }) => {
        try {
          // Filename matches are metadata (Observed). Content matches return
          // file text to the model, so they only run inside covering
          // model-readable grants, and each preview records a disclosure
          // before the result is returned.
          const contentPolicy: SearchContentPolicy | undefined = grantDb
            ? {
                allowed: (filePath) => {
                  const decision = resolveFileAccess(grantDb, filePath)
                  return decision.access === 'model_readable'
                },
                onContentMatch: (filePath, stat, content, preview) => {
                  const previewStart = Math.max(0, content.indexOf(preview))
                  disclose(
                    filePath, stat, content,
                    previewStart, previewStart + preview.length,
                    'search_files: a matching line was previewed.',
                  )
                },
              }
            : undefined
          const result = await searchHomeFiles(deps.homeDir ?? os.homedir(), query, roots, contentPolicy)
          if (result.matches.length === 0) {
            return { found: false, reason: 'No matching visible local files were found.', ...result }
          }
          return { found: true, ...result }
        } catch (error) {
          return { found: false, reason: error instanceof Error ? error.message : String(error) }
        }
      },
    }),

    discover_repositories: tool({
      description: 'Find repositories under the local Dev-* roots and rank them by commits in the requested date range, recent activity, and matching project names in captured window titles. Use before concluding that no code shipped.',
      inputSchema: z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
      execute: async ({ startDate, endDate }) => {
        const homeDir = deps.homeDir ?? os.homedir()
        const fromMs = new Date(`${startDate}T00:00:00`).getTime()
        const toMs = new Date(`${endDate}T00:00:00`).getTime() + 24 * 60 * 60 * 1000
        if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
          return { found: false, reason: 'Bad date range.' }
        }
        try {
          const roots = await devRoots(homeDir)
          const repoPaths = await discoverGitDirectories(roots)
          const evidence = trackedEvidence(deps.db, fromMs, toMs)
          const inspected = await Promise.all(repoPaths.map(async (repoPath) => {
            try {
              return await repositoryActivity(
                repoPath,
                new Date(fromMs).toISOString(),
                new Date(toMs).toISOString(),
                evidence,
              )
            } catch {
              return null
            }
          }))
          const repositories = inspected
            .filter((repo): repo is NonNullable<typeof repo> => repo != null)
            .sort((left, right) => (
              right.commitsInRange - left.commitsInRange
              || right.trackedEvidenceMatches - left.trackedEvidenceMatches
              || (right.lastCommitAt ?? 0) - (left.lastCommitAt ?? 0)
            ))
          return {
            found: repositories.length > 0,
            roots,
            repositories,
            reason: repositories.length > 0 ? undefined : 'No repositories were found under the Dev-* roots.',
          }
        } catch (error) {
          return { found: false, reason: error instanceof Error ? error.message : String(error) }
        }
      },
    }),

    git: tool({
      description: 'Read-only git against a local repository: log, show, diff, status, shortlog, branch, rev-parse, describe. Use for "what did I ship" — e.g. subcommand "log" with args ["--since=2026-07-01", "--oneline", "--author=..."]. Content-bearing subcommands (show, diff, log with a patch flag) need the user\'s file-access permission for the repository. Never mutates.',
      inputSchema: z.object({
        repoPath: z.string().min(1).describe('Absolute path to the repository'),
        subcommand: z.string().min(1).describe('One of: log, show, diff, status, shortlog, branch, rev-parse, describe'),
        args: z.array(z.string()).max(12).optional().describe('Extra arguments, e.g. ["--since=1 month ago", "--oneline"]'),
      }),
      execute: async ({ repoPath, subcommand, args }) => {
        if (!GIT_READ_SUBCOMMANDS.has(subcommand)) {
          return { found: false, reason: `Subcommand "${subcommand}" is not on the read-only allowlist.` }
        }
        const extraArgs = args ?? []
        if (extraArgs.some((arg) => FORBIDDEN_GIT_ARG.test(arg))) {
          return { found: false, reason: 'An argument on the deny list was rejected.' }
        }
        if (subcommand === 'branch' && extraArgs.some((arg) => FORBIDDEN_BRANCH_ARG.test(arg))) {
          return { found: false, reason: 'An argument on the deny list was rejected.' }
        }
        const resolved = await resolveVisibleHomePath(deps.homeDir ?? os.homedir(), repoPath)
        if (!resolved.ok) return { found: false, reason: resolved.reason }
        repoPath = resolved.real
        // Metadata git (log/status/shortlog/branch/rev-parse/describe) stays on
        // the floor policy. `show`/`diff` — and `log` once a patch flag makes
        // it content-bearing — reveal file contents, so they need a covering
        // model-readable grant on the repository.
        const contentBearing = subcommand === 'show' || subcommand === 'diff'
          || (subcommand === 'log' && extraArgs.some((arg) => GIT_PATCH_ARG.test(arg)))
        if (contentBearing) {
          const gate = await ensureModelReadable(repoPath, {
            sizeBytes: null,
            reason: `git ${subcommand} discloses file contents from this repository.`,
            grantFolderPath: repoPath,
          })
          if (!gate.ok) return gate.result
        }
        const subcommandArgs = subcommand === 'branch' ? ['branch', '--list', ...extraArgs] : [subcommand, ...extraArgs]
        try {
          const { stdout } = await execFileAsync(
            'git',
            ['-C', repoPath, '--no-pager', ...subcommandArgs],
            { timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_GIT_OUTPUT, env: minimalChildEnv(GIT_ENV) },
          )
          const trimmed = stdout.length > MAX_GIT_OUTPUT ? `${stdout.slice(0, MAX_GIT_OUTPUT)}\n…(truncated)` : stdout
          if (contentBearing) {
            disclose(
              repoPath,
              { size: trimmed.length, mtimeMs: Date.now() },
              trimmed,
              0,
              trimmed.length,
              `git ${subcommand}: repository content was disclosed.`,
            )
          }
          return { found: true, output: trimmed }
        } catch (error) {
          return { found: false, reason: error instanceof Error ? error.message : String(error) }
        }
      },
    }),
  }
}
