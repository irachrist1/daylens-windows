#!/usr/bin/env node
// Hermetic test runner for the whole `tests/**/*.test.{ts,mjs}` suite.
//
// Why this exists: before this script there was no `npm test`. Only a quarter
// of the test files (~24 of the 91 that existed then) were referenced by any
// npm script, so most of the suite never
// ran and could not catch a regression. Worse, when the files were run together
// in one process, module-level singletons (e.g. the PostHog/Sentry clients in
// services/analytics.ts) leaked across files and made results depend on run
// order — analytics.test.ts passed alone but failed in-suite.
//
// The fix is structural: discover every *.test.ts / *.test.mjs and run EACH FILE IN ITS OWN
// electron process via node:test. Per-file process isolation makes module state
// impossible to leak, so the suite is deterministic regardless of order.
//
// Tests run under Electron (ELECTRON_RUN_AS_NODE=1) because the codebase imports
// `electron` and native modules (better-sqlite3); the ts-loader stubs electron /
// settings / database so the run stays hermetic — no Anthropic key, no network,
// no real user DB.
//
// Usage:
//   node scripts/run-tests.mjs              # run the whole hermetic suite
//   node scripts/run-tests.mjs <substr>...  # run only files matching a substring
//   TEST_CONCURRENCY=1 node scripts/run-tests.mjs   # force serial

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const testsDir = path.join(projectRoot, 'tests')
const loader = path.join(testsDir, 'support', 'ts-loader.mjs')
const electronBin = require('electron')

// Files that must NOT run in the hermetic suite because they need a configured
// provider, the user's real DB, or otherwise reach the network. Keep this list
// tiny and explicit — everything else is
// expected to be hermetic, and a new file is hermetic until proven otherwise.
const LIVE_ONLY = new Set([
  // The Wrapped benchmark generates real wraps and scores them with a live
  // judge — real Anthropic key, real DB, network. It owns `npm run wrapped:bench`.
  'wrappedBenchmark.test.ts',
])

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'support') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile() && (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.mjs')))
      out.push(full)
  }
  return out
}

const filters = process.argv.slice(2)
const allFiles = walk(testsDir)
  .filter((f) => !LIVE_ONLY.has(path.basename(f)))
  .filter((f) => filters.length === 0 || filters.some((s) => f.includes(s)))
  .sort()

if (allFiles.length === 0) {
  console.error('No test files matched.')
  process.exit(1)
}

const concurrency =
  Number(process.env.TEST_CONCURRENCY) || Math.max(2, Math.min(8, os.cpus().length))

function runFile(file) {
  return new Promise((resolve) => {
    const relLoader = './' + path.relative(projectRoot, loader).replace(/\\/g, '/')
    const relFile = './' + path.relative(projectRoot, file).replace(/\\/g, '/')
    const child = spawn(electronBin, ['--loader', relLoader, '--test', relFile], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      out += d
    })
    child.on('close', (code) => {
      const pass = Number((out.match(/^# pass (\d+)/m) || [])[1] || 0)
      const fail = Number((out.match(/^# fail (\d+)/m) || [])[1] || 0)
      const skip = Number((out.match(/^# skipped (\d+)/m) || [])[1] || 0)
      resolve({ file, code, pass, fail, skip, out })
    })
  })
}

const rel = (f) => path.relative(projectRoot, f)
const results = []
let cursor = 0

async function worker() {
  while (cursor < allFiles.length) {
    const file = allFiles[cursor++]
    const r = await runFile(file)
    results.push(r)
    const ok = r.code === 0 && r.fail === 0
    const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'
    const counts = `${r.pass} pass${r.fail ? `, ${r.fail} fail` : ''}${r.skip ? `, ${r.skip} skip` : ''}`
    console.log(`${mark} ${rel(file)} \x1b[2m(${counts})\x1b[0m`)
    if (!ok)
      console.log(
        r.out
          .split('\n')
          .filter((l) => /^(not ok|\s+(error|expected|actual|failureType):)/.test(l))
          .join('\n'),
      )
  }
}

const started = Date.now()
console.log(`Running ${allFiles.length} test files, ${concurrency} at a time (one process each)\n`)
await Promise.all(Array.from({ length: concurrency }, worker))

const failed = results.filter((r) => r.code !== 0 || r.fail > 0)
const totalPass = results.reduce((n, r) => n + r.pass, 0)
const totalFail = results.reduce((n, r) => n + r.fail, 0)
const totalSkip = results.reduce((n, r) => n + r.skip, 0)
const secs = ((Date.now() - started) / 1000).toFixed(1)

console.log(`\n${'─'.repeat(48)}`)
console.log(
  `${results.length} files · ${totalPass} pass · ${totalFail} fail · ${totalSkip} skip · ${secs}s`,
)
if (failed.length > 0) {
  console.log(`\n\x1b[31mFailed files:\x1b[0m`)
  for (const r of failed) console.log(`  ${rel(r.file)} (exit ${r.code}, ${r.fail} fail)`)
  process.exit(1)
}
console.log('\x1b[32mAll green.\x1b[0m')
