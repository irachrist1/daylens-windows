import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { SCHEMA_SQL } from '../src/main/db/schema.ts'
import { buildWeeklyBriefEvidencePack, buildWeeklyBriefScaffold, resolveWeeklyBriefContext, type WeeklyBriefContext } from '../src/main/lib/weeklyBrief.ts'
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
    isFocused?: boolean
    windowTitle?: string
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
    payload.windowTitle ?? null,
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

function buildFixtureDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(SCHEMA_SQL)

  insertAppSession(db, {
    bundleId: 'com.google.Chrome',
    appName: 'Google Chrome',
    startTime: localMs(2026, 4, 14, 10, 0),
    endTime: localMs(2026, 4, 14, 10, 55),
    category: 'browsing',
    windowTitle: 'Credit Limits and Context',
  })
  insertAppSession(db, {
    bundleId: 'com.anthropic.claude',
    appName: 'Claude',
    startTime: localMs(2026, 4, 14, 11, 0),
    endTime: localMs(2026, 4, 14, 12, 5),
    category: 'aiTools',
    isFocused: true,
    windowTitle: 'Day view functionality issues - Claude',
  })
  insertAppSession(db, {
    bundleId: 'com.google.Chrome',
    appName: 'Google Chrome',
    startTime: localMs(2026, 4, 15, 9, 20),
    endTime: localMs(2026, 4, 15, 10, 15),
    category: 'browsing',
    windowTitle: 'Warp Agents: AI Coding Agents in Your Terminal',
  })
  insertAppSession(db, {
    bundleId: 'com.microsoft.VSCode',
    appName: 'Code',
    startTime: localMs(2026, 4, 15, 10, 20),
    endTime: localMs(2026, 4, 15, 11, 30),
    category: 'development',
    isFocused: true,
    windowTitle: 'daylens-windows',
  })
  insertAppSession(db, {
    bundleId: 'com.google.Chrome',
    appName: 'Google Chrome',
    startTime: localMs(2026, 4, 16, 13, 0),
    endTime: localMs(2026, 4, 16, 14, 10),
    category: 'browsing',
    windowTitle: 'Automated Alignment Researchers: Using large language models to scale scalable oversight',
  })

  insertWebsiteVisit(db, {
    domain: 'chatgpt.com',
    title: 'Credit Limits and Context',
    url: 'https://chatgpt.com/c/credit-limits-context',
    visitTime: localMs(2026, 4, 14, 10, 5),
    durationSec: 900,
  })
  insertWebsiteVisit(db, {
    domain: 'claude.ai',
    title: 'Day view functionality issues - Claude',
    url: 'https://claude.ai/chat/day-view-functionality',
    visitTime: localMs(2026, 4, 14, 11, 15),
    durationSec: 840,
  })
  insertWebsiteVisit(db, {
    domain: 'warp.dev',
    title: 'Warp Agents: AI Coding Agents in Your Terminal',
    url: 'https://warp.dev/agents',
    visitTime: localMs(2026, 4, 15, 9, 25),
    durationSec: 820,
  })
  insertWebsiteVisit(db, {
    domain: 'developers.openai.com',
    title: 'Codex use cases',
    url: 'https://developers.openai.com/codex/use-cases',
    visitTime: localMs(2026, 4, 15, 9, 50),
    durationSec: 720,
  })
  insertWebsiteVisit(db, {
    domain: 'anthropic.com',
    title: 'Automated Alignment Researchers: Using large language models to scale scalable oversight',
    url: 'https://www.anthropic.com/research/automated-alignment-researchers',
    visitTime: localMs(2026, 4, 16, 13, 10),
    durationSec: 660,
  })
  insertWebsiteVisit(db, {
    domain: 'alignment.anthropic.com',
    title: 'Automated Weak-to-Strong Researcher',
    url: 'https://alignment.anthropic.com/weak-to-strong-researcher',
    visitTime: localMs(2026, 4, 16, 13, 35),
    durationSec: 600,
  })
  insertWebsiteVisit(db, {
    domain: 'youtube.com',
    title: "Claude's new Cursor killer just dropped - YouTube",
    url: 'https://youtube.com/watch?v=claude-cursor-killer',
    visitTime: localMs(2026, 4, 16, 16, 0),
    durationSec: 720,
  })
  insertWebsiteVisit(db, {
    domain: 'x.com',
    title: '(4) Home / X',
    url: 'https://x.com/home',
    visitTime: localMs(2026, 4, 16, 17, 0),
    durationSec: 2400,
  })
  insertWebsiteVisit(db, {
    domain: 'chatgpt.com',
    title: 'ChatGPT',
    url: 'https://chatgpt.com/',
    visitTime: localMs(2026, 4, 16, 17, 30),
    durationSec: 1800,
  })

  return db
}

function anchorDate(): Date {
  return new Date(2026, 3, 17, 10, 0, 0, 0)
}

test('routes AI exploration questions to the weekly brief path', async () => {
  const db = buildFixtureDb()
  const result = await routeInsightsQuestion('what have i explored AI related this week', anchorDate(), null, db)
  assert.ok(result)
  assert.equal(result?.kind, 'weeklyBrief')
  if (result?.kind === 'weeklyBrief') {
    assert.equal(result.briefContext.responseMode, 'exploration')
    assert.equal(result.briefContext.topic, 'AI')
  }
  db.close()
})

test('builds named weekly evidence instead of collapsing to domains', () => {
  const db = buildFixtureDb()
  const context = resolveWeeklyBriefContext('what have i read this week in my browsers', anchorDate(), null)
  assert.ok(context)
  const pack = buildWeeklyBriefEvidencePack(db, context as WeeklyBriefContext)
  const titles = pack.namedEvidence.map((item) => item.title)
  assert.ok(titles.includes('Codex use cases'))
  assert.ok(titles.includes('Warp Agents: AI Coding Agents in Your Terminal'))
  assert.ok(titles.includes('Credit Limits and Context'))
  assert.ok(pack.ambientUsage.some((item) => item.source === 'x.com'))
  assert.match(buildWeeklyBriefScaffold(context as WeeklyBriefContext, pack), /Codex use cases/)
  db.close()
})

test('reuses the weekly brief context for deeper follow-ups', async () => {
  const db = buildFixtureDb()
  const first = await routeInsightsQuestion('what have i explored AI related this week', anchorDate(), null, db)
  assert.ok(first && first.kind === 'weeklyBrief')
  const followUpContext: TemporalContext = first.kind === 'weeklyBrief'
    ? first.resolvedContext
    : { date: anchorDate(), timeWindow: null, weeklyBrief: null, entity: null }
  const second = await routeInsightsQuestion('gooo deepere', anchorDate(), followUpContext, db)
  assert.ok(second)
  assert.equal(second?.kind, 'weeklyBrief')
  if (second?.kind === 'weeklyBrief') {
    assert.equal(second.briefContext.responseMode, 'deepen')
    assert.equal(second.briefContext.topic, 'AI')
    assert.equal(second.briefContext.dateRange.startDate, first.briefContext.dateRange.startDate)
  }
  db.close()
})

test('turns exact reading follow-ups into literal weekly brief mode', async () => {
  const db = buildFixtureDb()
  const first = await routeInsightsQuestion('what have i explored AI related this week', anchorDate(), null, db)
  assert.ok(first && first.kind === 'weeklyBrief')
  const second = await routeInsightsQuestion('exactly what did i read?', anchorDate(), first.resolvedContext, db)
  assert.ok(second)
  assert.equal(second?.kind, 'weeklyBrief')
  if (second?.kind === 'weeklyBrief') {
    assert.equal(second.briefContext.responseMode, 'literal')
  }
  db.close()
})

test('keeps generic stats prompts on the deterministic weekly answer path', async () => {
  const db = buildFixtureDb()
  const result = await routeInsightsQuestion('focus score this week', anchorDate(), null, db)
  assert.ok(result)
  assert.equal(result?.kind, 'answer')
  if (result?.kind === 'answer') {
    assert.match(result.answer, /focus score \d+\/100/i)
  }
  db.close()
})
