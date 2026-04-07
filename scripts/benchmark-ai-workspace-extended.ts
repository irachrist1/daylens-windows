/**
 * Extended AI Workspace router regression suite.
 *
 * Exercises 32 question categories beyond the core benchmark:
 * open-ended work threads, distraction detection, entity identity,
 * client listing, comparison, day summary, focus, and time allocation.
 *
 * Run via: npm run benchmark:ai-workspace:extended
 */
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { insertAppSession, insertWebsiteVisit } from '../src/main/db/queries'
import { SCHEMA_SQL } from '../src/main/db/schema'
import { routeInsightsQuestion, type TemporalContext } from '../src/main/lib/insightsQueryRouter'
import type { AppCategory, AppSession } from '../src/shared/types'

const ANCHOR = new Date('2026-04-06T15:30:00')

function ts(time: string): number {
  return new Date(`2026-04-06T${time}:00`).getTime()
}

function addSession(
  db: Database.Database,
  p: { bundleId: string; app: string; title: string; cat: AppCategory; start: string; end: string },
): void {
  const startTime = ts(p.start)
  const endTime = ts(p.end)
  const s: Omit<AppSession, 'id'> = {
    bundleId: p.bundleId, appName: p.app, windowTitle: p.title,
    startTime, endTime,
    durationSeconds: Math.round((endTime - startTime) / 1000),
    category: p.cat,
    isFocused: ['development', 'research', 'writing'].includes(p.cat),
  }
  insertAppSession(db, s)
}

function seedData(db: Database.Database): void {
  db.exec(SCHEMA_SQL)
  // ASYV client
  addSession(db, { bundleId: 'Code.exe',            app: 'Visual Studio Code', title: 'ASYV onboarding export - Visual Studio Code', cat: 'development',  start: '09:00', end: '09:50' })
  addSession(db, { bundleId: 'OUTLOOK.EXE',         app: 'Microsoft Outlook',  title: 'ASYV kickoff notes - Outlook',                 cat: 'email',        start: '09:50', end: '10:05' })
  addSession(db, { bundleId: 'EXCEL.EXE',           app: 'Microsoft Excel',    title: 'ASYV budget model.xlsx - Excel',               cat: 'productivity', start: '10:05', end: '10:35' })
  addSession(db, { bundleId: 'WindowsTerminal.exe', app: 'Windows Terminal',   title: 'pnpm test --filter asyv-export',               cat: 'development',  start: '10:35', end: '10:50' })
  addSession(db, { bundleId: 'chrome.exe',          app: 'Google Chrome',      title: 'ASYV dashboard localhost - Google Chrome',     cat: 'browsing',     start: '10:50', end: '11:10' })
  // Acme Corp client
  addSession(db, { bundleId: 'WORD.EXE',    app: 'Microsoft Word',   title: 'Acme Corp proposal draft.docx - Word',    cat: 'writing', start: '11:30', end: '12:00' })
  addSession(db, { bundleId: 'OUTLOOK.EXE', app: 'Microsoft Outlook',title: 'RE: Acme Corp contract review - Outlook', cat: 'email',   start: '12:00', end: '12:20' })
  // Distraction
  addSession(db, { bundleId: 'chrome.exe', app: 'Google Chrome',      title: 'Reddit - Google Chrome', cat: 'entertainment', start: '13:00', end: '13:30' })
  // Internal
  addSession(db, { bundleId: 'Code.exe', app: 'Visual Studio Code', title: 'Internal tooling cleanup - Visual Studio Code', cat: 'development', start: '14:00', end: '14:40' })
  // Website visits
  insertWebsiteVisit(db, { domain: 'asyv.example.com', pageTitle: 'ASYV dashboard',      url: 'https://asyv.example.com/dashboard', visitTime: ts('10:52'), visitTimeUs: BigInt(ts('10:52')) * 1000n, durationSec: 8 * 60,  browserBundleId: 'chrome.exe', source: 'history' })
  insertWebsiteVisit(db, { domain: 'localhost:3000',   pageTitle: 'ASYV export preview', url: 'http://localhost:3000/asyv-export',   visitTime: ts('11:00'), visitTimeUs: BigInt(ts('11:00')) * 1000n, durationSec: 10 * 60, browserBundleId: 'chrome.exe', source: 'history' })
  insertWebsiteVisit(db, { domain: 'reddit.com',       pageTitle: 'r/programming',       url: 'https://reddit.com/r/programming',    visitTime: ts('13:05'), visitTimeUs: BigInt(ts('13:05')) * 1000n, durationSec: 15 * 60, browserBundleId: 'chrome.exe', source: 'history' })
}

interface Case {
  name: string
  question: string
  expectRouted: boolean
  check?: (answer: string) => void
}

const cases: Case[] = [
  // ── Core benchmark ──────────────────────────────────────────────────────────
  { name: 'ASYV cumulative time', question: 'How many hours have I spent on ASYV today?', expectRouted: true,
    check: (a) => { assert.match(a, /2h 10m/i); assert.match(a, /outlook|excel|localhost|terminal|vs code/i) } },
  { name: 'ASYV title enumeration', question: 'Which ASYV titles matched today?', expectRouted: true,
    check: (a) => { assert.match(a, /ASYV kickoff notes/i); assert.match(a, /ASYV budget model/i) } },
  { name: 'ASYV app breakdown', question: 'Break ASYV down by app today.', expectRouted: true,
    check: (a) => { assert.match(a, /Visual Studio Code|VS Code/i); assert.match(a, /Outlook/i); assert.match(a, /Excel/i) } },
  { name: 'ASYV Outlook attribution', question: 'How much ASYV time was in Outlook today?', expectRouted: true,
    check: (a) => assert.match(a, /15m/i) },
  { name: 'Exact time at 10:58 am', question: 'What was I doing today at 10:58 am?', expectRouted: true,
    check: (a) => assert.match(a, /10:58|asyv|localhost/i) },

  // ── Work thread ─────────────────────────────────────────────────────────────
  { name: 'What was I working on today', question: 'What was I working on today?', expectRouted: true,
    check: (a) => {
      assert.ok(!a.includes('I only have light evidence'), 'Should NOT say light evidence on a full day')
      assert.match(a, /Visual Studio Code|VS Code/i)
    } },
  { name: 'What should I resume', question: 'What should I resume?', expectRouted: true,
    check: (a) => assert.match(a, /Visual Studio Code|VS Code|Internal tooling/i) },

  // ── Distraction ─────────────────────────────────────────────────────────────
  { name: 'Biggest distraction — no duplicates', question: 'What distracted me today?', expectRouted: true,
    check: (a) => {
      assert.match(a, /reddit|chrome|r\/programming|entertainment/i)
      const label = a.match(/^(.+?) was/)?.[1] ?? ''
      if (label) assert.ok(a.indexOf(label, a.indexOf(label) + label.length) === -1, `"${label}" duplicated: ${a}`)
    } },

  // ── Entity identity ─────────────────────────────────────────────────────────
  { name: 'Who is ASYV', question: 'Who is ASYV?', expectRouted: true,
    check: (a) => { assert.match(a, /ASYV/i); assert.match(a, /client|project|develop/i) } },
  { name: 'What do I do for ASYV', question: 'What do I do for ASYV?', expectRouted: true,
    check: (a) => { assert.match(a, /ASYV/i); assert.match(a, /develop|coding|client/i) } },
  { name: 'What is ASYV', question: 'What is ASYV?', expectRouted: true,
    check: (a) => assert.match(a, /ASYV/i) },
  { name: 'Tell me about ASYV', question: 'Tell me about ASYV.', expectRouted: true,
    check: (a) => assert.match(a, /ASYV/i) },
  { name: 'What project am I building for ASYV', question: 'What project am I building for ASYV?', expectRouted: true,
    check: (a) => assert.match(a, /ASYV/i) },
  { name: 'Who is Acme Corp', question: 'Who is Acme Corp?', expectRouted: true,
    check: (a) => { assert.match(a, /Acme Corp/i); assert.match(a, /client|proposal|email|doc/i) } },

  // ── Client listing ──────────────────────────────────────────────────────────
  { name: 'List all my clients today', question: 'List all my clients today.', expectRouted: true,
    check: (a) => { assert.match(a, /ASYV/i); assert.match(a, /Acme/i) } },
  { name: 'Who are my clients today', question: 'Who are my clients today?', expectRouted: true,
    check: (a) => assert.match(a, /ASYV|Acme/i) },
  { name: 'How much time per client today', question: 'How much time per client today?', expectRouted: true,
    check: (a) => assert.match(a, /ASYV|Acme/i) },
  { name: 'Export clientele list', question: 'Analyze today and export the clientele list.', expectRouted: true,
    check: (a) => assert.match(a, /ASYV|Acme/i) },
  { name: 'Clientele time breakdown', question: 'Give me a clientele time breakdown for today.', expectRouted: true,
    check: (a) => assert.match(a, /ASYV|Acme/i) },

  // ── Comparison ──────────────────────────────────────────────────────────────
  { name: 'Compare ASYV vs Acme Corp', question: 'Compare ASYV vs Acme Corp today.', expectRouted: true,
    check: (a) => { assert.match(a, /ASYV/i); assert.match(a, /Acme Corp/i); assert.match(a, /\d+h|\d+m/) } },
  { name: 'ASYV versus Acme', question: 'ASYV versus Acme Corp — which took more time today?', expectRouted: true,
    check: (a) => assert.match(a, /ASYV.*Acme|Acme.*ASYV/i) },

  // ── Day summary ─────────────────────────────────────────────────────────────
  { name: 'Summarize my day', question: 'Summarize my day.', expectRouted: true,
    check: (a) => { assert.ok(a.length > 100); assert.match(a, /tracked|focused|apps/i) } },
  { name: 'How was my day', question: 'How was my day?', expectRouted: true,
    check: (a) => assert.ok(a.length > 80) },
  { name: 'Give me a summary of today', question: 'Give me a summary of today.', expectRouted: true,
    check: (a) => assert.match(a, /tracked|VS Code|apps/i) },
  { name: 'What happened today', question: 'What happened today?', expectRouted: true,
    check: (a) => assert.ok(a.length > 80) },
  { name: 'Recap my day', question: 'Recap my day.', expectRouted: true,
    check: (a) => assert.ok(a.length > 80) },

  // ── Other client time ───────────────────────────────────────────────────────
  { name: 'Time on Acme Corp', question: 'How much time did I spend on Acme Corp today?', expectRouted: true,
    check: (a) => assert.match(a, /50m|Acme/i) },

  // ── App / site / focus ──────────────────────────────────────────────────────
  { name: 'Top app today', question: 'What was my most used app today?', expectRouted: true,
    check: (a) => assert.match(a, /Visual Studio Code|VS Code/i) },
  { name: 'App breakdown today', question: 'Break down my apps today.', expectRouted: true,
    check: (a) => assert.match(a, /Visual Studio Code|VS Code/i) },
  { name: 'Focus score', question: 'What is my focus score today?', expectRouted: true,
    check: (a) => { assert.match(a, /focus score/i); assert.ok(!a.includes('client or project'), 'Must not misroute to entity identity') } },
  { name: 'Where did my time go', question: 'Where did my time go today?', expectRouted: true,
    check: (a) => assert.match(a, /coding|development|writing|email|browsing/i) },

  // ── Correct fall-throughs ───────────────────────────────────────────────────
  { name: 'Follow-up without context', question: 'What were you doing at that time?', expectRouted: false },
]

async function main(): Promise<void> {
  const db = new Database(':memory:')
  seedData(db)

  let passed = 0
  let failed = 0
  let context: TemporalContext | null = null

  for (const tc of cases) {
    const routed = await routeInsightsQuestion(tc.question, ANCHOR, context, db)
    if (routed) context = routed.resolvedContext
    const wasRouted = routed !== null
    const routingOk = wasRouted === tc.expectRouted

    let checkOk = true
    let checkError = ''
    if (tc.check && routed) {
      try { tc.check(routed.answer) } catch (err) {
        checkOk = false
        checkError = err instanceof Error ? err.message : String(err)
      }
    }

    const ok = routingOk && checkOk
    if (ok) {
      passed++
      console.log(`PASS ${tc.name}`)
    } else {
      failed++
      console.log(`FAIL ${tc.name}`)
      if (!routingOk) console.log(`     routing: expected ${tc.expectRouted ? 'ROUTED' : 'FALLTHROUGH'}, got ${wasRouted ? 'ROUTED' : 'FALLTHROUGH'}`)
      if (!checkOk) console.log(`     assertion: ${checkError}`)
    }
    if (routed) console.log(`     ${routed.answer.replace(/\n/g, ' ').slice(0, 120)}`)
    else console.log(`     <falls through to AI provider>`)
  }

  console.log('')
  console.log(`PASS ${passed} / ${passed + failed} extended benchmark checks`)
  if (failed > 0) process.exitCode = 1
}

void main().catch((err) => { console.error(err); process.exitCode = 1 })
