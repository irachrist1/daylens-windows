import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { SCHEMA_SQL } from '../src/main/db/schema.ts'
import { routeInsightsQuestion, type TemporalContext } from '../src/main/lib/insightsQueryRouter.ts'

function localMs(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

function insertAppSession(
  db: Database.Database,
  payload: {
    bundleId: string
    appName: string
    startTime: number
    endTime: number
    category: string
    windowTitle: string
    isFocused?: boolean
  },
): void {
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id,
      app_name,
      start_time,
      end_time,
      duration_sec,
      category,
      is_focused,
      window_title,
      raw_app_name,
      capture_source,
      capture_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'test', 1)
  `).run(
    payload.bundleId,
    payload.appName,
    payload.startTime,
    payload.endTime,
    Math.max(1, Math.round((payload.endTime - payload.startTime) / 1000)),
    payload.category,
    payload.isFocused ? 1 : 0,
    payload.windowTitle,
    payload.appName,
  )
}

function insertWebsiteVisit(
  db: Database.Database,
  payload: {
    domain: string
    title: string
    url: string
    visitTime: number
    durationSec: number
  },
): void {
  db.prepare(`
    INSERT INTO website_visits (
      domain,
      page_title,
      url,
      visit_time,
      visit_time_us,
      duration_sec,
      browser_bundle_id,
      canonical_browser_id,
      browser_profile_id,
      normalized_url,
      page_key,
      source
    ) VALUES (?, ?, ?, ?, ?, ?, 'com.google.Chrome', 'chrome', 'default', ?, ?, 'history')
  `).run(
    payload.domain,
    payload.title,
    payload.url,
    payload.visitTime,
    BigInt(payload.visitTime) * 1000n,
    payload.durationSec,
    payload.url,
    payload.url,
  )
}

function seedCatalog(db: Database.Database): void {
  const now = localMs(2026, 4, 17, 12, 0)
  db.prepare(`INSERT INTO devices (id, hostname, platform, created_at) VALUES (?, ?, ?, ?)`)
    .run('device-1', 'benchmark-mac', 'windows', now)

  const insertApp = db.prepare(`
    INSERT INTO apps (bundle_id, app_name, category, attention_class, default_weight, created_at, updated_at)
    VALUES (?, ?, ?, 'primary', 1.0, ?, ?)
  `)
  insertApp.run('com.microsoft.VSCode', 'Visual Studio Code', 'development', now, now)
  insertApp.run('com.microsoft.Excel', 'Excel', 'productivity', now, now)
  insertApp.run('com.microsoft.Outlook', 'Outlook', 'email', now, now)
  insertApp.run('com.google.Chrome', 'Google Chrome', 'browsing', now, now)
  insertApp.run('com.microsoft.Word', 'Word', 'writing', now, now)

  const insertClient = db.prepare(`
    INSERT INTO clients (id, name, color, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `)
  insertClient.run('client-asyv', 'ASYV', '#7C3AED', now, now)
  insertClient.run('client-spcs', 'SPCS', '#0F766E', now, now)

  const insertAlias = db.prepare(`
    INSERT INTO client_aliases (id, client_id, alias, alias_normalized, source, created_at)
    VALUES (?, ?, ?, ?, 'benchmark', ?)
  `)
  insertAlias.run(randomUUID(), 'client-asyv', 'ASYV', 'asyv', now)
  insertAlias.run(randomUUID(), 'client-spcs', 'SPCS', 'spcs', now)

  const insertProject = db.prepare(`
    INSERT INTO projects (id, client_id, name, code, color, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
  `)
  insertProject.run('project-asyv-renewal', 'client-asyv', 'Renewal', 'ASYV-R', '#7C3AED', now, now)
  insertProject.run('project-spcs-rollout', 'client-spcs', 'Rollout', 'SPCS-R', '#0F766E', now, now)
}

function seedWorkSession(
  db: Database.Database,
  payload: {
    clientId: string
    projectId: string
    title: string
    bundleId: string
    startTime: number
    endTime: number
    attributionStatus?: 'attributed' | 'ambiguous' | 'unattributed'
    confidence?: number
    evidence: Array<{ type: string; value: string; weight: number }>
    candidateClients?: Array<{ clientId: string; confidence: number; rank: number }>
  },
): void {
  const sessionId = randomUUID()
  const segmentId = randomUUID()
  const createdAt = payload.startTime
  const durationMs = payload.endTime - payload.startTime
  const activeMs = durationMs
  const status = payload.attributionStatus ?? 'attributed'
  const confidence = payload.confidence ?? 0.92

  db.prepare(`
    INSERT INTO activity_segments (
      id,
      device_id,
      started_at,
      ended_at,
      duration_ms,
      primary_bundle_id,
      window_title,
      domain,
      file_path,
      input_score,
      attention_score,
      idle_ratio,
      class,
      raw_session_ids_json,
      created_at
    ) VALUES (?, 'device-1', ?, ?, ?, ?, ?, NULL, NULL, 0.8, 0.9, 0.0, 'active', '[]', ?)
  `).run(
    segmentId,
    payload.startTime,
    payload.endTime,
    durationMs,
    payload.bundleId,
    payload.title,
    createdAt,
  )

  const candidates = payload.candidateClients ?? [
    { clientId: payload.clientId, confidence, rank: 1 },
  ]
  const insertAttribution = db.prepare(`
    INSERT INTO segment_attributions (
      id,
      segment_id,
      client_id,
      project_id,
      score,
      confidence,
      rank,
      decision_source,
      matched_signals_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'benchmark', '[]', ?)
  `)
  for (const candidate of candidates) {
    insertAttribution.run(
      randomUUID(),
      segmentId,
      candidate.clientId,
      candidate.clientId === payload.clientId ? payload.projectId : null,
      candidate.confidence,
      candidate.confidence,
      candidate.rank,
      createdAt,
    )
  }

  db.prepare(`
    INSERT INTO work_sessions (
      id,
      device_id,
      started_at,
      ended_at,
      duration_ms,
      active_ms,
      idle_ms,
      client_id,
      project_id,
      attribution_status,
      attribution_confidence,
      title,
      primary_bundle_id,
      app_bundle_ids_json,
      created_at,
      updated_at
    ) VALUES (?, 'device-1', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    payload.startTime,
    payload.endTime,
    durationMs,
    activeMs,
    payload.clientId,
    payload.projectId,
    status,
    confidence,
    payload.title,
    payload.bundleId,
    JSON.stringify([payload.bundleId]),
    createdAt,
    createdAt,
  )

  db.prepare(`
    INSERT INTO work_session_segments (work_session_id, segment_id, role, contribution_ms)
    VALUES (?, ?, 'primary', ?)
  `).run(sessionId, segmentId, activeMs)

  const insertEvidence = db.prepare(`
    INSERT INTO work_session_evidence (
      id,
      work_session_id,
      evidence_type,
      evidence_value,
      weight,
      source_segment_id,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  for (const item of payload.evidence) {
    insertEvidence.run(randomUUID(), sessionId, item.type, item.value, item.weight, segmentId, createdAt)
  }
}

function seedUnattributedWorkSession(
  db: Database.Database,
  payload: {
    title: string
    bundleId: string
    startTime: number
    endTime: number
    evidence: Array<{ type: string; value: string; weight: number }>
  },
): void {
  const sessionId = randomUUID()
  const segmentId = randomUUID()
  const createdAt = payload.startTime
  const durationMs = payload.endTime - payload.startTime

  db.prepare(`
    INSERT INTO activity_segments (
      id,
      device_id,
      started_at,
      ended_at,
      duration_ms,
      primary_bundle_id,
      window_title,
      domain,
      file_path,
      input_score,
      attention_score,
      idle_ratio,
      class,
      raw_session_ids_json,
      created_at
    ) VALUES (?, 'device-1', ?, ?, ?, ?, ?, NULL, NULL, 0.8, 0.9, 0.0, 'active', '[]', ?)
  `).run(
    segmentId,
    payload.startTime,
    payload.endTime,
    durationMs,
    payload.bundleId,
    payload.title,
    createdAt,
  )

  db.prepare(`
    INSERT INTO work_sessions (
      id,
      device_id,
      started_at,
      ended_at,
      duration_ms,
      active_ms,
      idle_ms,
      client_id,
      project_id,
      attribution_status,
      attribution_confidence,
      title,
      primary_bundle_id,
      app_bundle_ids_json,
      created_at,
      updated_at
    ) VALUES (?, 'device-1', ?, ?, ?, ?, 0, NULL, NULL, 'unattributed', NULL, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    payload.startTime,
    payload.endTime,
    durationMs,
    durationMs,
    payload.title,
    payload.bundleId,
    JSON.stringify([payload.bundleId]),
    createdAt,
    createdAt,
  )

  db.prepare(`
    INSERT INTO work_session_segments (work_session_id, segment_id, role, contribution_ms)
    VALUES (?, ?, 'primary', ?)
  `).run(sessionId, segmentId, durationMs)

  const insertEvidence = db.prepare(`
    INSERT INTO work_session_evidence (
      id,
      work_session_id,
      evidence_type,
      evidence_value,
      weight,
      source_segment_id,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  for (const item of payload.evidence) {
    insertEvidence.run(randomUUID(), sessionId, item.type, item.value, item.weight, segmentId, createdAt)
  }
}

function buildFixtureDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(SCHEMA_SQL)
  seedCatalog(db)

  const asyvCodeStart = localMs(2026, 4, 15, 9, 0)
  const asyvCodeEnd = localMs(2026, 4, 15, 10, 20)
  insertAppSession(db, {
    bundleId: 'com.microsoft.VSCode',
    appName: 'Visual Studio Code',
    startTime: asyvCodeStart,
    endTime: asyvCodeEnd,
    category: 'development',
    windowTitle: 'ASYV renewal export flow - Visual Studio Code',
    isFocused: true,
  })
  seedWorkSession(db, {
    clientId: 'client-asyv',
    projectId: 'project-asyv-renewal',
    title: 'ASYV renewal export flow',
    bundleId: 'com.microsoft.VSCode',
    startTime: asyvCodeStart,
    endTime: asyvCodeEnd,
    evidence: [
      { type: 'window_title', value: 'ASYV renewal export flow', weight: 0.95 },
      { type: 'repo', value: 'daylens-windows', weight: 0.61 },
    ],
  })

  const asyvExcelStart = localMs(2026, 4, 15, 10, 30)
  const asyvExcelEnd = localMs(2026, 4, 15, 11, 10)
  insertAppSession(db, {
    bundleId: 'com.microsoft.Excel',
    appName: 'Excel',
    startTime: asyvExcelStart,
    endTime: asyvExcelEnd,
    category: 'productivity',
    windowTitle: 'ASYV Forecast.xlsx - Excel',
  })
  seedWorkSession(db, {
    clientId: 'client-asyv',
    projectId: 'project-asyv-renewal',
    title: 'ASYV Forecast.xlsx',
    bundleId: 'com.microsoft.Excel',
    startTime: asyvExcelStart,
    endTime: asyvExcelEnd,
    evidence: [
      { type: 'file', value: 'ASYV Forecast.xlsx', weight: 0.92 },
      { type: 'window_title', value: 'ASYV Forecast.xlsx - Excel', weight: 0.86 },
    ],
  })

  const asyvOutlookStart = localMs(2026, 4, 15, 11, 20)
  const asyvOutlookEnd = localMs(2026, 4, 15, 11, 50)
  insertAppSession(db, {
    bundleId: 'com.microsoft.Outlook',
    appName: 'Outlook',
    startTime: asyvOutlookStart,
    endTime: asyvOutlookEnd,
    category: 'email',
    windowTitle: 'ASYV renewal thread - Outlook',
  })
  seedWorkSession(db, {
    clientId: 'client-asyv',
    projectId: 'project-asyv-renewal',
    title: 'ASYV renewal thread',
    bundleId: 'com.microsoft.Outlook',
    startTime: asyvOutlookStart,
    endTime: asyvOutlookEnd,
    evidence: [
      { type: 'email_subject', value: 'ASYV renewal thread', weight: 0.91 },
      { type: 'window_title', value: 'ASYV renewal thread - Outlook', weight: 0.8 },
    ],
  })

  const asyvChromeStart = localMs(2026, 4, 15, 12, 0)
  const asyvChromeEnd = localMs(2026, 4, 15, 12, 30)
  insertAppSession(db, {
    bundleId: 'com.google.Chrome',
    appName: 'Google Chrome',
    startTime: asyvChromeStart,
    endTime: asyvChromeEnd,
    category: 'browsing',
    windowTitle: 'ASYV client portal - Google Chrome',
  })
  insertWebsiteVisit(db, {
    domain: 'portal.asyv.example',
    title: 'ASYV client portal',
    url: 'https://portal.asyv.example/client',
    visitTime: localMs(2026, 4, 15, 12, 5),
    durationSec: 20 * 60,
  })
  seedWorkSession(db, {
    clientId: 'client-asyv',
    projectId: 'project-asyv-renewal',
    title: 'ASYV client portal',
    bundleId: 'com.google.Chrome',
    startTime: asyvChromeStart,
    endTime: asyvChromeEnd,
    evidence: [
      { type: 'tab_title', value: 'ASYV client portal', weight: 0.9 },
      { type: 'domain', value: 'portal.asyv.example', weight: 0.84 },
    ],
  })

  const spcsWordStart = localMs(2026, 4, 16, 9, 0)
  const spcsWordEnd = localMs(2026, 4, 16, 10, 0)
  insertAppSession(db, {
    bundleId: 'com.microsoft.Word',
    appName: 'Word',
    startTime: spcsWordStart,
    endTime: spcsWordEnd,
    category: 'writing',
    windowTitle: 'SPCS onboarding plan.docx - Word',
    isFocused: true,
  })
  seedWorkSession(db, {
    clientId: 'client-spcs',
    projectId: 'project-spcs-rollout',
    title: 'SPCS onboarding plan.docx',
    bundleId: 'com.microsoft.Word',
    startTime: spcsWordStart,
    endTime: spcsWordEnd,
    evidence: [
      { type: 'file', value: 'SPCS onboarding plan.docx', weight: 0.94 },
      { type: 'window_title', value: 'SPCS onboarding plan.docx - Word', weight: 0.84 },
    ],
  })

  const spcsChromeStart = localMs(2026, 4, 16, 10, 10)
  const spcsChromeEnd = localMs(2026, 4, 16, 10, 50)
  insertAppSession(db, {
    bundleId: 'com.google.Chrome',
    appName: 'Google Chrome',
    startTime: spcsChromeStart,
    endTime: spcsChromeEnd,
    category: 'browsing',
    windowTitle: 'SPCS analytics review - Google Chrome',
  })
  insertWebsiteVisit(db, {
    domain: 'app.spcs.example',
    title: 'SPCS analytics review',
    url: 'https://app.spcs.example/review',
    visitTime: localMs(2026, 4, 16, 10, 15),
    durationSec: 25 * 60,
  })
  seedWorkSession(db, {
    clientId: 'client-spcs',
    projectId: 'project-spcs-rollout',
    title: 'SPCS analytics review',
    bundleId: 'com.google.Chrome',
    startTime: spcsChromeStart,
    endTime: spcsChromeEnd,
    evidence: [
      { type: 'tab_title', value: 'SPCS analytics review', weight: 0.88 },
      { type: 'domain', value: 'app.spcs.example', weight: 0.82 },
    ],
  })

  const ambiguousStart = localMs(2026, 4, 16, 11, 0)
  const ambiguousEnd = localMs(2026, 4, 16, 11, 30)
  insertAppSession(db, {
    bundleId: 'com.microsoft.Outlook',
    appName: 'Outlook',
    startTime: ambiguousStart,
    endTime: ambiguousEnd,
    category: 'email',
    windowTitle: 'Renewal scope sync - Outlook',
  })
  seedWorkSession(db, {
    clientId: 'client-asyv',
    projectId: 'project-asyv-renewal',
    title: 'Renewal scope sync',
    bundleId: 'com.microsoft.Outlook',
    startTime: ambiguousStart,
    endTime: ambiguousEnd,
    attributionStatus: 'ambiguous',
    confidence: 0.58,
    evidence: [
      { type: 'email_subject', value: 'Renewal scope sync', weight: 0.73 },
    ],
    candidateClients: [
      { clientId: 'client-asyv', confidence: 0.58, rank: 1 },
      { clientId: 'client-spcs', confidence: 0.51, rank: 2 },
    ],
  })

  return db
}

function buildEvidenceBackedFixtureDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(SCHEMA_SQL)
  seedCatalog(db)

  const workbookStart = localMs(2026, 4, 9, 9, 28)
  const workbookEnd = localMs(2026, 4, 9, 10, 32)
  insertAppSession(db, {
    bundleId: 'com.microsoft.Excel',
    appName: 'Excel',
    startTime: workbookStart,
    endTime: workbookEnd,
    category: 'productivity',
    windowTitle: 'ASYV 2M Immediate FY2027.xlsx - Excel',
  })
  seedUnattributedWorkSession(db, {
    title: 'ASYV 2M Immediate FY2027 spreadsheet',
    bundleId: 'com.microsoft.Excel',
    startTime: workbookStart,
    endTime: workbookEnd,
    evidence: [
      { type: 'file', value: 'ASYV 2M Immediate FY2027.xlsx', weight: 0.95 },
      { type: 'window_title', value: 'ASYV 2M Immediate FY2027.xlsx - Excel', weight: 0.9 },
    ],
  })

  const mailStart = localMs(2026, 4, 9, 10, 32)
  const mailEnd = localMs(2026, 4, 9, 11, 0)
  insertAppSession(db, {
    bundleId: 'com.microsoft.Outlook',
    appName: 'Outlook',
    startTime: mailStart,
    endTime: mailEnd,
    category: 'email',
    windowTitle: 'ASYV renewal thread - Outlook',
  })
  seedUnattributedWorkSession(db, {
    title: 'Spreadsheet and email coordination',
    bundleId: 'com.microsoft.Outlook',
    startTime: mailStart,
    endTime: mailEnd,
    evidence: [
      { type: 'email_subject', value: 'ASYV renewal thread', weight: 0.9 },
      { type: 'window_title', value: 'ASYV renewal thread - Outlook', weight: 0.82 },
    ],
  })

  return db
}

type BenchmarkCase = {
  name: string
  question: string
  shouldRoute: boolean
  assert?: (answer: string) => string | null
}

const CASES: BenchmarkCase[] = [
  {
    name: 'Canonical ASYV time query',
    question: 'How much time did I spend on ASYV this week?',
    shouldRoute: true,
    assert: (answer) => {
      if (!/ASYV/i.test(answer)) return 'answer should mention ASYV'
      if (!/attributed/i.test(answer)) return 'answer should summarize attributed time'
      return null
    },
  },
  {
    name: 'Monthly ASYV work breakdown',
    question: 'What have I been doing for ASYV this month and how much time have I spent on each, and in total?',
    shouldRoute: true,
    assert: (answer) => {
      if (!/ASYV/i.test(answer)) return 'answer should mention ASYV'
      if (!/this month/i.test(answer)) return 'answer should preserve the month range'
      if (!/ASYV renewal export flow|Forecast\.xlsx|renewal thread|client portal/i.test(answer)) return 'answer should mention concrete ASYV work items'
      return /attributed/i.test(answer) ? null : 'answer should summarize attributed time'
    },
  },
  {
    name: 'Canonical SPCS time query',
    question: 'How much time did I spend on SPCS this week?',
    shouldRoute: true,
    assert: (answer) => (/SPCS/i.test(answer) ? null : 'answer should mention SPCS'),
  },
  {
    name: 'List all clients',
    question: 'List all my clients this week.',
    shouldRoute: true,
    assert: (answer) => {
      if (/focus score|top apps/i.test(answer)) return 'answer fell back to a generic weekly summary'
      if (!/\bASYV\b/.test(answer) || !/\bSPCS\b/.test(answer)) return 'answer should enumerate both clients by name'
      return null
    },
  },
  {
    name: 'Compare clients with detail',
    question: 'Compare ASYV vs SPCS this week: time spent, what I was actually doing, and the main artifacts touched.',
    shouldRoute: true,
    assert: (answer) => {
      if (/focus score|top apps/i.test(answer)) return 'answer fell back to a generic weekly summary'
      if (!/\bASYV\b/.test(answer) || !/\bSPCS\b/.test(answer)) return 'answer should compare both clients by name'
      if (!/compare|more time|less time|than|versus|vs/i.test(answer)) return 'answer should express an actual comparison'
      return null
    },
  },
  {
    name: 'Client docs and tabs',
    question: 'Which docs or tabs matched ASYV this week?',
    shouldRoute: true,
    assert: (answer) => (/Forecast\.xlsx|client portal|renewal/i.test(answer) ? null : 'answer should mention concrete ASYV artifacts'),
  },
  {
    name: 'Client email evidence',
    question: 'Which ASYV emails mattered this week?',
    shouldRoute: true,
    assert: (answer) => {
      if (/focus score|top apps/i.test(answer)) return 'answer fell back to a generic weekly summary'
      return /Outlook|renewal thread/i.test(answer) ? null : 'answer should mention email evidence'
    },
  },
  {
    name: 'Client workbook evidence',
    question: 'Which ASYV workbooks were open this week?',
    shouldRoute: true,
    assert: (answer) => (/Forecast\.xlsx/i.test(answer) ? null : 'answer should mention the workbook'),
  },
  {
    name: 'Break client down by app',
    question: 'Break ASYV down by app this week.',
    shouldRoute: true,
    assert: (answer) => {
      if (/focus score|top apps/i.test(answer)) return 'answer fell back to a generic weekly summary'
      if (!/Visual Studio Code|Excel|Outlook|Chrome/i.test(answer)) return 'answer should mention an ASYV-specific app breakdown'
      if (/Word/i.test(answer)) return 'answer leaked another client into the ASYV app breakdown'
      return null
    },
  },
  {
    name: 'Canonical project time query',
    question: 'How much time did I spend on Renewal this week?',
    shouldRoute: true,
    assert: (answer) => {
      if (!/Renewal/i.test(answer)) return 'answer should mention the project name'
      if (!/ASYV/i.test(answer)) return 'answer should retain the parent client context'
      return /attributed/i.test(answer) ? null : 'answer should summarize attributed project time'
    },
  },
  {
    name: 'Break project down by app',
    question: 'Break Renewal down by app this week.',
    shouldRoute: true,
    assert: (answer) => {
      if (/focus score|top apps/i.test(answer)) return 'answer fell back to a generic weekly summary'
      if (!/Renewal by app/i.test(answer)) return 'answer should use the project label'
      if (!/Visual Studio Code|Excel|Outlook|Chrome/i.test(answer)) return 'answer should mention a project-specific app breakdown'
      if (/Word/i.test(answer)) return 'answer leaked another project into the Renewal app breakdown'
      return null
    },
  },
  {
    name: 'Project invoice-style narrative',
    question: 'If I had to invoice Renewal this week, what would the narrative line items be, and what time should I exclude as too ambiguous?',
    shouldRoute: true,
    assert: (answer) => {
      if (/focus score|top apps/i.test(answer)) return 'answer fell back to a generic weekly summary'
      if (!/Renewal/i.test(answer)) return 'answer should mention the project name'
      return /exclude|ambiguous|renewal|portal|forecast/i.test(answer) ? null : 'answer should create a project billable narrative'
    },
  },
  {
    name: 'Show client timeline',
    question: 'Show the ASYV timeline for this week.',
    shouldRoute: true,
    assert: (answer) => (/09:|10:|11:|12:/i.test(answer) ? null : 'answer should expose time-ordered activity'),
  },
  {
    name: 'Ambiguous sessions between clients',
    question: 'Which sessions are ambiguous between ASYV and SPCS this week, and why are they ambiguous?',
    shouldRoute: true,
    assert: (answer) => (/ambiguous|confidence|scope/i.test(answer) ? null : 'answer should discuss ambiguous evidence'),
  },
  {
    name: 'Invoice-style narrative',
    question: 'If I had to invoice ASYV this week, what would the narrative line items be, and what time should I exclude as too ambiguous?',
    shouldRoute: true,
    assert: (answer) => {
      if (/focus score|top apps/i.test(answer)) return 'answer fell back to a generic weekly summary'
      return /exclude|ambiguous|renewal|portal|forecast/i.test(answer) ? null : 'answer should create a billable narrative'
    },
  },
]

async function ask(
  db: Database.Database,
  question: string,
  previousContext: TemporalContext | null = null,
): Promise<Awaited<ReturnType<typeof routeInsightsQuestion>>> {
  return routeInsightsQuestion(question, new Date(2026, 3, 17, 12, 0, 0, 0), previousContext, db)
}

test('Windows entity prompt parity benchmark', async (t) => {
  for (const item of CASES) {
    await t.test(item.name, async () => {
      const db = buildFixtureDb()
      const result = await ask(db, item.question)
      const routed = result !== null
      const answer = result?.kind === 'answer' ? result.answer : '<falls through to provider>'

      assert.equal(
        routed,
        item.shouldRoute,
        `${item.name}: expected ${item.shouldRoute ? 'ROUTED' : 'FALLTHROUGH'}, got ${routed ? 'ROUTED' : 'FALLTHROUGH'}. Answer: ${answer}`,
      )

      if (routed && item.assert) {
        const assertionFailure = item.assert(answer)
        assert.equal(assertionFailure, null, `${item.name}: ${assertionFailure}. Answer: ${answer}`)
      }

      db.close()
    })
  }
})

test('Windows entity routing reuses prior client context for follow-ups', async () => {
  const db = buildFixtureDb()
  const first = await ask(db, 'How much time did I spend on ASYV this week?')
  assert.ok(first && first.kind === 'answer')
  assert.equal(first?.resolvedContext.entity?.entityName, 'ASYV')

  const second = await ask(db, 'break it down by app', first.resolvedContext)
  assert.ok(second && second.kind === 'answer')
  assert.match(second.answer, /ASYV by app/i)
  assert.match(second.answer, /Visual Studio Code|Excel|Outlook|Google Chrome/i)
  assert.doesNotMatch(second.answer, /Microsoft Word/i)

  db.close()
})

test('Windows entity routing reuses prior project context for follow-ups', async () => {
  const db = buildFixtureDb()
  const first = await ask(db, 'How much time did I spend on Renewal this week?')
  assert.ok(first && first.kind === 'answer')
  assert.equal(first?.resolvedContext.entity?.entityName, 'Renewal')
  assert.equal(first?.resolvedContext.entity?.entityType, 'project')

  const second = await ask(db, 'break it down by app', first.resolvedContext)
  assert.ok(second && second.kind === 'answer')
  assert.match(second.answer, /Renewal by app/i)
  assert.match(second.answer, /Visual Studio Code|Excel|Outlook|Google Chrome/i)
  assert.doesNotMatch(second.answer, /Microsoft Word/i)

  db.close()
})

test('Windows entity routing falls back to evidence-backed month answers when explicit attribution is missing', async () => {
  const db = buildEvidenceBackedFixtureDb()
  const result = await ask(db, 'What have I been doing for ASYV this month and how much time have I spent on each, and in total?')

  assert.ok(result && result.kind === 'answer')
  assert.match(result.answer, /ASYV in this month \(evidence-backed\):/i)
  assert.match(result.answer, /ASYV 2M Immediate FY2027|Spreadsheet and email coordination/i)
  assert.match(result.answer, /Excel|Outlook/i)
  assert.match(result.answer, /Structured client\/project attribution was missing/i)
  assert.equal(result.resolvedContext.entity?.entityType, 'evidence')
  assert.equal(result.resolvedContext.entity?.entityName, 'ASYV')

  db.close()
})

test('Windows entity routing reuses prior evidence-backed context for follow-ups', async () => {
  const db = buildEvidenceBackedFixtureDb()
  const first = await ask(db, 'What have I been doing for ASYV this month and how much time have I spent on each, and in total?')
  assert.ok(first && first.kind === 'answer')
  assert.equal(first.resolvedContext.entity?.entityType, 'evidence')

  const second = await ask(db, 'break it down by app', first.resolvedContext)
  assert.ok(second && second.kind === 'answer')
  assert.match(second.answer, /ASYV \(evidence-backed\) by app in this month/i)
  assert.match(second.answer, /Excel|Outlook/i)

  db.close()
})
