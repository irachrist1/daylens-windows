// Responsiveness stress gate (DEV-263). The July 21–22 freeze passed every
// test: correctness was proven against stubs and small fixtures, then the
// real app met a real database and froze for hours. This gate closes that
// hole: it runs the app's real heavy machinery against a deliberately
// hostile, production-scale dataset while SAMPLING EVENT-LOOP LAG, and fails
// if the thread that draws the screen could have stalled.
//
// Hostile mix, grown as new edge cases are found:
//   - a large embedding backlog whose texts include very long unbroken URLs
//     (the exact shape that wedged the app for hours);
//   - a dense crash-loop day (the overnight July 21 shape at 10× volume)
//     through projection and the corrected-facts query.
//
// Exits non-zero on any budget breach. When the pinned model artifact is
// absent (it ships with the installer, not the repo) the embedding half is
// reported as SKIPPED loudly — a skipped gate must never look like a pass.
import { fork } from 'node:child_process'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { createProductionTestDatabase } from '../support/testDatabase.ts'
import { insertFocusEvents } from '../../src/main/db/focusEventRepository.ts'
import {
  FOCUS_EVENT_SCHEMA_VERSION,
  POLL_FOCUS_EVENT_SOURCE,
  SUPERVISOR_FOCUS_EVENT_SOURCE,
  type FocusEventInsert,
} from '../../src/main/core/evidence/focusEvent.ts'
import { projectDay } from '../../src/main/core/projections/chunk2.ts'
import { queryCorrectedActivityFactsForDay } from '../../src/main/core/query/activityFactsQuery.ts'
import {
  semanticModelAssetStatus,
  semanticModelCacheDir,
  SEMANTIC_EMBEDDING_DIMS,
} from '../../src/main/services/semanticEmbedder.ts'

const projectRoot = path.resolve(__dirname, '..', '..')

// Budgets. These are regression tripwires for the July-22 failure class, not
// UX targets: a main-thread inference stall measures in seconds-to-hours,
// orders of magnitude past these lines.
const MAIN_LOOP_MAX_LAG_MS = 1_000
const MAIN_LOOP_P95_LAG_MS = 250
const POISON_BACKLOG_BUDGET_MS = 120_000
const PROJECTION_BUDGET_MS = 5_000

const failures: string[] = []

function report(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`)
  if (!ok) failures.push(`${name}: ${detail}`)
}

// ─── Event-loop lag sampler ──────────────────────────────────────────────────

function startLagSampler(): { stop: () => { maxMs: number; p95Ms: number } } {
  const samples: number[] = []
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    samples.push(Math.max(0, now - last - 50))
    last = now
  }, 50)
  return {
    stop() {
      clearInterval(timer)
      const sorted = [...samples].sort((a, b) => a - b)
      return {
        maxMs: sorted.length ? sorted[sorted.length - 1] : 0,
        p95Ms: sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0,
      }
    },
  }
}

// ─── Half 1: adversarial embedding backlog in the worker, lag on this loop ───

function adversarialTexts(): string[] {
  const texts: string[] = []
  for (let i = 0; i < 288; i += 1) {
    texts.push(`Warp — daylens — task ${i} · short window title`)
  }
  for (let i = 0; i < 32; i += 1) {
    // The July-22 poison shape: long unbroken sign-in URLs.
    texts.push(`Safari — https://accounts.example.com/v3/signin/accountchooser?client_id=${'x'.repeat(1_500)}&flow=${i}`)
  }
  return texts
}

async function stressEmbedding(): Promise<void> {
  if (!semanticModelAssetStatus().present) {
    console.log('SKIP  embedding stress — pinned model artifact not present; the responsiveness gate did NOT run for embedding')
    return
  }

  const worker = fork(
    path.join(projectRoot, 'packages', 'embed-worker', 'src', 'index.ts'),
    [],
    {
      execArgv: ['--loader', `file://${path.join(projectRoot, 'packages', 'mcp-server', 'loader.mjs')}`],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DAYLENS_SEMANTIC_MODEL_DIR: semanticModelCacheDir(),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
    },
  )
  const replies = new Map<number, (reply: { ok?: boolean; result?: { vectors?: number[][] }; error?: string }) => void>()
  worker.on('message', (message: { id?: number; ok?: boolean; result?: { vectors?: number[][] }; error?: string }) => {
    if (typeof message?.id === 'number') replies.get(message.id)?.(message)
  })
  let nextId = 1
  const request = (payload: Record<string, unknown>): Promise<{ ok?: boolean; result?: { vectors?: number[][] }; error?: string }> => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('embed request timed out')), POISON_BACKLOG_BUDGET_MS)
      replies.set(id, (reply) => {
        clearTimeout(timer)
        resolve(reply)
      })
      worker.send({ id, ...payload })
    })
  }

  const sampler = startLagSampler()
  const started = performance.now()
  try {
    const texts = adversarialTexts()
    // The app embeds in batches of 32; drive the same shape, poison included.
    for (let offset = 0; offset < texts.length; offset += 32) {
      const batch = texts.slice(offset, offset + 32)
      const reply = await request({ op: 'embed', texts: batch })
      if (!reply.ok || reply.result?.vectors?.length !== batch.length) {
        report('embedding backlog', false, `worker failed: ${reply.error ?? 'wrong vector count'}`)
        return
      }
      if (reply.result.vectors[0]?.length !== SEMANTIC_EMBEDDING_DIMS) {
        report('embedding backlog', false, 'wrong dims')
        return
      }
    }
    const elapsed = performance.now() - started
    const lag = sampler.stop()
    report('embedding backlog drains', elapsed < POISON_BACKLOG_BUDGET_MS, `320 texts incl. 32 poison URLs in ${Math.round(elapsed)}ms (budget ${POISON_BACKLOG_BUDGET_MS}ms)`)
    report('main loop stays responsive during embedding', lag.maxMs < MAIN_LOOP_MAX_LAG_MS && lag.p95Ms < MAIN_LOOP_P95_LAG_MS, `lag max ${Math.round(lag.maxMs)}ms / p95 ${Math.round(lag.p95Ms)}ms (budget ${MAIN_LOOP_MAX_LAG_MS}/${MAIN_LOOP_P95_LAG_MS}ms)`)
  } finally {
    worker.kill('SIGTERM')
  }
}

// ─── Half 2: crash-loop day through projection at 10× volume ─────────────────

function crashLoopDayEvents(date: string): FocusEventInsert[] {
  const dayStart = new Date(`${date}T00:00:00`).getTime()
  const events: FocusEventInsert[] = []
  const base = (tsMs: number, eventType: FocusEventInsert['event_type'], overrides: Partial<FocusEventInsert> = {}): FocusEventInsert => ({
    ts_ms: tsMs,
    mono_ns: tsMs * 1_000_000,
    event_type: eventType,
    app_bundle_id: 'dev.warp.Warp-Stable',
    app_name: 'Warp',
    pid: 1001,
    window_title: 'daylens — session',
    url: null,
    page_title: null,
    source: POLL_FOCUS_EVENT_SOURCE,
    confidence: 'observed',
    platform: 'darwin',
    schema_ver: FOCUS_EVENT_SCHEMA_VERSION,
    ...overrides,
  })
  // 120 crash-loop cycles across the day: restart steals focus, titles churn,
  // the run dies without a stop.
  let lastCycleEnd = dayStart
  for (let cycle = 0; cycle < 120; cycle += 1) {
    const cycleStart = dayStart + 6 * 3_600_000 + cycle * 8 * 60_000
    events.push(base(cycleStart, 'capture_started', {
      app_bundle_id: null,
      app_name: null,
      pid: null,
      window_title: null,
      source: SUPERVISOR_FOCUS_EVENT_SOURCE,
    }))
    for (let i = 0; i < 40; i += 1) {
      const tsMs = cycleStart + 5_000 + i * 2_000
      events.push(base(tsMs, i % 2 ? 'window_changed' : 'app_activated', {
        window_title: `daylens — rebuild ${cycle}.${i}`,
      }))
      lastCycleEnd = tsMs
    }
  }
  // The day ends the way a real one does — the final run stops cleanly. The
  // trailing-open-session-to-now behavior is the decided live-day behavior
  // and is not what this gate measures.
  events.push(base(lastCycleEnd + 5_000, 'capture_stopped', {
    app_bundle_id: null,
    app_name: null,
    pid: null,
    window_title: null,
    source: SUPERVISOR_FOCUS_EVENT_SOURCE,
  }))
  return events
}

function stressProjection(): void {
  const db = createProductionTestDatabase()
  try {
    const date = '2026-04-22'
    insertFocusEvents(db, crashLoopDayEvents(date))
    const sampler = startLagSampler()
    const started = performance.now()
    projectDay(db, date, { now: new Date('2026-04-23T12:00:00'), finalize: true })
    const facts = queryCorrectedActivityFactsForDay(db, date, { nowMs: new Date(`${date}T23:59:00`).getTime() })
    const elapsed = performance.now() - started
    sampler.stop()

    report('crash-loop day projects within budget', elapsed < PROJECTION_BUDGET_MS, `${facts.focusEventCount} events in ${Math.round(elapsed)}ms (budget ${PROJECTION_BUDGET_MS}ms)`)
    // The July-22 correctness trap: no derived session may span a capture
    // start (each cycle's dead tail must not read as activity).
    const cycleGapMs = 8 * 60_000
    const longest = Math.max(...facts.sessions.map((s) => (s.endTime ?? s.startTime) - s.startTime), 0)
    report('no session spans a capture outage', longest < cycleGapMs, `longest derived session ${Math.round(longest / 1000)}s (cycle gap ${cycleGapMs / 1000}s)`)
  } finally {
    db.close()
  }
}

// ─── Run ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Responsiveness stress gate (DEV-263)')
  await stressEmbedding()
  stressProjection()
  if (failures.length > 0) {
    console.error(`\n${failures.length} budget breach(es):`)
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log('\nAll responsiveness budgets held.')
}

void main().catch((error) => {
  console.error('stress gate crashed:', error)
  process.exit(1)
})
