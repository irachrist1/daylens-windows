import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanSubject, stripPathsAndBranches } from '../src/main/services/gitSignals.ts'

// Git subject sanitization: commit subjects and PR titles
// must never carry a file path or a branch name to a wrap or a tool result —
// name the work, never the plumbing. These are the real shapes
// that show up in a commit log.

test('strips relative file paths under known code dirs', () => {
  assert.equal(stripPathsAndBranches('harden sanitization in src/main/services/gitSignals.ts'), 'harden sanitization')
  assert.equal(stripPathsAndBranches('update tests/wrappedBenchmark.test.ts scoring'), 'update scoring')
  assert.equal(stripPathsAndBranches('rewrite packages/app/index.tsx'), 'rewrite')
})

test('strips absolute and dot-relative paths', () => {
  assert.equal(stripPathsAndBranches('read /Users/me/dev/daylens/config'), 'read')
  assert.equal(stripPathsAndBranches('touch ./scripts/build.sh again'), 'touch again')
  assert.equal(stripPathsAndBranches('open ~/notes/todo.md'), 'open')
  assert.equal(stripPathsAndBranches('fix C:\\Users\\me\\app\\main.ts crash'), 'fix crash')
})

test('strips branch and remote refs', () => {
  assert.equal(stripPathsAndBranches('merge feature/login into trunk'), 'merge into trunk')
  assert.equal(stripPathsAndBranches('rebase onto origin/main'), 'rebase onto')
  assert.equal(stripPathsAndBranches('cherry-pick from fix/DEV-123'), 'cherry-pick')
  assert.equal(stripPathsAndBranches('push refs/heads/release-2'), 'push')
})

test('strips any token ending in a file extension', () => {
  assert.equal(stripPathsAndBranches('regenerate api/schema.graphql'), 'regenerate')
  assert.equal(stripPathsAndBranches('minify vendor/lib/thing.min.js'), 'minify')
})

test('keeps ordinary slashes that are not paths', () => {
  assert.equal(stripPathsAndBranches('wire up the CI/CD pipeline'), 'wire up the CI/CD pipeline')
  assert.equal(stripPathsAndBranches('handle TCP/IP timeouts'), 'handle TCP/IP timeouts')
  assert.equal(stripPathsAndBranches('add an and/or filter'), 'add an and/or filter')
})

test('leaves a clean, human subject untouched', () => {
  assert.equal(stripPathsAndBranches('add the wrapped benchmark judge'), 'add the wrapped benchmark judge')
  assert.equal(stripPathsAndBranches('fix: race in the tracking engine'), 'fix: race in the tracking engine')
})

test('cleanSubject strips control chars, paths, and truncates together', () => {
  const messy = 'refactor\tthe parser in src/main/lib/parse.ts\nand branch feature/parser-v2'
  const cleaned = cleanSubject(messy)
  assert.ok(!/src\/main/.test(cleaned), 'no path leaks')
  assert.ok(!/feature\//.test(cleaned), 'no branch leaks')
  assert.ok(!/[\t\n]/.test(cleaned), 'no control chars')
  assert.match(cleaned, /refactor the parser/)
})

test('cleanSubject truncates an over-long subject with an ellipsis', () => {
  const long = 'ship '.repeat(60) // ~300 chars, no paths
  const cleaned = cleanSubject(long)
  assert.ok(cleaned.length <= 120, `expected <= 120, got ${cleaned.length}`)
  assert.ok(cleaned.endsWith('…'))
})

test('strips the shapes the blind review flagged (backslash paths, ticket branches, URLs)', () => {
  assert.equal(stripPathsAndBranches('fix src\\main\\services\\gitSignals.ts crash'), 'fix crash')
  assert.equal(stripPathsAndBranches('merge bug/DEV-123'), 'merge')
  assert.equal(stripPathsAndBranches('close jira/PROJ-42 finally'), 'close finally')
  assert.equal(stripPathsAndBranches('see https://github.com/acme/repo/pull/123 for context'), 'see for context')
})

// ─── Unavailable vs "ran, empty" (the scan-ledger contract) ──────────────────
// The scan ledger (externalSignals.ts) may only remember a day as "collected,
// empty" when git actually ran; a missing/unresponsive git must THROW so an
// unchecked historical day stays collectable.

import { collectGitActivity } from '../src/main/services/gitSignals.ts'

test('collectGitActivity throws when git is unavailable — never "collected, empty"', async () => {
  await assert.rejects(collectGitActivity('2026-04-03', { probeGit: async () => null }))
})
