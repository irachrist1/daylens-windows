import test from 'node:test'
import assert from 'node:assert/strict'
import type {
  ArtifactRef,
  DocumentRef,
  PageRef,
  WorkContextAppSummary,
  WorkContextBlock,
  WorkflowRef,
  WebsiteSummary,
} from '../src/shared/types.ts'
import { inferWorkIntent, workSubjectCandidates } from '../src/shared/workIntent.ts'
import { DEFAULT_TIMELINE_BLOCK_REVIEW } from '../src/shared/timelineReview.ts'

function makeApp(appName: string, category: WorkContextAppSummary['category'], totalSeconds: number, isBrowser = false): WorkContextAppSummary {
  return {
    bundleId: `${appName.toLowerCase()}.bundle`,
    appName,
    category,
    totalSeconds,
    sessionCount: 1,
    isBrowser,
  }
}

function makeWebsite(domain: string, totalSeconds: number, topTitle: string | null): WebsiteSummary {
  return {
    domain,
    totalSeconds,
    visitCount: 1,
    topTitle,
    browserBundleId: 'arc.bundle',
    canonicalBrowserId: 'arc',
  }
}

function makeArtifact(title: string, artifactType: ArtifactRef['artifactType'] = 'document'): ArtifactRef {
  return {
    id: `artifact:${title}`,
    artifactType,
    displayTitle: title,
    totalSeconds: 1800,
    confidence: 0.9,
    openTarget: { kind: 'unsupported', value: null },
  }
}

function makeDocumentRef(title: string): DocumentRef {
  return {
    ...makeArtifact(title, 'document'),
    artifactType: 'document',
    sourceSessionIds: [],
  }
}

function makePage(options: {
  title: string
  domain: string
  url: string
}): PageRef {
  return {
    id: `page:${options.domain}:${options.title}`,
    artifactType: 'page',
    displayTitle: options.title,
    pageTitle: options.title,
    domain: options.domain,
    totalSeconds: 1800,
    confidence: 0.9,
    openTarget: { kind: 'external_url', value: options.url },
    url: options.url,
    normalizedUrl: options.url,
  }
}

function makeWorkflow(label: string): WorkflowRef {
  return {
    id: `workflow:${label}`,
    signatureKey: label,
    label,
    confidence: 0.7,
    dominantCategory: 'development',
    canonicalApps: [],
    artifactKeys: [],
  }
}

function makeBlock(overrides: Partial<WorkContextBlock> = {}): WorkContextBlock {
  return {
    id: overrides.id ?? 'block-1',
    startTime: overrides.startTime ?? new Date('2026-04-20T09:00:00').getTime(),
    endTime: overrides.endTime ?? new Date('2026-04-20T10:00:00').getTime(),
    dominantCategory: overrides.dominantCategory ?? 'research',
    // Follow the dominant category so a fixture that overrides the category
    // stays internally consistent — a real block's distribution is derived
    // from its sites/apps and never contradicts its own evidence.
    categoryDistribution: overrides.categoryDistribution ?? { [overrides.dominantCategory ?? 'research']: 3600 },
    ruleBasedLabel: overrides.ruleBasedLabel ?? 'Research',
    aiLabel: overrides.aiLabel ?? null,
    sessions: overrides.sessions ?? [],
    topApps: overrides.topApps ?? [],
    websites: overrides.websites ?? [],
    keyPages: overrides.keyPages ?? [],
    pageRefs: overrides.pageRefs ?? [],
    documentRefs: overrides.documentRefs ?? [],
    topArtifacts: overrides.topArtifacts ?? [],
    workflowRefs: overrides.workflowRefs ?? [],
    label: overrides.label ?? {
      current: overrides.ruleBasedLabel ?? 'Research',
      source: 'rule',
      confidence: 0.6,
      narrative: null,
      ruleBased: overrides.ruleBasedLabel ?? 'Research',
      aiSuggested: overrides.aiLabel ?? null,
      override: null,
    },
    focusOverlap: overrides.focusOverlap ?? {
      totalSeconds: 0,
      pct: 0,
      sessionIds: [],
    },
    evidenceSummary: overrides.evidenceSummary ?? {
      apps: [],
      pages: [],
      documents: [],
      domains: [],
    },
    heuristicVersion: overrides.heuristicVersion ?? 'test',
    computedAt: overrides.computedAt ?? Date.now(),
    switchCount: overrides.switchCount ?? 1,
    confidence: overrides.confidence ?? 'medium',
    review: overrides.review ?? DEFAULT_TIMELINE_BLOCK_REVIEW,
    isLive: overrides.isLive ?? false,
    kind: overrides.kind,
    boundary: overrides.boundary,
  }
}

test('generic X home feed reads as leisure with no work subject', () => {
  // Post-redesign, a lone X home feed is leisure (the `kind` axis), so it
  // carries no work intent role and no subject — never "ambient browsing on
  // X" as if it were a workstream.
  const block = makeBlock({
    dominantCategory: 'browsing',
    topApps: [makeApp('Arc', 'browsing', 3600, true)],
    websites: [makeWebsite('x.com', 3600, 'X (Twitter)')],
    pageRefs: [makePage({ title: 'X (Twitter)', domain: 'x.com', url: 'https://x.com/home' })],
  })

  const intent = inferWorkIntent(block)

  assert.equal(intent.role, 'ambient')
  assert.equal(intent.subject, null)
  assert.match(intent.summary, /Leisure/)
})

test('coding plus generic X context still reads as execution on the named artifact', () => {
  const artifact = makeArtifact('src/renderer/views/Insights.tsx')
  const documentRef = makeDocumentRef('src/renderer/views/Insights.tsx')
  const block = makeBlock({
    dominantCategory: 'development',
    ruleBasedLabel: 'AI polish',
    topApps: [
      makeApp('Code', 'development', 3000),
      makeApp('Arc', 'browsing', 600, true),
    ],
    websites: [makeWebsite('x.com', 600, 'X (Twitter)')],
    pageRefs: [makePage({ title: 'X (Twitter)', domain: 'x.com', url: 'https://x.com/home' })],
    documentRefs: [documentRef],
    topArtifacts: [artifact],
  })

  const intent = inferWorkIntent(block)

  assert.equal(intent.role, 'execution')
  assert.equal(intent.subject, 'src/renderer/views/Insights.tsx')
  assert.match(intent.summary, /Execution work on src\/renderer\/views\/Insights\.tsx/)
})

test('github pull requests without an execution anchor read as review work', () => {
  const block = makeBlock({
    dominantCategory: 'development',
    ruleBasedLabel: 'GitHub',
    topApps: [makeApp('Arc', 'browsing', 2400, true)],
    websites: [makeWebsite('github.com', 2400, 'Fix recap summaries')],
    pageRefs: [
      makePage({
        title: 'Fix recap summaries',
        domain: 'github.com',
        url: 'https://github.com/daylens/daylens/pull/42',
      }),
    ],
    topArtifacts: [],
    switchCount: 1,
  })

  const intent = inferWorkIntent(block)

  assert.equal(intent.role, 'review')
  assert.equal(intent.subject, 'Fix recap summaries')
})

test('specific AI chats and threads read as research instead of generic browsing', () => {
  const block = makeBlock({
    dominantCategory: 'research',
    ruleBasedLabel: 'Research',
    topApps: [makeApp('Arc', 'research', 3600, true)],
    websites: [
      makeWebsite('chatgpt.com', 1800, 'Daily recap wording ideas'),
      makeWebsite('x.com', 1200, 'A long post about AI product UX'),
    ],
    pageRefs: [
      makePage({
        title: 'Daily recap wording ideas',
        domain: 'chatgpt.com',
        url: 'https://chatgpt.com/c/123',
      }),
      makePage({
        title: 'A long post about AI product UX',
        domain: 'x.com',
        url: 'https://x.com/someone/status/123',
      }),
    ],
  })

  const intent = inferWorkIntent(block)

  assert.equal(intent.role, 'research')
  assert.equal(intent.subject, 'Daily recap wording ideas')
  assert.match(intent.summary, /Research\/context gathering around Daily recap wording ideas/)
})

test('mixed browser blocks prefer concrete project pages over workflow app-pair labels', () => {
  const block = makeBlock({
    dominantCategory: 'browsing',
    ruleBasedLabel: 'X (Twitter)',
    topApps: [
      makeApp('Dia', 'browsing', 2200, true),
      makeApp('Warp', 'development', 240),
    ],
    websites: [
      makeWebsite('localhost', 1800, 'Daylens — Searchable work history for your laptop'),
      makeWebsite('x.com', 600, 'X (Twitter)'),
    ],
    pageRefs: [
      makePage({ title: 'Daylens — Searchable work history for your laptop', domain: 'localhost', url: 'http://localhost:3000/daylens' }),
      makePage({ title: 'X (Twitter)', domain: 'x.com', url: 'https://x.com/home' }),
    ],
    workflowRefs: [makeWorkflow('Dia + Warp')],
  })

  const intent = inferWorkIntent(block)

  assert.equal(intent.role, 'research')
  assert.equal(intent.subject, 'Daylens')
  assert.doesNotMatch(intent.summary, /Dia \+ Warp/)
})

test('noisy loading and entertainment pages do not become fake intent subjects', () => {
  const block = makeBlock({
    dominantCategory: 'browsing',
    ruleBasedLabel: 'Loading…',
    topApps: [
      makeApp('Dia', 'browsing', 1500, true),
      makeApp('Warp', 'development', 800),
    ],
    websites: [
      makeWebsite('app.raindrop.io', 400, 'Loading…'),
      makeWebsite('ww1.goojara.to', 300, 'Watch Inception (2010)'),
    ],
    pageRefs: [
      makePage({ title: 'Loading…', domain: 'app.raindrop.io', url: 'https://app.raindrop.io/my/0' }),
      makePage({ title: 'Watch Inception (2010)', domain: 'ww1.goojara.to', url: 'https://ww1.goojara.to/mKZNZ7' }),
    ],
    workflowRefs: [makeWorkflow('Dia + Warp')],
  })

  const intent = inferWorkIntent(block)

  assert.equal(intent.role, 'research')
  assert.equal(intent.subject, null)
  assert.doesNotMatch(intent.summary, /Dia \+ Warp|Watch Inception/)
})

test('browser episodes cut by meeting boundaries are coordination', () => {
  const block = makeBlock({
    dominantCategory: 'browsing',
    kind: 'work',
    topApps: [makeApp('Chrome', 'browsing', 2400, true)],
    pageRefs: [makePage({ title: 'Engineering sync', domain: 'meet.google.com', url: 'https://meet.google.com/abc-defg-hij' })],
    boundary: { startReasons: ['meeting-start'], endReasons: ['meeting-end'] },
  })

  assert.equal(inferWorkIntent(block).role, 'coordination')
})

test('browser-hosted documentation and research notes remain research', () => {
  const block = makeBlock({
    dominantCategory: 'writing',
    topApps: [makeApp('Chrome', 'writing', 3900, true)],
    pageRefs: [
      makePage({ title: 'ActivityWatch documentation', domain: 'activitywatch.net', url: 'https://activitywatch.net/docs' }),
      makePage({ title: 'Competitive research notes', domain: 'docs.google.com', url: 'https://docs.google.com/document/d/1' }),
    ],
  })

  assert.equal(inferWorkIntent(block).role, 'research')
})

test('browser-hosted operational trackers are coordination, not writing execution', () => {
  const block = makeBlock({
    dominantCategory: 'writing',
    topApps: [makeApp('Chrome', 'writing', 1320, true)],
    pageRefs: [
      makePage({ title: 'Budget tracker', domain: 'docs.google.com', url: 'https://docs.google.com/spreadsheets/d/1' }),
    ],
  })

  assert.equal(inferWorkIntent(block).role, 'coordination')
})

// A channel artifact names the project it hosts; a DM or thread names the
// PERSON talked to. "Sarah Chen (DM)" once became the work subject of a
// comms block — a person is never what the work was about.
test('a channel artifact names the work; a DM or thread artifact never does', () => {
  const channelBlock = makeBlock({
    dominantCategory: 'communication',
    topApps: [makeApp('Slack', 'communication', 3600)],
    documentRefs: [makeDocumentRef('daylens (Channel)')],
    topArtifacts: [makeArtifact('daylens (Channel)')],
  })
  const channelIntent = inferWorkIntent(channelBlock)
  assert.match(channelIntent.subject ?? '', /daylens/i, 'a channel still names the project it hosts')
  assert.ok(channelIntent.subject && !/channel/i.test(channelIntent.subject), 'the (Channel) suffix never leaks')

  const dmBlock = makeBlock({
    dominantCategory: 'communication',
    topApps: [makeApp('Slack', 'communication', 3600)],
    documentRefs: [makeDocumentRef('Sarah Chen (DM)')],
    topArtifacts: [makeArtifact('Sarah Chen (DM)')],
  })
  const dmIntent = inferWorkIntent(dmBlock)
  assert.ok(!/sarah/i.test(dmIntent.subject ?? ''), `a DM partner became the subject: "${dmIntent.subject}"`)
  for (const candidate of workSubjectCandidates(dmBlock)) {
    assert.ok(!/sarah/i.test(candidate), `a DM partner reached the thread candidates: "${candidate}"`)
  }

  const threadBlock = makeBlock({
    dominantCategory: 'communication',
    topApps: [makeApp('Slack', 'communication', 3600)],
    documentRefs: [makeDocumentRef('Q3 planning (Thread)')],
    topArtifacts: [makeArtifact('Q3 planning (Thread)')],
  })
  const threadIntent = inferWorkIntent(threadBlock)
  assert.ok(!/q3 planning/i.test(threadIntent.subject ?? ''), `a thread title became the subject: "${threadIntent.subject}"`)
})

// A person-titled chat app names its windows with WHO is being talked to — a
// Teams chat window is the chat partner's name, with or without the app
// suffix. "Jamie Duffy" once became a real day's 75-minute work activity this
// way. Structural, not name detection: the artifact's OWNER app titles by
// conversation partner, so its window title never names the work. Slack is
// the counter-case — its titles lead with the channel, a project container.
test('a person-titled chat app window title never names the work', () => {
  const teamsApp = makeApp('Microsoft Teams', 'communication', 4500)
  const teamsArtifact = (title: string) => ({
    ...makeDocumentRef(title),
    artifactType: 'window' as const,
    ownerAppName: 'Microsoft Teams',
    ownerBundleId: teamsApp.bundleId,
  })

  for (const title of ['Jamie Duffy', 'Jamie Duffy | Microsoft Teams']) {
    const block = makeBlock({
      dominantCategory: 'communication',
      topApps: [teamsApp],
      documentRefs: [teamsArtifact(title)],
      topArtifacts: [teamsArtifact(title)],
    })
    const intent = inferWorkIntent(block)
    assert.ok(!/jamie/i.test(intent.subject ?? ''), `a chat partner became the subject: "${intent.subject}" (title "${title}")`)
    for (const candidate of workSubjectCandidates(block)) {
      assert.ok(!/jamie/i.test(candidate), `a chat partner reached the thread candidates: "${candidate}"`)
    }
  }

  // The same title from a NON-chat app still names the work — the rule is
  // about the producing app, not about detecting person names.
  const docBlock = makeBlock({
    dominantCategory: 'writing',
    topApps: [makeApp('Pages', 'writing', 3600)],
    documentRefs: [{
      ...makeDocumentRef('Jamie Duffy offer letter'),
      ownerAppName: 'Pages',
      ownerBundleId: 'pages.bundle',
    }],
  })
  assert.match(inferWorkIntent(docBlock).subject ?? '', /offer letter/i, 'a document from a writing app keeps naming the work')

  // Slack window titles lead with the CHANNEL — a project container that
  // legitimately names the work (the timeline eval pins this too).
  const slackBlock = makeBlock({
    dominantCategory: 'communication',
    topApps: [makeApp('Slack', 'communication', 3600)],
    documentRefs: [{
      ...makeDocumentRef('acme-portal'),
      artifactType: 'window' as const,
      ownerAppName: 'Slack',
      ownerBundleId: 'com.tinyspeck.slackmacgap',
    }],
  })
  assert.match(inferWorkIntent(slackBlock).subject ?? '', /acme-portal/i, 'a Slack channel window title keeps naming the work')
})
