// The brutal day: ONE adversarial simulated day exercising every subsystem at
// once, through the real capture-pipeline seams — the tracking-FSM test rig,
// the fixture embedder, and the fixture model.
// Every assertion states a spec-mandated invariant of the capture, timeline,
// memory, agent, wrapped, briefs, billing, and screen-context
// systems; nothing here invents behavior the product does not promise.
//
// The day:
//   - morning full-screen Coursera in Dia on monitor 2 while Notion holds
//     input focus on monitor 1 (passive presence + display visibility);
//   - an incognito window interleaved with normal browsing (must vanish);
//   - three meetings: one calendar+captured (matched), one captured-only
//     Zoom call with no event, one calendar-only double-booked overlap
//     (scheduled context, never additive time) — with a meeting note
//     attached to the matched one;
//   - an afternoon correction ("that block was client research") through the
//     agent's propose → confirm flow;
//   - a site purge plus backup-restore replay honesty;
//   - supplied memory confirmed in chat;
//   - exact + semantic search retrieving morning artifacts by name and by
//     meaning;
//   - a context-packet Q&A with citations and inspector consistency;
//   - evening recap + day wrap + weekly rollup reconciling to Timeline/Apps
//     exactly; an export containing the day honestly;
//   - entitlement exhaustion flipping managed AI to the calm pause while BYOK
//     still answers;
//   - the screen experiment refusing a password-manager surface; and the
//     rapid-switch burst + passive reading hold at the FSM boundary.
// MUST evaluate first: billing's vite defines are captured at module
// evaluation time by the test loader, and the static import chain below
// (aiService → aiOrchestration → billing) evaluates billing.ts.
import { privateKey, KID } from './support/armBrutalBilling.ts'

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sign as cryptoSign } from 'node:crypto'
import type Database from 'better-sqlite3'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'

import { createProductionTestDatabase } from './support/testDatabase.ts'
import { setTestDb, clearTestDb } from './support/database-stub.mjs'
import { __setSettings, __resetSettings, getSettings, setApiKey, clearApiKey } from './support/settings-stub.mjs'
import { driveCaptureDay, fixtureClockMs } from './support/captureDay.ts'
import type { CaptureEventsDayFixture } from './support/dayFixture.ts'
import { findDatabaseTextMatches } from './support/dayFixturePrivacy.ts'

import { projectDay } from '../src/main/core/projections/chunk2.ts'
import { insertFocusEvents } from '../src/main/db/focusEventRepository.ts'
import type { FocusEventInsert } from '../src/main/core/evidence/focusEvent.ts'
import { getTimelineDayPayload } from '../src/main/services/workBlocks.ts'
import { getAppSummariesForTimelineDay } from '../src/main/services/appsFacts.ts'
import { blockActiveSeconds } from '../src/shared/blockDuration.ts'
import { resolveDayMeetingReport } from '../src/main/services/meetingResolution.ts'
import { getExternalSignal, putExternalSignal } from '../src/main/services/externalSignals.ts'
import type { CalendarSignal } from '../src/shared/types.ts'
import { indexMemoryForDay, ensureDayMemoryIndexed } from '../src/main/services/memoryIndex.ts'
import { searchExact } from '../src/main/services/exactSearch.ts'
import { searchAll } from '../src/main/db/queries.ts'
import { searchSessions } from '../src/main/db/queries.ts'
import { searchByMeaning, semanticIndexStep, stopSemanticIndexBackfill } from '../src/main/services/semanticIndex.ts'
import {
  setSemanticEmbedderFactoryForTests,
  SEMANTIC_EMBEDDING_DIMS,
  type SemanticEmbedder,
} from '../src/main/services/semanticEmbedder.ts'
import { runMemoryProposal } from '../src/main/agent/memoryTools.ts'
import type { AgentQuestion } from '../src/main/agent/interactionTools.ts'
import { listSuppliedFacts } from '../src/main/services/suppliedMemory.ts'
import { buildCorrectionTools, type CorrectionToolDeps } from '../src/main/agent/correctionTools.ts'
import { appendDayAnalysisVersion, listDayAnalysisVersions } from '../src/main/db/dayAnalysisVersions.ts'
import { deleteHistoryForSite } from '../src/main/services/trackingHistory.ts'
import { appendDeletionJournalEntry, replayDeletionJournal } from '../src/main/services/deletionJournal.ts'
import { sendMessage } from '../src/main/jobs/aiService.ts'
import { getContextPacketForMessage } from '../src/main/services/contextPacket.ts'
import { inspectContextPacket } from '../src/main/services/contextPacketInspection.ts'
import { buildDayWrapFacts } from '../src/renderer/lib/dayWrapScenes.ts'
import { factOnlyRecapLine } from '../src/main/lib/wrappedNarrative.ts'
import { buildDayFactTable, groundingFormsForRuntime, firstUngroundedNumericToken } from '../src/main/lib/wrapFactTable.ts'
import { buildDaySnapshot } from '../src/main/lib/daySnapshot.ts'
import { upsertDaySnapshot } from '../src/main/db/queries.ts'
import { buildWrappedPeriodFacts } from '../src/main/services/wrappedPeriodNarrative.ts'
import { planHistoryExport, runHistoryExport } from '../src/main/services/historyExport.ts'
import { resolveProviderConfigsForJob } from '../src/main/services/aiOrchestration.ts'
import { buildModelSources } from '../src/shared/aiModelSources.ts'
import { buildModelCostCatalog } from '../src/main/services/modelCatalog.ts'
import { entitlementSigningPayload } from '../src/main/services/entitlement.ts'
import {
  openTurnCheckpoint,
  markTurnWaiting,
  recoverInterruptedTurns,
  listPausedTurns,
  adoptTurnCheckpointForResume,
  closeTurnCheckpoint,
  getTurnCheckpoint,
} from '../src/main/services/agentTurnState.ts'
import {
  __setTrackingFsmTestHarness,
  __pollForTest,
  getCurrentSession,
} from '../src/main/services/tracking.ts'
import {
  ActiveBrowserContextTracker,
  __setActiveBrowserContextTrackerForTest,
} from '../src/main/services/browserContext.ts'
import { ScreenContextLifecycle } from '../src/main/services/screenContext/lifecycle.ts'
import { ScreenContextSampler, isProtectedSurfaceTitle, type ForegroundSnapshot, type ScreenFrameSource } from '../src/main/services/screenContext/sampler.ts'
import { listAllFrames, listAllEvidence } from '../src/main/services/screenContext/repository.ts'
import type {
  CapturedFrameInput,
  FrameFileStore,
  ScreenCaptureGateContext,
  ScreenFrameExtractor,
  ScreenSamplingEnvironment,
} from '../src/main/services/screenContext/types.ts'
import type { AppSettings, LiveSession } from '../src/shared/types.ts'

// ─── Entitlement snapshot (signed with the armed test key) ───────────────────
const { app } = await import('electron')
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-brutal-day-'))
app.setPath('userData', userData)

const NOW_MS = Date.now()
const exhaustedUnsigned = {
  accountId: 'acct-brutal',
  state: 'exhausted' as const,
  periodStart: null,
  periodEnd: null,
  managedCreditGrantedUsd: 5,
  managedCreditReservedUsd: 0,
  managedCreditConsumedUsd: 5,
  canUseManagedAI: false,
  canUseCloud: false,
  issuedAt: NOW_MS,
  expiresAt: NOW_MS + 6 * 3600_000,
  kid: KID,
}
const exhaustedSnapshot = {
  ...exhaustedUnsigned,
  signature: cryptoSign(null, Buffer.from(entitlementSigningPayload(exhaustedUnsigned), 'utf8'), privateKey).toString('base64'),
}
fs.writeFileSync(path.join(userData, 'entitlement-snapshot.json'), JSON.stringify(exhaustedSnapshot))

// ─── The day ──────────────────────────────────────────────────────────────────

function localDateDaysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const DAY = localDateDaysAgo(1)

function dayMs(hour: number, minute = 0, second = 0): number {
  const [year, month, dayOfMonth] = DAY.split('-').map(Number)
  return new Date(year, month - 1, dayOfMonth, hour, minute, second, 0).getTime()
}

const clock = (hour: number, minute = 0) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`

const NOTION = { application: 'Notion', path: '/Applications/Notion.app' }
const ZOOM = { application: 'zoom.us', path: '/Applications/zoom.us.app' }
const CHROME = { application: 'Google Chrome', path: '/Applications/Google Chrome.app' }

const MORNING_NOTION_TITLE = 'ML roadmap — supervised vs unsupervised notes'
const OLED_TITLE = 'Best OLED TV discounts'
const PROMPTS_TITLE = 'Prompts are technical debt'
const TEARDOWN_TITLE = 'Competitor teardown notes'
const PRIVATE_URL = 'https://private-bank.example/statement'
const PRIVATE_TITLE = 'Bank statement — private'

const fixture: CaptureEventsDayFixture = {
  schemaVersion: 1,
  id: 'brutal-day',
  name: 'The brutal day',
  date: DAY,
  timezone: 'local',
  input: {
    kind: 'capture-events',
    settings: {
      trackingControlsEnabled: true,
      trackingExcludedApps: ['SecretApp'],
      trackingExcludedSites: ['excluded.example'],
      trackingSkipIncognito: true,
      workMemoryEnabled: true,
    },
    foregroundSamples: [
      { at: '09:13', ...NOTION, title: MORNING_NOTION_TITLE },
      { at: '10:20', ...ZOOM, title: 'Acme launch sync' },
      { at: '10:50', ...NOTION, title: MORNING_NOTION_TITLE },
      { at: '11:30', ...CHROME, title: `${OLED_TITLE} - Google Chrome`, tab: { url: 'https://tvdeals.example/oled', title: OLED_TITLE, modeKnown: true } },
      // The incognito window interleaves normal browsing: the mode is KNOWN
      // private, so the page must never persist anywhere.
      { at: '11:45', ...CHROME, title: null, tab: { url: PRIVATE_URL, title: PRIVATE_TITLE, isPrivate: true, modeKnown: true } },
      { at: '11:50', ...CHROME, title: `${PROMPTS_TITLE} - Google Chrome`, tab: { url: 'https://seangoedecke.example/prompts-technical-debt', title: PROMPTS_TITLE, modeKnown: true } },
      // Honest lunch gap 12:20 → 13:30 (nothing is stretched over it).
      { at: '12:20', ...NOTION, title: 'Lunch list' },
      { at: '13:30', ...NOTION, title: TEARDOWN_TITLE },
      { at: '15:00', ...ZOOM, title: 'Ad-hoc pairing with Sam' },
      { at: '15:25', ...NOTION, title: 'ML roadmap wrap-up' },
      { at: '17:30', application: 'Finder', path: '/System/Library/CoreServices/Finder.app', title: 'Desktop' },
    ],
    focusEvents: [
      { at: '09:13', eventType: 'app_activated', appBundleId: 'notion.id', appName: 'Notion', windowTitle: MORNING_NOTION_TITLE },
      { at: '10:20', eventType: 'app_deactivated', appBundleId: 'notion.id', appName: 'Notion', windowTitle: MORNING_NOTION_TITLE },
      { at: '10:20', eventType: 'app_activated', appBundleId: 'us.zoom.xos', appName: 'zoom.us', windowTitle: 'Acme launch sync' },
      { at: '10:50', eventType: 'app_deactivated', appBundleId: 'us.zoom.xos', appName: 'zoom.us', windowTitle: 'Acme launch sync' },
      { at: '10:50', eventType: 'app_activated', appBundleId: 'notion.id', appName: 'Notion', windowTitle: MORNING_NOTION_TITLE },
      { at: '11:30', eventType: 'app_deactivated', appBundleId: 'notion.id', appName: 'Notion', windowTitle: MORNING_NOTION_TITLE },
      { at: '11:30', eventType: 'app_activated', appBundleId: 'com.google.Chrome', appName: 'Google Chrome', windowTitle: OLED_TITLE },
      { at: '11:45', eventType: 'app_deactivated', appBundleId: 'com.google.Chrome', appName: 'Google Chrome', windowTitle: OLED_TITLE },
      // Incognito: the canonical stream may keep browser identity + timing
      // only. A title carrying the private marker must be REJECTED.
      { at: '11:45', eventType: 'app_activated', appBundleId: 'com.google.Chrome', appName: 'Google Chrome', windowTitle: null },
      { at: '11:50', eventType: 'app_deactivated', appBundleId: 'com.google.Chrome', appName: 'Google Chrome', windowTitle: null },
      { at: '11:50', eventType: 'app_activated', appBundleId: 'com.google.Chrome', appName: 'Google Chrome', windowTitle: PROMPTS_TITLE },
      { at: '12:20', eventType: 'app_deactivated', appBundleId: 'com.google.Chrome', appName: 'Google Chrome', windowTitle: PROMPTS_TITLE },
      { at: '13:30', eventType: 'app_activated', appBundleId: 'notion.id', appName: 'Notion', windowTitle: TEARDOWN_TITLE },
      { at: '15:00', eventType: 'app_deactivated', appBundleId: 'notion.id', appName: 'Notion', windowTitle: TEARDOWN_TITLE },
      { at: '15:00', eventType: 'app_activated', appBundleId: 'us.zoom.xos', appName: 'zoom.us', windowTitle: 'Ad-hoc pairing with Sam' },
      { at: '15:25', eventType: 'app_deactivated', appBundleId: 'us.zoom.xos', appName: 'zoom.us', windowTitle: 'Ad-hoc pairing with Sam' },
      { at: '15:25', eventType: 'app_activated', appBundleId: 'notion.id', appName: 'Notion', windowTitle: 'ML roadmap wrap-up' },
      { at: '17:30', eventType: 'app_deactivated', appBundleId: 'notion.id', appName: 'Notion', windowTitle: 'ML roadmap wrap-up' },
      // MUST be rejected before storage:
      { at: '11:46', eventType: 'app_activated', appBundleId: 'com.google.Chrome', appName: 'Google Chrome', windowTitle: 'Secret research (Incognito)' },
      { at: '14:00', eventType: 'app_activated', appBundleId: 'com.secret.app', appName: 'SecretApp', windowTitle: 'Hidden work' },
    ],
  },
}

// Fixture embedder — deterministic concept axes (same scheme as
// semanticSearch.test.ts): "cheap television offers" lands near
// "Best OLED TV discounts" with zero shared words.
const CONCEPTS: string[][] = [
  ['tv', 'television', 'oled', 'screen'],
  ['price', 'pricing', 'discount', 'deal', 'cost', 'cheap', 'markdown', 'offer'],
  ['doc', 'document', 'note', 'plan', 'agenda', 'roadmap'],
  ['meeting', 'sync', 'call', 'pairing'],
  ['prompt', 'debt', 'article'],
]

function tokenAxis(token: string): number {
  let hash = 0
  for (const char of token) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return CONCEPTS.length + 1 + (hash % (SEMANTIC_EMBEDDING_DIMS - CONCEPTS.length - 1))
}

function fixtureVector(text: string): Float32Array {
  const vector = new Float32Array(SEMANTIC_EMBEDDING_DIMS)
  vector[CONCEPTS.length] = 1
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map((t) => t.replace(/s$/, ''))
  for (const token of tokens) {
    const conceptIndex = CONCEPTS.findIndex((concept) => concept.includes(token))
    if (conceptIndex >= 0) vector[conceptIndex] += 4
    else vector[tokenAxis(token)] += 1
  }
  let norm = 0
  for (const value of vector) norm += value * value
  norm = Math.sqrt(norm)
  for (let index = 0; index < vector.length; index += 1) vector[index] /= norm
  return vector
}

const fixtureEmbedder: SemanticEmbedder = {
  model: 'fixture-embedder',
  version: 1,
  dims: SEMANTIC_EMBEDDING_DIMS,
  embed: (texts) => Promise.resolve(texts.map((text) => fixtureVector(text))),
}

// Fixture model helpers (the only model in this file).
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

function answerModel(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 'answer-1' },
          { type: 'text-delta', id: 'answer-1', delta: text },
          { type: 'text-end', id: 'answer-1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
        ] as never[],
      }),
    }),
  })
}

const DISPLAY_2 = 724062012

function displayEvent(tsMs: number, eventType: 'display_visible_changed' | 'display_visible_sampled'): FocusEventInsert {
  return {
    ts_ms: tsMs,
    mono_ns: tsMs * 1_000_000,
    event_type: eventType,
    app_bundle_id: 'company.thebrowser.dia',
    app_name: 'Dia',
    pid: 4242,
    window_title: null, // browser full-screen keeps identity + timing only
    url: null,
    page_title: null,
    source: 'cg_display_visibility',
    confidence: 'observed',
    platform: 'darwin',
    schema_ver: 2,
    display_id: DISPLAY_2,
  }
}

// ─── Shared state across the ordered tests below ─────────────────────────────
const db: Database.Database = createProductionTestDatabase()
let purgedVisitRows: Array<Record<string, unknown>> = []

test.after(() => {
  setSemanticEmbedderFactoryForTests(null)
  stopSemanticIndexBackfill()
  __resetSettings()
  clearTestDb()
  db.close()
})

test('capture: the adversarial day flows through the real pipeline; incognito and excluded evidence never persist', async () => {
  setTestDb(db)
  const { rejectedFocusEvents } = await driveCaptureDay(db, fixture)
  assert.equal(rejectedFocusEvents, 2, 'the incognito-titled event and the excluded app event are rejected before storage')

  const projection = projectDay(db, DAY, { finalize: true, now: new Date(fixtureClockMs(fixture, '23:59')) })
  assert.equal(projection.skipped, false)
  assert.ok(projection.sessions >= 5, `expected a real day of canonical sessions, got ${projection.sessions}`)

  // The private window vanished from every table, and its terms retrieve nothing.
  // Content terms only: 'incognito' also exists as an operational
  // ended_reason enum on app_sessions, which is capture-state metadata, not
  // captured content.
  for (const term of ['private-bank', 'Bank statement', 'Secret research', 'SecretApp', 'Hidden work']) {
    assert.deepEqual(findDatabaseTextMatches(db, term), [], `"${term}" must not exist on any surface`)
  }
  assert.equal(searchAll(db, 'Bank statement', { limit: 10 }).length, 0)
})

test('display visibility: the second-monitor Coursera stretch is presence evidence — in the day, never in the totals', () => {
  const start = dayMs(9, 20)
  const end = dayMs(11, 20)
  insertFocusEvents(db, [displayEvent(start, 'display_visible_changed')])
  const heartbeats: FocusEventInsert[] = []
  for (let ts = start + 10_000; ts <= end; ts += 10_000) heartbeats.push(displayEvent(ts, 'display_visible_sampled'))
  insertFocusEvents(db, heartbeats)

  const payload = getTimelineDayPayload(db, DAY, null, { materialize: false })
  const spans = payload.secondaryDisplay ?? []
  assert.ok(spans.length >= 1, 'the second monitor is part of the day')
  const dia = spans.find((span) => span.appName === 'Dia')
  assert.ok(dia, 'the full-screen Dia stretch is present')
  assert.equal(dia!.presence, 'visible', 'labeled as visible — presence, not input focus')
  const visibleMinutes = (dia!.endTime - dia!.startTime) / 60_000
  assert.ok(visibleMinutes >= 115, `the ~2h stretch survives (got ${visibleMinutes}m)`)

  // Presence never inflates foreground truth: totalSeconds is exactly the sum
  // of the trusted blocks, which the visible span is not part of.
  const blockSum = payload.blocks.reduce((sum, block) => sum + blockActiveSeconds(block), 0)
  assert.equal(payload.totalSeconds, blockSum, 'Invariant 7: blocks are the canonical day facts')
})

test('day signals: the calendar day layer and a meeting note land for resolution', () => {
  // The stored external_signals 'calendar' layer — the same shape the live
  // zero-setup calendar probe writes (calendarSignals.ts).
  putExternalSignal(db, DAY, 'calendar', {
    events: [
      { title: 'Acme launch sync', startClock: '10:20', durationMinutes: 30, attendeeCount: 3 },
      { title: 'Roadmap review', startClock: '13:00', durationMinutes: 60, attendeeCount: null },
      { title: 'Hiring sync', startClock: '13:30', durationMinutes: 60, attendeeCount: null },
    ],
  } satisfies CalendarSignal)

  // A meeting-notes record in the connected ledger. The connector_records
  // table outlives the removed OAuth connector framework, and meeting
  // resolution still reads it for note corroboration.
  const now = Date.now()
  db.prepare(`
    INSERT INTO connector_records
      (id, connector_id, source_record_id, kind, date, retrieved_at, permission_scope, envelope_json, created_at, updated_at)
    VALUES (?, 'granola', 'note:doc-acme', 'meeting_record', ?, ?, 'local_file', ?, ?, ?)
  `).run(
    'rec-granola-acme', DAY, now,
    JSON.stringify({ notesSignal: { title: 'Acme launch sync', scheduledClock: '10:20' } }),
    now, now,
  )

  const calendarSignal = getExternalSignal<CalendarSignal>(db, DAY, 'calendar')?.payload
  assert.ok(calendarSignal, 'the calendar day signal exists')
  assert.equal(calendarSignal!.events.length, 3)
})

test('meetings: matched, captured-only, and double-booked calendar-only resolve honestly; scheduled context adds no time', () => {
  const payloadBefore = getTimelineDayPayload(db, DAY, null, { materialize: false })
  const report = resolveDayMeetingReport(db, DAY)
  assert.ok(report, 'the day has a meeting report')

  const acme = report!.meetings.find((meeting) => meeting.title === 'Acme launch sync')
  assert.ok(acme, 'the calendar+captured meeting resolved')
  assert.equal(acme!.attendance, 'matched', 'captured Zoom evidence supports "you met"')
  assert.equal(acme!.noteSupported, true, 'the Granola note attached to the matched meeting')
  assert.ok((acme!.observedSeconds ?? 0) >= 25 * 60, 'observed time comes from the captured span')

  const roadmap = report!.meetings.find((meeting) => meeting.title === 'Roadmap review')
  const hiring = report!.meetings.find((meeting) => meeting.title === 'Hiring sync')
  assert.ok(roadmap && hiring, 'both double-booked events are in the report')
  assert.equal(roadmap!.attendance, 'calendar_only', 'no meeting-app evidence: scheduled context only')
  assert.equal(hiring!.attendance, 'calendar_only')
  assert.equal(roadmap!.observedSeconds, null, 'calendar-only events never claim observed minutes')
  assert.equal(hiring!.observedSeconds, null)

  assert.equal(report!.capturedOnlyCount, 1, 'the ad-hoc Zoom call with no event is captured-only')
  const adhoc = report!.meetings.find((meeting) => meeting.attendance === 'captured_only')
  assert.ok(adhoc, 'the captured-only meeting is reported')

  // The day payload exposes scheduled meetings (captured-only excluded: it IS a block).
  const scheduled = payloadBefore.scheduledMeetings ?? []
  assert.equal(scheduled.length, 3, 'matched + two calendar-only entries ride the payload')
  assert.equal(scheduled.filter((meeting) => meeting.attendance === 'calendar_only').length, 2)
  assert.equal(scheduled.filter((meeting) => meeting.attendance === 'matched').length, 1)

  // Overlapping calendar events do not create additive time: the totals are
  // exactly the block sum, unmoved by the three scheduled events.
  const blockSum = payloadBefore.blocks.reduce((sum, block) => sum + blockActiveSeconds(block), 0)
  assert.equal(payloadBefore.totalSeconds, blockSum)
})

test('search: exact retrieval by name and semantic retrieval by meaning, over the same indexed day', async () => {
  ensureDayMemoryIndexed(db, DAY)

  // Exact, by name: the morning article title.
  const exactHits = searchExact(db, 'Prompts are technical debt')
  assert.ok(exactHits.length >= 1, 'exact search finds the article by its name')

  // By meaning: no shared words with the OLED page title.
  setSemanticEmbedderFactoryForTests(() => ({ ok: true, embedder: fixtureEmbedder }))
  let progress = await semanticIndexStep(db, fixtureEmbedder, { batchSize: 200 })
  while (!progress.done) progress = await semanticIndexStep(db, fixtureEmbedder, { batchSize: 200 })

  assert.equal(searchSessions(db, 'cheap television offers', { limit: 10 }).length, 0, 'exact search has no word overlap')
  const meaningHits = await searchByMeaning(db, 'cheap television offers', { limit: 10 })
  assert.ok(
    meaningHits.some((hit) => (hit.windowTitle ?? '').includes('OLED')),
    `semantic search finds the OLED page by meaning: ${meaningHits.map((hit) => hit.windowTitle).join(' | ')}`,
  )
})

test('supplied memory: the agent proposes, only explicit confirmation saves, and the fact is retrievable with supplied provenance', async () => {
  const asked: AgentQuestion[] = []
  const outcome = await runMemoryProposal(
    {
      db,
      askUser: async (question: AgentQuestion) => {
        asked.push(question)
        return 'Save to memory'
      },
    },
    { statement: 'ACME is a client; the Atlas rollout belongs to them.', futureUse: 'attribute Atlas work to ACME' },
  )
  assert.ok(outcome.saved, 'explicit confirmation persists the fact')
  assert.equal(asked.length, 1)
  assert.deepEqual(asked[0].options, ['Save to memory', "Don't save"])

  const facts = listSuppliedFacts(db)
  assert.equal(facts.length, 1)
  const suppliedHits = searchExact(db, 'Atlas rollout').filter((hit) => hit.sourceType === 'supplied')
  assert.ok(suppliedHits.length >= 1, 'the supplied fact is retrievable and labeled supplied')
})

test('correction: "that block was client research" — propose → preview → confirm applies, retires the day analysis, and is undoable', async () => {
  // A versioned analysis exists before the correction, so retirement is observable.
  const payload = getTimelineDayPayload(db, DAY, null, { materialize: false })
  appendDayAnalysisVersion(db, {
    kind: 'day', periodKey: DAY, factsHash: 'brutal-hash-1', model: null,
    promptVersion: 1, triggerSource: 'test', source: 'deterministic',
    payload: { summary: 'initial day analysis' },
  })

  const target = payload.blocks.find((block) => block.startTime <= dayMs(14, 0) && block.endTime >= dayMs(14, 0))
  assert.ok(target, 'the afternoon teardown block exists')

  const questions: AgentQuestion[] = []
  const deps: CorrectionToolDeps = {
    db,
    askUser: async (question) => {
      questions.push(question)
      return 'Apply correction'
    },
    hooks: { resolveLiveSession: () => null },
  }
  const tools = buildCorrectionTools(deps)
  const outcome = await (tools.propose_correction as unknown as {
    execute: (input: unknown, options: unknown) => Promise<Record<string, unknown>>
  }).execute({ action: 'rename', date: DAY, blockId: target!.id, label: 'Client research for ACME' }, {})

  assert.equal(questions.length, 1, 'the preview card was shown')
  assert.deepEqual(questions[0].options, ['Apply correction', 'Cancel'])
  assert.equal(outcome.applied, true)

  const after = getTimelineDayPayload(db, DAY, null, { materialize: false })
  const corrected = after.blocks.find((block) => block.id === target!.id || (block.startTime <= dayMs(14, 0) && block.endTime >= dayMs(14, 0)))
  assert.ok(corrected)
  assert.equal(corrected!.label.current, 'Client research for ACME', 'the correction is live on the Timeline')

  const undoCount = (db.prepare('SELECT COUNT(*) AS c FROM correction_undo_log').get() as { c: number }).c
  assert.ok(undoCount >= 1, 'the correction is undoable product data')

  // The correction retired the stale analysis version instead of erasing it.
  const versions = listDayAnalysisVersions(db, 'day', DAY)
  assert.ok(versions.length >= 1)
  assert.equal(versions[0].retiredReason, 'correction', 'the current version is retired with reason=correction, not deleted')

  // The corrected label is immediately searchable.
  ensureDayMemoryIndexed(db, DAY)
  assert.ok(searchExact(db, 'Client research for ACME').length >= 1)
})

test('context packet Q&A: the fixture model answers with verified citations while managed credit is exhausted — BYOK still answers', async () => {
  // The exhausted signed snapshot is armed process-wide (module top). Managed
  // AI is paused; the person's own key must keep working.
  const billing = await import('../src/main/services/billing.ts')
  billing.invalidateBillingAccess()
  const realFetch = globalThis.fetch
  globalThis.fetch = (() => Promise.reject(new Error('billing unreachable (brutalDay)'))) as typeof fetch
  try {
    const access = await billing.getBillingAccess({ force: true })
    assert.equal(access.canUseAI, false, 'managed AI is paused mid-afternoon')
  } finally {
    globalThis.fetch = realFetch
  }

  __setSettings({ aiProvider: 'anthropic', aiChatProvider: 'anthropic' })
  await setApiKey('anthropic', 'byok-test-key')
  try {
    const model = answerModel('The morning went to the ML roadmap in Notion, with the Coursera course full-screen on your second display. [C1] Nothing supports more than that [C99].')
    const result = await sendMessage(
      { message: `What did I study on the morning of ${DAY}?`, threadId: null, clientRequestId: 'brutal-turn-1' },
      { model },
    )

    // Citations: the verifiable marker rendered; the unbacked one vanished.
    const citations = result.assistantMessage.agent?.citations ?? []
    assert.equal(citations.length, 1, 'exactly one verified citation')
    assert.ok(result.assistantMessage.content.includes('¹'), 'the verified marker renders as a superscript')
    assert.ok(!result.assistantMessage.content.includes('[C99]'), 'the unverifiable marker is dropped')

    const bound = getContextPacketForMessage(db, result.assistantMessage.id)
    assert.ok(bound, 'the disclosure packet is bound to the answer')
    for (const citation of citations) {
      assert.ok(
        bound!.packet.items.some((item) => item.identity === citation.identity),
        'every persisted citation exists in the bound packet',
      )
    }

    // The inspector agrees with the packet exactly.
    const inspection = inspectContextPacket(db, { packetId: bound!.id })
    assert.ok(inspection)
    assert.equal(inspection!.contentFingerprint, bound!.packet.contentFingerprint, 'inspector fingerprint === packet fingerprint')
    assert.equal(inspection!.itemCount, bound!.packet.items.length, 'inspector item count === packet items')

    // The packet never carries what capture rejected.
    const packetJson = JSON.stringify(bound!.packet)
    for (const term of ['private-bank', 'Bank statement', 'SecretApp']) {
      assert.ok(!packetJson.includes(term), `the packet must not disclose "${term}"`)
    }
  } finally {
    await clearApiKey('anthropic')
    __resetSettings()
  }
})

test('entitlements: exhaustion is the calm pause — managed refuses before any provider call; the picker keeps BYOK selectable', async () => {
  const billing = await import('../src/main/services/billing.ts')
  billing.invalidateBillingAccess()
  const realFetch = globalThis.fetch
  const fetchCalls: string[] = []
  globalThis.fetch = ((input: unknown) => {
    fetchCalls.push(typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input))
    return Promise.reject(new Error('billing unreachable (brutalDay)'))
  }) as typeof fetch
  try {
    const access = await billing.getBillingAccess({ force: true })
    assert.equal(access.canUseAI, false)
    assert.match(access.message, /credit is used up/i, 'the calm exhaustion message, not an error')
    assert.match(access.message, /Timeline, Apps, search, corrections, export/, 'the local product is named as still working')
    assert.match(access.message, /your own key/i, 'BYOK is offered')

    assert.equal(await billing.getManagedAIConfig(), null, 'no managed session is minted while exhausted')
    assert.ok(!fetchCalls.some((url) => url.includes('/v1/ai/session')), 'no session-mint attempt while exhausted')

    // With no key stored, resolution fails closed — never a silent substitute.
    __setSettings({ aiProvider: 'anthropic', aiChatProvider: 'anthropic' })
    await assert.rejects(resolveProviderConfigsForJob('chat_answer', getSettings()), /AI access is paused/)

    // While the billing service is unreachable the snapshot is mode
    // 'unavailable' and the catalog honestly shows NO allowance block —
    // never a made-up figure.
    const unreachableCatalog = buildModelCostCatalog([{ provider: 'anthropic', modelId: 'claude-sonnet-4-5' }], access)
    assert.equal(unreachableCatalog.allowance, null, 'no invented allowance while the service is unreachable')
    assert.ok(unreachableCatalog.models[0].typicalQuestionCostUsd > 0, 'typical question cost is a dollar figure')

    // Dollars and "about N questions", never raw tokens: a reachable
    // exhausted snapshot reads 0 questions with the honest reason.
    const catalog = buildModelCostCatalog([{ provider: 'anthropic', modelId: 'claude-sonnet-4-5' }], {
      ...access,
      mode: 'free_credit',
      creditRemainingUsd: 0,
    })
    assert.ok(catalog.allowance, 'the allowance block exists for a reachable exhausted account')
    assert.equal(catalog.allowance!.estimatedQuestionsRemaining, 0)
    assert.equal(catalog.allowance!.canUseManagedAI, false)
    assert.match(catalog.allowance!.unavailableReason ?? '', /used up/i)

    const sources = buildModelSources({
      providerAvailability: { anthropic: true },
      billing: { mode: 'trial', canUseAI: false, message: access.message },
    })
    const managed = sources.find((source) => source.id === 'managed')
    const byok = sources.find((source) => source.id === 'byok:anthropic')
    assert.ok(managed, 'the managed source is listed (as paused), not hidden')
    assert.equal(managed!.available, false)
    assert.match(managed!.unavailableReason ?? '', /used up/i)
    assert.equal(byok?.available, true, 'BYOK stays selectable while managed is paused')
  } finally {
    globalThis.fetch = realFetch
    __resetSettings()
  }
})

test('deletion: purging one site removes it everywhere, and a backup restore cannot resurrect it past the journal replay', () => {
  // Capture the rows a backup would hold, then purge.
  purgedVisitRows = db.prepare(`SELECT * FROM website_visits WHERE domain LIKE '%tvdeals%'`).all() as Array<Record<string, unknown>>
  assert.ok(purgedVisitRows.length >= 1, 'the OLED visit existed before the purge')

  const result = deleteHistoryForSite({ domain: 'tvdeals.example' })
  assert.ok(result.deletedRows >= 1, 'the purge removed rows')
  appendDeletionJournalEntry(userData, { kind: 'site-history', params: { domain: 'tvdeals.example' } })

  assert.deepEqual(findDatabaseTextMatches(db, 'tvdeals.example'), [], 'the domain is gone from every table')
  assert.equal(searchAll(db, 'tvdeals', { limit: 10 }).length, 0)

  // Backup-restore replay honesty: restoring an old backup brings the rows
  // back — the journal replay must kill them again, idempotently.
  const columns = Object.keys(purgedVisitRows[0])
  const insert = db.prepare(
    `INSERT INTO website_visits (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  )
  for (const row of purgedVisitRows) insert.run(...columns.map((column) => row[column]))
  assert.ok((db.prepare(`SELECT COUNT(*) AS c FROM website_visits WHERE domain LIKE '%tvdeals%'`).get() as { c: number }).c >= 1, 'the restore resurrected the rows')

  const replay = replayDeletionJournal(db, userData)
  assert.ok(replay.replayed >= 1, 'the journal replayed')
  assert.equal(replay.failed, 0)
  assert.deepEqual(findDatabaseTextMatches(db, 'tvdeals.example'), [], 'the replay killed the restored rows again')

  // Reindexing after the purge never resurrects the purged page.
  ensureDayMemoryIndexed(db, DAY)
  assert.equal(searchAll(db, 'tvdeals', { limit: 10 }).length, 0)
})

test('evening: recap, day wrap, and weekly rollup reconcile exactly to Timeline/Apps; the fact-only line is fully grounded', () => {
  const payload = getTimelineDayPayload(db, DAY, null, { materialize: false })

  // Apps and Timeline agree exactly (capture-and-evidence.md acceptance).
  const apps = getAppSummariesForTimelineDay(db, DAY, null)
  const appsTotal = apps.reduce((sum, row) => sum + row.totalSeconds, 0)
  assert.equal(appsTotal, payload.totalSeconds, 'Apps total === Timeline total, exactly')

  // Day wrap facts are the same numbers (wrapped.md: totals reconcile exactly).
  const facts = buildDayWrapFacts(payload)
  assert.equal(facts.activeSeconds, payload.totalSeconds, 'wrap headline === Timeline total')
  assert.equal(
    facts.workSeconds + facts.leisureSeconds + facts.personalSeconds,
    facts.activeSeconds,
    'the split reconciles to the headline',
  )

  // The evening recap's deterministic line grounds every number in the fact
  // table (briefs.md: a brief can never disagree with the surface it opens).
  const line = factOnlyRecapLine(facts)
  assert.ok(line, 'the captured day produces a recap line')
  const table = buildDayFactTable(facts, payload.blocks, DAY)
  const forms = groundingFormsForRuntime(table, line!)
  assert.equal(firstUngroundedNumericToken(line!, forms), null, 'every number in the line is a fact-table fact')

  // Weekly rollup: freeze the day, roll the week, and the totals are the
  // exact sum of the frozen days.
  upsertDaySnapshot(db, { ...buildDaySnapshot(payload), finalizedAt: Date.now() })
  const week = buildWrappedPeriodFacts('week', DAY)
  assert.equal(week.totalSeconds, payload.totalSeconds, 'the week wrap total is exactly the sum of its frozen days')

  // The corrected label reached the wrap-facing surfaces too.
  const labels = payload.blocks.map((block) => block.label.current)
  assert.ok(labels.includes('Client research for ACME'), 'the correction is visible to the evening surfaces')
})

test('export: the history export contains the day honestly — purged and private content absent, withheld tables named', async () => {
  const plan = planHistoryExport(db)
  assert.ok(plan.omissions.some((omission) => (omission.tables ?? []).some((table) => table.startsWith('screen_context_frames'))), 'screen_context_frames is a named omission')
  assert.ok(plan.omissions.some((omission) => (omission.tables ?? []).some((table) => table.startsWith('screen_context_evidence'))), 'screen_context_evidence is a named omission')

  const destinationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-brutal-export-'))
  const result = await runHistoryExport(db, { destinationDir, appVersion: 'brutal-day-test' })
  assert.ok(result.ok, `export succeeded: ${JSON.stringify(result)}`)

  const exportDir = (result as { exportDir: string }).exportDir
  const everything: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else everything.push(fs.readFileSync(full, 'utf8'))
    }
  }
  walk(exportDir)
  const corpus = everything.join('\n')

  for (const term of ['tvdeals.example', 'private-bank', 'Bank statement', 'SecretApp']) {
    assert.ok(!corpus.includes(term), `the export must not contain "${term}"`)
  }
  assert.ok(corpus.includes('Client research for ACME'), 'the corrected label is what the export tells')
  assert.ok(corpus.includes('Acme launch sync'), 'the matched meeting is in the exported day')
})

// ─── The FSM boundary: passive reading hold + rapid switching bursts ─────────

test('capture FSM: a passive Coursera read holds the session live; sub-10s switch bursts never persist junk sessions', async () => {
  const fsmDb = createProductionTestDatabase()
  setTestDb(fsmDb)
  const BASE = dayMs(9, 0)
  const clockState = { now: BASE, lastInput: BASE }
  const flushes: Array<{ startTime: number; endTime: number; durationSeconds: number; endedReason: string; persisted: boolean }> = []
  const DIA_WIN = { title: 'Supervised Machine Learning | Coursera', application: 'Dia', path: '/Applications/Dia.app', pid: 7331, icon: '' }
  let activeWindow = DIA_WIN
  try {
    __setTrackingFsmTestHarness({
      platform: 'darwin',
      now: () => clockState.now,
      idleSeconds: () => Math.max(0, (clockState.now - clockState.lastInput) / 1_000),
      activeWindow: () => activeWindow,
      recordFlush: (info) => flushes.push(info as never),
    })
    __setActiveBrowserContextTrackerForTest(new ActiveBrowserContextTracker(
      () => ({ url: 'https://www.coursera.org/learn/machine-learning', title: DIA_WIN.title, modeKnown: true }),
      () => true,
    ))

    // 20 minutes of passive reading: zero input, the learning title holds.
    await __pollForTest()
    for (let step = 0; step < 40; step += 1) {
      clockState.now += 30_000
      await __pollForTest()
    }
    assert.ok(getCurrentSession(), 'the reading session is still live after 20 idle minutes')
    assert.equal(flushes.length, 0, 'the passive hold never flushed the session away')

    // The user comes back and switches away: the long session persists.
    clockState.lastInput = clockState.now
    activeWindow = { title: 'Desktop', application: 'Finder', path: '/System/Library/CoreServices/Finder.app', pid: 1, icon: '' }
    clockState.now += 30_000
    await __pollForTest()
    assert.ok(flushes.length >= 1, 'switching away flushed the held session')
    assert.ok(flushes[0].persisted, 'the ~20 minute read persisted')
    assert.ok(flushes[0].durationSeconds >= 15 * 60, `the hold kept the duration honest (got ${flushes[0].durationSeconds}s)`)

    // Rapid burst: 5-second flips between two apps must not persist sessions.
    const flushCountBeforeBurst = flushes.length
    const appA = { title: 'inbox', application: 'Slack', path: '/Applications/Slack.app', pid: 2, icon: '' }
    const appB = { title: 'terminal', application: 'Ghostty', path: '/Applications/Ghostty.app', pid: 3, icon: '' }
    for (let flip = 0; flip < 6; flip += 1) {
      activeWindow = flip % 2 === 0 ? appA : appB
      clockState.lastInput = clockState.now
      clockState.now += 5_000
      await __pollForTest()
    }
    const burstFlushes = flushes.slice(flushCountBeforeBurst)
    assert.ok(burstFlushes.length >= 2, 'the burst produced switch flushes')
    for (const flush of burstFlushes) {
      if (flush.durationSeconds < 10) {
        assert.equal(flush.persisted, false, `a ${flush.durationSeconds}s flicker must not persist`)
      }
    }
    const junk = fsmDb.prepare(
      `SELECT COUNT(*) AS c FROM app_sessions WHERE app_name IN ('Slack', 'Ghostty') AND duration_sec < 10`,
    ).get() as { c: number }
    assert.equal(junk.c, 0, 'no sub-10s junk sessions exist')
  } finally {
    __setTrackingFsmTestHarness(null)
    __setActiveBrowserContextTrackerForTest(null)
    setTestDb(db) // restore the brutal-day database for any later test
    fsmDb.close()
  }
})

// ─── Screen-context experiment ────────────────────────────────────────────────

const SCREEN_OPEN_GATE: ScreenCaptureGateContext = {
  consentEnabled: true,
  screenContextPaused: false,
  trackingPaused: false,
  foregroundExcluded: false,
  privateBrowser: false,
  protectedSurface: false,
  screenShareActive: false,
  protectedMediaActive: false,
}

const CALM_ENV: ScreenSamplingEnvironment = {
  onBattery: false, cpuPressure: false, locked: false, idle: false, asleep: false, fullScreenMedia: false,
}

function screenFrameStore(): FrameFileStore & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>()
  let seq = 0
  return {
    files,
    write(_id: string, bytes: Uint8Array) {
      const localPath = `/fake/brutal/frame_${seq++}.scframe`
      files.set(localPath, bytes)
      return { localPath, byteSize: bytes.byteLength }
    },
    read(localPath: string) {
      const bytes = files.get(localPath)
      if (!bytes) throw new Error('missing frame file')
      return bytes
    },
    delete(localPath: string) { files.delete(localPath) },
    list() { return [...files.keys()] },
  }
}

test('screen experiment: a password-manager surface is refused before any pixel is read', async () => {
  const screenDb = createProductionTestDatabase()
  try {
    assert.equal(isProtectedSurfaceTitle('1Password — Vaults'), true, 'the password manager title is a protected surface')

    const lifecycle = new ScreenContextLifecycle({
      db: screenDb,
      frameStore: screenFrameStore(),
      extractor: { async extract() { throw new Error('never reached') } },
      now: () => Date.now(),
      measure: () => {},
    })
    const sourceCalls: number[] = []
    const source: ScreenFrameSource = {
      kind: 'fake',
      async capture(displayId) {
        sourceCalls.push(displayId ?? -1)
        return new TextEncoder().encode('pixels')
      },
    }
    const settings: Partial<AppSettings> = {
      screenContextExperimentEnabled: true,
      screenContextPaused: false,
      trackingPaused: false,
      trackingControlsEnabled: true,
      trackingExcludedApps: [],
      trackingExcludedSites: [],
    }
    const session: LiveSession = {
      bundleId: 'com.1password.1password', appName: '1Password', startTime: 0,
      category: 'productivity', windowTitle: '1Password — Vaults',
    } as LiveSession
    const foreground: ForegroundSnapshot = {
      session, domain: null, privateBrowser: false,
      screenShareActive: false, protectedMediaActive: false, displayId: 7,
    }
    const clockState = { now: 1_800_000_000_000 }
    const sampler = new ScreenContextSampler({
      lifecycle,
      getSettings: () => settings as AppSettings,
      getForeground: () => foreground,
      getEnvironment: () => CALM_ENV,
      source,
      now: () => clockState.now,
      onActiveChange: () => {},
      scheduleTick: () => ({ unref() {} } as unknown as NodeJS.Timeout),
    })
    await sampler.tick('interval')
    clockState.now += 3_000
    const result = await sampler.tick('interval')
    assert.equal(result.captured, false)
    assert.equal(result.reason, 'protected_surface', 'the experiment refuses the protected surface')
    assert.equal(sourceCalls.length, 0, 'no pixel was ever read')
    assert.equal(listAllFrames(screenDb).length, 0, 'no ledger row exists')
  } finally {
    screenDb.close()
  }
})

test('screen experiment: the raw frame is deleted ONLY after its derived evidence commits; failure quarantines instead', async () => {
  const screenDb = createProductionTestDatabase()
  try {
    const store = screenFrameStore()
    const clockState = { now: Date.now() }
    const lifecycle = new ScreenContextLifecycle({
      db: screenDb,
      frameStore: store,
      extractor: {
        async extract() {
          return {
            docTitle: 'Quarterly budget', ocrSpans: ['budget line'], subjectRefs: [],
            bounding: { x: 0, y: 0, w: 1, h: 1 },
            extractorModel: 'fixture-extractor', extractorSchemaVersion: 1, confidence: 0.9,
          }
        },
      },
      now: () => clockState.now,
      measure: () => {},
    })
    const input: CapturedFrameInput = {
      bytes: new TextEncoder().encode('frame-pixels'),
      capturedAt: clockState.now,
      trigger: 'diagnostic',
      appBundleId: 'com.apple.Numbers',
      appName: 'Numbers',
      displayId: 1,
    }
    const captureResult = lifecycle.captureFrame(input, SCREEN_OPEN_GATE, CALM_ENV)
    assert.equal(captureResult.captured, true, 'the open gate admits the frame')
    const frame = captureResult.frame
    assert.ok(frame)
    assert.equal(store.files.size, 1, 'the raw frame is on disk')

    await lifecycle.processFrame(frame!.id)
    const frames = listAllFrames(screenDb)
    assert.equal(frames.length, 1)
    assert.equal(frames[0].state, 'deleted', 'the frame reached deleted through the one lifecycle')
    assert.equal(frames[0].deletedWithoutEvidence, false, 'never deleted before evidence committed')
    assert.equal(store.files.size, 0, 'the raw file is gone only after the commit')
    assert.equal(listAllEvidence(screenDb).length, 1, 'the derived evidence survives the raw deletion')

    // Failure path: the only copy is never deleted before extraction succeeds.
    const failingLifecycle = new ScreenContextLifecycle({
      db: screenDb,
      frameStore: store,
      extractor: { async extract() { throw new Error('ocr crashed') } },
      now: () => clockState.now,
      measure: () => {},
    })
    const failingResult = failingLifecycle.captureFrame(
      { ...input, capturedAt: clockState.now + 1_000 }, SCREEN_OPEN_GATE, CALM_ENV,
    )
    assert.equal(failingResult.captured, true)
    const failingFrame = failingResult.frame!
    await failingLifecycle.processFrame(failingFrame.id)
    const failed = listAllFrames(screenDb).find((row) => row.id === failingFrame.id)
    assert.ok(failed)
    assert.notEqual(failed!.state, 'deleted', 'a failed extraction never deletes the only copy')
    assert.equal(store.files.size, 1, 'the raw frame is retained for retry/quarantine')
  } finally {
    screenDb.close()
  }
})

// ─── Pause/resume checkpoints ─────────────────────────────────────────────────

test('pause/resume: a turn checkpoint survives restart as honest paused state, resumes, and closes terminally', () => {
  const opened = openTurnCheckpoint(db, { threadId: null, clientRequestId: 'brutal-req-1', question: 'How did my afternoon go?' })
  assert.equal(opened.phase, 'running')
  assert.ok(markTurnWaiting(db, opened.id, 'correction_confirmation'), 'agent-initiated waits ride the same machine')

  // "Restart": anything still running/awaiting degrades to paused(restart) —
  // incomplete work is marked accurately, never assumed done.
  const recovered = recoverInterruptedTurns(db)
  assert.ok(recovered >= 1)
  const paused = listPausedTurns(db)
  assert.equal(paused.length, 1)
  assert.equal(paused[0].pauseKind, 'restart')
  assert.equal(paused[0].question, 'How did my afternoon go?')

  const resumed = adoptTurnCheckpointForResume(db, opened.id, { clientRequestId: 'brutal-req-2' })
  assert.ok(resumed)
  assert.equal(resumed!.phase, 'running')

  assert.ok(closeTurnCheckpoint(db, opened.id))
  assert.equal(getTurnCheckpoint(db, opened.id), null, 'terminal phases delete the row — the thread owns finished turns')
})
