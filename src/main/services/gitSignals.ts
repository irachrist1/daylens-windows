// Git connector — what the user actually SHIPPED today.
//
// Scans the usual development roots for git repositories, reads each repo's
// commit log for the target date (authored by the repo's configured user), and
// asks the gh CLI for PR activity when it is installed and authenticated. This
// turns "4 hours in Cursor" into "wrote 9 commits to the billing service and
// opened a PR."
//
// Local reads only; the single network touch is gh, which is the user's own
// authenticated CLI. The connector's result contract distinguishes two very
// different "nothing"s for the scan ledger (externalSignals.ts): git being
// UNAVAILABLE throws (the day was never actually checked and stays
// collectable), while a day with no commits and no PRs returns null ("ran,
// found nothing" — safe to remember as empty). The caller
// (collectExternalSignals) catches the throw and the wrap proceeds without
// the signal either way.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { GitActivitySignal, GitPRActivity, GitRepoActivity } from '@shared/types'

const GIT_TIMEOUT_MS = 4_000
const GH_TIMEOUT_MS = 10_000
const MAX_REPOS = 40
const MAX_SCAN_DEPTH = 3
const MAX_DIRS_PER_ROOT = 500
const MAX_MESSAGES_PER_REPO = 12
const MAX_MESSAGE_LENGTH = 120

/** Directory names that never contain the user's own repos. */
const SKIP_DIR_NAMES = new Set([
  'node_modules', 'library', 'applications', 'pictures', 'music', 'movies',
  'downloads', '.trash', 'vendor', 'dist', 'build', 'out', 'target',
  '.cache', '.npm', '.cargo', '.rustup', '.gradle', '.m2', 'venv', '.venv',
])

/** HOME children that look like development roots: "Dev", "Dev-Personal",
 *  "Projects", "code", "workspace-acme", and Visual Studio's default
 *  "source" (C:\Users\<name>\source\repos). */
const DEV_ROOT_RE = /^(dev|develop|developer|development|projects?|code|coding|source|src|repos?|git|github|work|workspaces?)([-_ ].*)?$/i

function exec(cmd: string, args: string[], timeoutMs: number, cwd?: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, cwd, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : stdout.toString())
    })
  })
}

function listSubdirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIR_NAMES.has(e.name.toLowerCase()))
      .map((e) => path.join(dir, e.name))
  } catch {
    return []
  }
}

function isGitRepo(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, '.git'))
  } catch {
    return false
  }
}

/** The development roots to scan: HOME children whose names look like dev
 *  folders, plus the GitHub Desktop default. */
export function devScanRoots(home = os.homedir()): string[] {
  const roots: string[] = []
  try {
    for (const entry of fs.readdirSync(home, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (DEV_ROOT_RE.test(entry.name)) roots.push(path.join(home, entry.name))
    }
  } catch { /* unreadable home — no roots */ }
  const ghDesktop = path.join(home, 'Documents', 'GitHub')
  if (fs.existsSync(ghDesktop)) roots.push(ghDesktop)
  return roots
}

/** Find git repositories under the dev roots, breadth-first, bounded. */
export function findGitRepos(roots = devScanRoots()): string[] {
  const repos: string[] = []
  for (const root of roots) {
    let frontier = [root]
    let visited = 0
    for (let depth = 0; depth <= MAX_SCAN_DEPTH && frontier.length > 0; depth++) {
      const next: string[] = []
      for (const dir of frontier) {
        if (visited++ > MAX_DIRS_PER_ROOT) break
        if (isGitRepo(dir)) {
          repos.push(dir)
          continue // a repo's subdirectories are the repo, not more repos
        }
        next.push(...listSubdirs(dir))
      }
      frontier = next
    }
    if (repos.length >= MAX_REPOS) break
  }
  return repos.slice(0, MAX_REPOS)
}

function clock(ms: number): string {
  return new Date(ms)
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    .replace(':00', '')
    .replace(' ', '')
    .toLowerCase()
}

/** Path-like and branch-like tokens that must never reach a wrap or a tool
 *  result — name the work, never the plumbing.
 *  Each matches a WHOLE risky token so ordinary slashes in prose ("CI/CD",
 *  "and/or", "TCP/IP") survive; only things that read as a file path or a git
 *  ref are stripped. Applied before storage AND before tool output. */
const PATH_BRANCH_PATTERNS: RegExp[] = [
  // A URL: strip whole so a github.com/acme/repo/pull/123 link never leaks.
  /\bhttps?:\/\/[^\s]+/gi,
  // Windows absolute path: C:\Users\me\src\foo.ts
  /[A-Za-z]:\\[^\s]+/g,
  // Windows RELATIVE backslash path: src\main\services\gitSignals.ts, a\b\c
  /\b[\w.-]+(?:\\[\w.-]+)+/g,
  // Leading slash / dot-slash / tilde path: /Users/me/x, ./src/x, ../a/b, ~/dev/x
  /(?:^|\s)[~.]{0,2}\/[^\s]+/g,
  // A whole slashed path ending in a file extension: vendor/lib/thing.min.js,
  // api/schema.graphql, packages/app/index.tsx. Must contain at least one slash,
  // so ordinary "CI/CD" (no extension) and bare "v2.0" (no slash) are left alone.
  /\b[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z0-9]{1,10}\b/g,
  // A branch/PR ref carrying a ticket id: bug/DEV-123, jira/PROJ-42, x/ABC-7
  /\b[\w.-]+\/[A-Z][A-Z0-9]+-\d+\b/g,
  // A git ref with a remote/branch prefix: origin/main, refs/heads/x,
  // feature/login, fix/DEV-123, bug/x, chore/bump-deps, spike/y
  /\b(?:origin|upstream|refs\/heads|refs\/remotes|feat|feature|fix|fixes|bug|bugfix|hotfix|chore|release|wip|dev|develop|task|spike|story|epic|jira|ticket)\/[\w.\-/]+/gi,
  // A relative path under a known code dir, even without an extension:
  // src/main/services, packages/app/y
  /\b(?:src|lib|tests?|dist|build|node_modules|packages?|apps?|components?|services?|main|renderer|shared|scripts?|docs?|public|assets?|styles?|utils?|hooks?|pages?)\/[\w.\-/]+/gi,
]

/** Strip path-like and branch-like tokens, then tidy the wreckage: collapse the
 *  gaps, drop a now-dangling trailing connective ("harden the parser in" →
 *  "harden the parser"), and trim stray edge punctuation. */
export function stripPathsAndBranches(input: string): string {
  let out = input
  for (const re of PATH_BRANCH_PATTERNS) out = out.replace(re, ' ')
  out = out.replace(/\s+/g, ' ').trim()
  // A preposition/article left hanging at the end after its object was removed.
  out = out.replace(/\s+(?:in|to|from|on|for|at|into|under|the|a|an|of|and|with)\s*$/i, '')
  // Stray connective punctuation left at either edge.
  out = out.replace(/^[\s:;,.\-/\\]+/, '').replace(/[\s:;,\-/\\]+$/, '').trim()
  return out
}

/** One line of defense on commit subjects and PR titles: strip control chars,
 *  strip file paths and branch names, collapse whitespace, truncate.
 *  The tool boundary (sanitizeToolResult) is a second, secrets-focused pass. */
export function cleanSubject(subject: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = subject.replace(/[\u0000-\u001F]/g, ' ').replace(/\s+/g, ' ').trim()
  const stripped = stripPathsAndBranches(cleaned)
  return stripped.length > MAX_MESSAGE_LENGTH ? `${stripped.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : stripped
}

async function repoActivityForDate(repo: string, date: string): Promise<GitRepoActivity | null> {
  // Filter to the repo's own configured author when present, so a shared repo
  // never credits teammates' commits to this user's day.
  const email = (await exec('git', ['-C', repo, 'config', 'user.email'], GIT_TIMEOUT_MS))?.trim()
  const args = [
    '-C', repo, 'log', '--all', '--no-merges',
    `--since=${date} 00:00`, `--until=${date} 23:59:59`,
    '--pretty=%ct%x09%s',
  ]
  if (email) args.push(`--author=${email}`)
  const output = await exec('git', args, GIT_TIMEOUT_MS)
  if (!output) return null
  const commits = output.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const tab = line.indexOf('\t')
    return { ts: Number(line.slice(0, tab)) * 1000, subject: cleanSubject(line.slice(tab + 1)) }
  }).filter((c) => Number.isFinite(c.ts))
  if (commits.length === 0) return null
  const times = commits.map((c) => c.ts).sort((a, b) => a - b)
  return {
    repo: path.basename(repo),
    commitCount: commits.length,
    messages: commits.slice(0, MAX_MESSAGES_PER_REPO).map((c) => c.subject),
    firstCommitClock: clock(times[0]),
    lastCommitClock: clock(times[times.length - 1]),
  }
}

async function ghPRActivity(date: string): Promise<GitPRActivity[]> {
  const version = await exec('gh', ['--version'], 2_000)
  if (!version) return []
  const output = await exec('gh', [
    'search', 'prs', '--author', '@me', '--updated', date,
    '--json', 'title,state,isDraft,repository', '--limit', '20',
  ], GH_TIMEOUT_MS)
  if (!output) return []
  try {
    const parsed = JSON.parse(output) as Array<{
      title?: string
      state?: string
      isDraft?: boolean
      repository?: { name?: string }
    }>
    return parsed
      .filter((pr) => pr.title)
      .map((pr) => ({
        title: cleanSubject(pr.title!),
        state: pr.isDraft ? 'draft' : (pr.state ?? 'open').toLowerCase(),
        repo: pr.repository?.name ?? '',
      }))
  } catch {
    return []
  }
}

/** The day's git story: repos touched, commit counts and subjects, PR activity.
 *  Null when the day genuinely has no commits and no PR activity; THROWS when
 *  git itself is unavailable (not installed, or the probe timed out), so the
 *  scan ledger never remembers an unchecked day as "collected, empty".
 *  `probeGit` is injectable so the unavailable path is testable without
 *  uninstalling git. */
export async function collectGitActivity(
  date: string,
  opts: { probeGit?: () => Promise<string | null> } = {},
): Promise<GitActivitySignal | null> {
  const gitVersion = await (opts.probeGit ?? (() => exec('git', ['--version'], 2_000)))()
  if (!gitVersion) throw new Error('git unavailable: not installed or probe timed out')

  const repos = findGitRepos()
  const activities: GitRepoActivity[] = []
  for (const repo of repos) {
    const activity = await repoActivityForDate(repo, date)
    if (activity) activities.push(activity)
  }
  activities.sort((a, b) => b.commitCount - a.commitCount)

  const prs = await ghPRActivity(date)
  if (activities.length === 0 && prs.length === 0) return null

  return {
    repos: activities,
    totalCommits: activities.reduce((s, r) => s + r.commitCount, 0),
    prs,
  }
}
