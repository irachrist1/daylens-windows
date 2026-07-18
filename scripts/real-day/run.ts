import Database from 'better-sqlite3'
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_PRIVATE_ROOT,
  REAL_DAY_SCHEMA_VERSION,
  acceptReviewedCandidate,
  assertLocalOnly,
  compareObservations,
  comparisonFailureLines,
  comparisonHasChanges,
  copyConfigIfPresent,
  createConsistentSnapshot,
  discoverProductionUserData,
  fixtureDirectory,
  loadJson,
  loadRealDayManifest,
  prepareWorkingCopy,
  selectRecentCompleteDay,
  sha256File,
  writePrivateJson,
  type AcceptedRealDay,
  type ObservedEpisode,
  type RealDayManifest,
  type RealDayObservation,
} from './lib'

interface Args {
  command: 'prepare' | 'evaluate' | 'accept'
  root: string
  date: string | null
  source: string | null
  refresh: boolean
  confirmed: boolean
}

function parseArgs(argv: string[]): Args {
  const command = argv[0]
  if (command !== 'prepare' && command !== 'evaluate' && command !== 'accept') {
    throw new Error(
      'Usage: real-day <prepare|evaluate|accept> [--date YYYY-MM-DD] [--root PATH] [--source-user-data PATH] [--refresh] [--confirmed]',
    )
  }
  const value = (name: string): string | null => {
    const index = argv.indexOf(name)
    return index >= 0 ? (argv[index + 1] ?? null) : null
  }
  return {
    command,
    root: path.resolve(
      value('--root') ?? process.env.DAYLENS_REAL_DAY_ROOT ?? DEFAULT_PRIVATE_ROOT,
    ),
    date: value('--date'),
    source: value('--source-user-data') ?? process.env.DAYLENS_REAL_USER_DATA ?? null,
    refresh: argv.includes('--refresh'),
    confirmed: argv.includes('--confirmed'),
  }
}

function dayBounds(date: string): [number, number] {
  const [year, month, day] = date.split('-').map(Number)
  const start = new Date(year, month - 1, day).getTime()
  return [start, new Date(year, month - 1, day + 1).getTime()]
}

function clock(ms: number): string {
  const value = new Date(ms)
  return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`
}

function formatDuration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds / 60))
  const hours = Math.floor(rounded / 60)
  const minutes = rounded % 60
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

function labelForBlock(block: any): string {
  return (
    block.review?.correctedLabel ??
    block.label?.current ??
    block.aiLabel ??
    block.ruleBasedLabel ??
    'Unlabeled activity'
  )
}

function episode(block: any): ObservedEpisode {
  return {
    id: String(block.id),
    startMs: Number(block.startTime),
    endMs: Number(block.endTime),
    activeSeconds: Math.round(
      (block.sessions ?? []).reduce(
        (sum: number, session: any) => sum + Number(session.durationSeconds ?? 0),
        0,
      ),
    ),
    label: labelForBlock(block),
    category: String(block.dominantCategory ?? 'uncategorized'),
    kind: typeof block.kind === 'string' ? block.kind : null,
    apps: (block.topApps ?? []).slice(0, 5).map((item: any) => ({
      name: String(item.appName),
      seconds: Math.round(Number(item.totalSeconds ?? 0)),
    })),
    pages: [
      ...new Set(
        (block.pageRefs ?? [])
          .map((item: any) => String(item.title ?? item.pageTitle ?? ''))
          .filter(Boolean),
      ),
    ].slice(0, 5) as string[],
  }
}

function titleOfSearchResult(result: any): string {
  return String(result.title ?? result.pageTitle ?? result.appName ?? result.excerpt ?? '').trim()
}

function buildHours(
  db: Database.Database,
  date: string,
  projection: any,
  capturedSessions: any[],
): RealDayObservation['hours'] {
  const [fromMs, toMs] = dayBounds(date)
  const visits = (() => {
    try {
      return db
        .prepare(
          `
        SELECT visit_time AS visitTime, duration_sec AS durationSec, page_title AS pageTitle
        FROM website_visits
        WHERE visit_time >= ? AND visit_time < ?
        ORDER BY visit_time
      `,
        )
        .all(fromMs, toMs) as Array<{
        visitTime: number
        durationSec: number
        pageTitle: string | null
      }>
    } catch {
      return []
    }
  })()

  const allSessions = [...capturedSessions, ...projection.sessions].sort(
    (left, right) => left.startTime - right.startTime,
  )
  const first =
    allSessions.length > 0 ? Math.max(0, new Date(allSessions[0].startTime).getHours()) : 0
  const lastSession = allSessions.at(-1)
  const last = lastSession ? Math.min(23, new Date(lastSession.startTime).getHours()) : 23
  const hours: RealDayObservation['hours'] = []
  for (let hour = first; hour <= last; hour += 1) {
    const start = fromMs + hour * 60 * 60_000
    const end = Math.min(toMs, start + 60 * 60_000)
    const capturedSecondsByApp = new Map<string, number>()
    const titles = new Set<string>()
    for (const session of capturedSessions) {
      const capturedEnd = Math.min(
        session.endTime ?? end,
        session.startTime + Number(session.durationSeconds ?? 0) * 1000,
      )
      const overlap = Math.max(0, Math.min(end, capturedEnd) - Math.max(start, session.startTime))
      if (overlap <= 0) continue
      capturedSecondsByApp.set(
        session.appName,
        (capturedSecondsByApp.get(session.appName) ?? 0) + Math.round(overlap / 1000),
      )
      if (session.windowTitle?.trim()) titles.add(session.windowTitle.trim())
    }
    let timelineActiveSeconds = 0
    for (const session of projection.sessions) {
      const capturedEnd = Math.min(
        session.endTime ?? end,
        session.startTime + Number(session.durationSeconds ?? 0) * 1000,
      )
      timelineActiveSeconds += Math.round(
        Math.max(0, Math.min(end, capturedEnd) - Math.max(start, session.startTime)) / 1000,
      )
    }
    const pages = [
      ...new Set(
        visits
          .filter(
            (visit) =>
              visit.visitTime < end &&
              visit.visitTime + Math.max(1, visit.durationSec) * 1000 > start,
          )
          .map((visit) => visit.pageTitle?.trim())
          .filter((value): value is string => Boolean(value)),
      ),
    ].slice(0, 5)
    const blocks = projection.blocks
      .filter((block: any) => block.startTime < end && block.endTime > start)
      .map(labelForBlock)
      .filter((value: string, index: number, all: string[]) => all.indexOf(value) === index)
    const capturedActiveSeconds = [...capturedSecondsByApp.values()].reduce(
      (sum, seconds) => sum + seconds,
      0,
    )
    const capturedApps = [...capturedSecondsByApp.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([name, seconds]) => ({ name, seconds }))
    hours.push({
      hour: `${String(hour).padStart(2, '0')}:00–${hour === 23 ? '24:00' : `${String(hour + 1).padStart(2, '0')}:00`}`,
      capturedActiveSeconds,
      timelineActiveSeconds,
      missingFromTimelineSeconds: Math.max(0, capturedActiveSeconds - timelineActiveSeconds),
      capturedApps,
      titles: [...titles].slice(0, 6),
      pages,
      blocks,
    })
  }
  return hours
}

async function prepare(args: Args): Promise<{ manifest: RealDayManifest; fixtureDir: string }> {
  const discovered = discoverProductionUserData(args.source ?? undefined)
  const sourceDb = path.join(discovered.userDataPath, 'daylens.sqlite')
  if (!fs.existsSync(sourceDb))
    throw new Error(`Live Daylens database was not found at ${sourceDb}`)

  const selector = new Database(sourceDb, { readonly: true, fileMustExist: true })
  selector.pragma('query_only = ON')
  let selected
  try {
    selected = args.date
      ? selectRecentCompleteDay(selector, {
          beforeDate: new Date(new Date(`${args.date}T12:00:00`).getTime() + 86_400_000)
            .toISOString()
            .slice(0, 10),
          minimumSeconds: 1,
          minimumSessions: 1,
        })
      : selectRecentCompleteDay(selector)
    if (args.date && selected.date !== args.date)
      throw new Error(`Requested date ${args.date} has no captured activity.`)
  } finally {
    selector.close()
  }

  const targetDir = fixtureDirectory(args.root, selected.date)
  const manifestPath = path.join(targetDir, 'manifest.json')
  if (fs.existsSync(manifestPath) && !args.refresh) {
    const existing = loadRealDayManifest(manifestPath)
    const snapshot = path.join(targetDir, existing.input.database.relativePath)
    if (sha256File(snapshot) !== existing.input.database.sha256)
      throw new Error('Existing pristine snapshot hash does not match its manifest.')
    return { manifest: existing, fixtureDir: targetDir }
  }

  const staging = `${targetDir}.staging-${process.pid}`
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(path.join(staging, 'pristine'), { recursive: true, mode: 0o700 })
  const snapshot = path.join(staging, 'pristine', 'daylens.sqlite')
  const sha256 = await createConsistentSnapshot(sourceDb, snapshot)
  const copiedConfig = copyConfigIfPresent(discovered.userDataPath, path.dirname(snapshot))
  const manifest: RealDayManifest = {
    schemaVersion: REAL_DAY_SCHEMA_VERSION,
    id: `real-${selected.date}`,
    name: `Reviewed real day ${selected.date}`,
    date: selected.date,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    description: 'Private local production-data fixture captured through SQLite online backup.',
    input: {
      kind: 'private-database-copy',
      database: {
        relativePath: 'pristine/daylens.sqlite',
        sha256,
      },
      privateReplay: {
        configRelativePath: copiedConfig ? 'pristine/config.json' : null,
        capturedAt: new Date().toISOString(),
        source: {
          selector: discovered.selector,
          userDataPath: discovered.userDataPath,
          databasePath: sourceDb,
        },
      },
    },
    review: { state: 'draft', sourceHash: sha256 },
    privacy: { localOnly: true, ciAllowed: false, containsRealUserData: true },
  }
  writePrivateJson(path.join(staging, 'manifest.json'), manifest)
  loadRealDayManifest(path.join(staging, 'manifest.json'))
  if (fs.existsSync(targetDir)) {
    const accepted = path.join(targetDir, 'accepted.json')
    if (fs.existsSync(accepted)) fs.copyFileSync(accepted, path.join(staging, 'accepted.json'))
  }
  fs.rmSync(targetDir, { recursive: true, force: true })
  fs.renameSync(staging, targetDir)
  return { manifest, fixtureDir: targetDir }
}

async function evaluate(args: Args): Promise<RealDayObservation> {
  const prepared = await prepare(args)
  const { manifest, fixtureDir } = prepared
  const snapshot = path.join(fixtureDir, manifest.input.database.relativePath)
  if (sha256File(snapshot) !== manifest.input.database.sha256)
    throw new Error('Pristine snapshot changed after capture; refusing evaluation.')
  const workingUserData = prepareWorkingCopy(fixtureDir)
  process.env.DAYLENS_HARNESS_USERDATA = workingUserData
  app.setPath('userData', workingUserData)

  const [{ initDb, getDb, closeDb }, { initSettings }] = await Promise.all([
    import('../../src/main/services/database'),
    import('../../src/main/services/settings'),
  ])
  await initSettings()
  initDb()
  const db = getDb()
  try {
    const [
      { getTimelineDayProjection },
      { getTimelineDayPayload },
      { getCorrectedAppSummariesForRange, getCorrectedSessionsForRange },
      { searchAll },
      { getExternalSignal },
      { resolveDayEnrichment },
      { getWorkMemoryProfile, chatMemoryPromptBlock },
      { executeTool },
      { queryCorrectedActivityFactsForDay },
      {
        compareCanonicalAndLegacyDay,
        formatCanonicalLegacyParitySideBySide,
        writeLocalCanonicalLegacyParityReport,
      },
    ] = await Promise.all([
      import('../../src/main/core/query/projections'),
      import('../../src/main/services/workBlocks'),
      import('../../src/main/services/activityFacts'),
      import('../../src/main/db/queries'),
      import('../../src/main/services/externalSignals'),
      import('../../src/main/services/enrichmentResolve'),
      import('../../src/main/services/workMemoryProfile'),
      import('../../src/main/services/aiTools'),
      import('../../src/main/core/query/activityFactsQuery'),
      import('../../src/main/core/query/canonicalLegacyParity'),
    ])
    const [fromMs, toMs] = dayBounds(manifest.date)
    const projection = getTimelineDayProjection(db, manifest.date, null, { materialize: false })
    const direct = getTimelineDayPayload(db, manifest.date, null, { materialize: false })
    const apps = getCorrectedAppSummariesForRange(db, fromMs, toMs)
    const capturedSessions = getCorrectedSessionsForRange(db, fromMs, toMs)
    const sharedFacts = queryCorrectedActivityFactsForDay(db, manifest.date, { asOfMs: toMs })
    const parity = compareCanonicalAndLegacyDay(db, manifest.date, { asOfMs: toMs })
    const parityPath = writeLocalCanonicalLegacyParityReport(
      parity,
      path.join(fixtureDir, 'local-parity'),
    )
    console.log(formatCanonicalLegacyParitySideBySide(parity))
    console.log(
      `Shared query: ${formatDuration(sharedFacts.totalSeconds)} tracked / ${formatDuration(sharedFacts.focusSeconds)} focused (${sharedFacts.evidenceSource}, ${sharedFacts.sessions.length} sessions) — side by side with today's production path: Timeline ${formatDuration(Math.round(projection.totalSeconds))}, Apps ${formatDuration(apps.reduce((sum, item) => sum + Math.round(item.totalSeconds), 0))}`,
    )
    console.log(`Local parity report (not analytics): ${parityPath}`)
    const projectionEpisodes = projection.blocks.map(episode)
    const directEpisodes = direct.blocks.map(episode)
    const appItems = apps.map((item) => ({
      id: item.canonicalAppId ?? item.bundleId,
      name: item.appName,
      category: item.category,
      seconds: Math.round(item.totalSeconds),
      sessionCount: item.sessionCount ?? 0,
    }))
    const calendar = getExternalSignal<any>(db, manifest.date, 'calendar')?.payload ?? null
    const enrichment = resolveDayEnrichment(db, manifest.date)
    const meetings = [
      ...(Array.isArray(calendar?.events)
        ? calendar.events.map((event: any) => ({
            source: 'calendar' as const,
            title: String(event.title ?? 'Untitled meeting'),
            start: typeof event.startClock === 'string' ? event.startClock : null,
            minutes: Math.round(Number(event.durationMinutes ?? 0)),
          }))
        : []),
      ...projectionEpisodes
        .filter((item) => item.category === 'meetings')
        .map((item) => ({
          source: 'timeline' as const,
          title: item.label,
          start: clock(item.startMs),
          minutes: Math.round(item.activeSeconds / 60),
        })),
      ...appItems
        .filter((item) => item.category === 'meetings')
        .map((item) => ({
          source: 'apps' as const,
          title: item.name,
          start: null,
          minutes: Math.round(item.seconds / 60),
        })),
    ]
    const querySeeds = [
      ...new Set(
        [projectionEpisodes[0]?.label, appItems[0]?.name, projection.websites[0]?.domain].filter(
          (value): value is string => Boolean(value),
        ),
      ),
    ].slice(0, 3)
    const search = querySeeds.map((query) => {
      const results = searchAll(db, query, {
        startDate: manifest.date,
        endDate: manifest.date,
        limit: 12,
      })
      return {
        query,
        resultCount: results.length,
        kinds: [...new Set(results.map((result: any) => String(result.type)))],
        topTitles: results.map(titleOfSearchResult).filter(Boolean).slice(0, 5),
      }
    })
    const profile = getWorkMemoryProfile(db)
    const dayTerms = new Set(
      [
        ...projectionEpisodes.flatMap((item) => item.label.toLowerCase().split(/\W+/)),
        ...appItems.slice(0, 10).flatMap((item) => item.name.toLowerCase().split(/\W+/)),
      ].filter((term) => term.length >= 4),
    )
    const activeFacts = profile.facts.filter((fact: any) => fact.status !== 'deleted')
    const relevantFacts = activeFacts
      .map((fact: any) => String(fact.text ?? fact.factText ?? ''))
      .filter((fact: string) => [...dayTerms].some((term) => fact.toLowerCase().includes(term)))
      .slice(0, 12)
    const dayOverview = executeTool('getDaySummary', { date: manifest.date }, db) as any
    const topAppUsage = appItems[0]
      ? executeTool(
          'getAppUsage',
          { appName: appItems[0].name, startDate: manifest.date, endDate: manifest.date },
          db,
        )
      : null
    const historySearch = querySeeds[0]
      ? executeTool(
          'searchSessions',
          { query: querySeeds[0], startDate: manifest.date, endDate: manifest.date, limit: 12 },
          db,
        )
      : null
    const projectionDirect = compareObservations(
      {
        timeline: { productionProjection: { episodes: directEpisodes } },
        apps: { items: appItems },
        meetings,
      } as RealDayObservation,
      {
        timeline: { productionProjection: { episodes: projectionEpisodes } },
        apps: { items: appItems },
        meetings,
      } as RealDayObservation,
    )
    const observation: RealDayObservation = {
      schemaVersion: REAL_DAY_SCHEMA_VERSION,
      fixtureId: manifest.id,
      evaluatedAt: new Date().toISOString(),
      date: manifest.date,
      sourceSha256: manifest.input.database.sha256,
      capture: {
        appSessions: Number(
          (
            db
              .prepare(
                'SELECT COUNT(*) AS count FROM app_sessions WHERE start_time >= ? AND start_time < ?',
              )
              .get(fromMs, toMs) as any
          ).count,
        ),
        focusEvents: Number(
          (
            db
              .prepare('SELECT COUNT(*) AS count FROM focus_events WHERE ts_ms >= ? AND ts_ms < ?')
              .get(fromMs, toMs) as any
          ).count,
        ),
        websiteVisits: Number(
          (
            db
              .prepare(
                'SELECT COUNT(*) AS count FROM website_visits WHERE visit_time >= ? AND visit_time < ?',
              )
              .get(fromMs, toMs) as any
          ).count,
        ),
        timelineBlocks: projectionEpisodes.length,
        firstActivity: projection.sessions.length ? clock(projection.sessions[0].startTime) : null,
        lastActivity: projection.sessions.length
          ? clock(projection.sessions.at(-1)?.endTime ?? projection.sessions.at(-1)?.startTime)
          : null,
      },
      timeline: {
        productionProjection: {
          version: projection.version,
          totalSeconds: Math.round(projection.totalSeconds),
          episodes: projectionEpisodes,
        },
        directPayload: {
          version: direct.version,
          totalSeconds: Math.round(direct.totalSeconds),
          episodes: directEpisodes,
        },
      },
      apps: {
        totalSeconds: appItems.reduce((sum, item) => sum + item.seconds, 0),
        items: appItems,
      },
      meetings,
      calendar: { stored: calendar, resolved: enrichment?.meetings ?? null },
      search,
      memory: {
        activeFactCount: activeFacts.length,
        relevantFacts,
        promptExcerpt: chatMemoryPromptBlock(db, `What happened on ${manifest.date}?`).slice(
          0,
          2000,
        ),
      },
      aiFacts: { dayOverview, topAppUsage, historySearch },
      hours: buildHours(db, manifest.date, projection, capturedSessions),
      agreement: {
        timelineAppsDeltaSeconds:
          Math.round(projection.totalSeconds) -
          appItems.reduce((sum, item) => sum + item.seconds, 0),
        aiTimelineDeltaSeconds:
          Math.round(Number(dayOverview?.totalTrackedSeconds ?? 0)) -
          Math.round(projection.totalSeconds),
        projectionDirect,
        acceptedBaseline: null,
      },
    }
    const baselinePath = path.join(fixtureDir, 'accepted.json')
    if (fs.existsSync(baselinePath)) {
      const accepted = loadJson<AcceptedRealDay>(baselinePath)
      observation.agreement.acceptedBaseline = compareObservations(accepted.expected, observation)
    }
    writePrivateJson(path.join(fixtureDir, 'candidate.json'), observation)
    writePrivateJson(path.join(fixtureDir, 'review.json'), {
      decision: 'pending',
      notes: '',
      expectations: {
        ai: {
          requiredFacts: [],
          prohibitedClaims: [],
        },
      },
      candidate: observation,
    })
    fs.writeFileSync(path.join(fixtureDir, 'wrapped.md'), renderWrapped(observation), {
      mode: 0o600,
    })
    return observation
  } finally {
    closeDb()
  }
}

function renderWrapped(observation: RealDayObservation): string {
  const lines = [
    `# Daylens reconstruction — ${observation.date}`,
    '',
    `Captured ${formatDuration(Number(observation.capture.appSessions ? observation.apps.totalSeconds : 0))} across ${observation.capture.appSessions} app sessions, ${observation.capture.focusEvents} focus events, and ${observation.capture.websiteVisits} browser visits.`,
    '',
    `Timeline reports ${formatDuration(observation.timeline.productionProjection.totalSeconds)}; Apps reports ${formatDuration(observation.apps.totalSeconds)}; their delta is ${formatDuration(Math.abs(observation.agreement.timelineAppsDeltaSeconds))}.`,
    '',
    '## Hour by hour',
    '',
  ]
  for (const hour of observation.hours) {
    const apps =
      hour.capturedApps.map((item) => `${item.name} ${formatDuration(item.seconds)}`).join(', ') ||
      'no captured app activity'
    const blocks = hour.blocks.join(' / ') || 'no Timeline block'
    const missing =
      hour.missingFromTimelineSeconds > 0
        ? ` ${formatDuration(hour.missingFromTimelineSeconds)} of captured activity is absent from Timeline.`
        : ''
    lines.push(
      `### ${hour.hour}`,
      '',
      `Timeline: ${blocks} (${formatDuration(hour.timelineActiveSeconds)}). Captured apps: ${apps}.${missing}`,
    )
    if (hour.titles.length > 0) lines.push('', `Captured context: ${hour.titles.join(' · ')}`)
    if (hour.pages.length > 0) lines.push('', `Pages: ${hour.pages.join(' · ')}`)
    lines.push('')
  }
  lines.push('## Timeline blocks', '')
  for (const block of observation.timeline.productionProjection.episodes) {
    lines.push(
      `- ${clock(block.startMs)}–${clock(block.endMs)} — ${block.label} (${formatDuration(block.activeSeconds)}, ${block.category})`,
    )
  }
  lines.push('', '## Meetings and calendar', '')
  if (observation.meetings.length === 0) lines.push('No meeting signal was found.')
  for (const meeting of observation.meetings) {
    lines.push(
      `- ${meeting.source}: ${meeting.start ? `${meeting.start} ` : ''}${meeting.title} (${meeting.minutes}m)`,
    )
  }
  lines.push('', '## Top apps', '')
  for (const appItem of observation.apps.items.slice(0, 15)) {
    lines.push(`- ${appItem.name}: ${formatDuration(appItem.seconds)} (${appItem.category})`)
  }
  lines.push('', '## Search and memory', '')
  for (const result of observation.search)
    lines.push(
      `- “${result.query}”: ${result.resultCount} results (${result.kinds.join(', ') || 'none'})`,
    )
  lines.push(
    `- Memory: ${observation.memory.activeFactCount} active facts; ${observation.memory.relevantFacts.length} matched this day's terms.`,
  )
  lines.push(
    '',
    '## Agreement checks',
    '',
    '```json',
    JSON.stringify(observation.agreement, null, 2),
    '```',
    '',
  )
  return `${lines.join('\n')}\n`
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  assertLocalOnly(args.root, path.resolve(import.meta.dirname, '..', '..'))
  fs.mkdirSync(args.root, { recursive: true, mode: 0o700 })
  fs.chmodSync(args.root, 0o700)

  if (args.command === 'prepare') {
    const { manifest, fixtureDir } = await prepare(args)
    console.log(`Prepared ${manifest.date} at ${fixtureDir}`)
    console.log(`Snapshot SHA-256: ${manifest.input.database.sha256}`)
    return
  }
  if (args.command === 'evaluate') {
    const observation = await evaluate(args)
    const fixtureDir = fixtureDirectory(args.root, observation.date)
    console.log(`Evaluated ${observation.date}`)
    console.log(`Candidate: ${path.join(fixtureDir, 'candidate.json')}`)
    console.log(`Wrapped review: ${path.join(fixtureDir, 'wrapped.md')}`)
    console.log(
      `Timeline ${formatDuration(observation.timeline.productionProjection.totalSeconds)}; Apps ${formatDuration(observation.apps.totalSeconds)}; delta ${observation.agreement.timelineAppsDeltaSeconds}s`,
    )
    if (
      observation.agreement.acceptedBaseline &&
      comparisonHasChanges(observation.agreement.acceptedBaseline)
    ) {
      console.error(
        `Accepted real-day baseline changed:\n- ${comparisonFailureLines(observation.agreement.acceptedBaseline).join('\n- ')}`,
      )
      process.exitCode = 1
    } else if (!observation.agreement.acceptedBaseline) {
      console.log(
        'No accepted baseline yet. review.json remains pending until the reconstruction is explicitly confirmed.',
      )
    }
    return
  }

  const targetDate = args.date
  if (!targetDate) throw new Error('accept requires --date YYYY-MM-DD')
  const fixtureDir = fixtureDirectory(args.root, targetDate)
  const accepted = acceptReviewedCandidate(
    path.join(fixtureDir, 'review.json'),
    path.join(fixtureDir, 'accepted.json'),
    { confirmed: args.confirmed },
  )
  const manifestPath = path.join(fixtureDir, 'manifest.json')
  const manifest = loadRealDayManifest(manifestPath)
  manifest.review = {
    state: 'accepted',
    reviewedAt: accepted.acceptedAt,
    sourceHash: manifest.input.database.sha256,
  }
  writePrivateJson(manifestPath, manifest)
  console.log(
    `Accepted reviewed real day ${targetDate} at ${path.join(fixtureDir, 'accepted.json')}`,
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
