// The wrap path end-to-end over on-demand backfill: generating a day wrap for
// a historical date collects that date's external signals through the
// registered backfill first, so the narrative can say what was PRODUCED
// (commits, meetings) — not only for the rolling today/yesterday window. A
// second wrap re-collects nothing, and a broken collector never breaks the wrap.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { clearTestDb, setTestDb } from './support/database-stub.mjs'
import {
  ensureExternalSignalsForDate,
  getExternalSignal,
  registerExternalSignalBackfill,
  type CollectExternalSignalsDeps,
} from '../src/main/services/externalSignals.ts'
import { getWrappedNarrative } from '../src/main/services/wrappedNarrative.ts'
import type { DayTimelinePayload, GitActivitySignal } from '../src/shared/types.ts'

const DATE = '2026-04-03' // months behind the background collector's window

const GIT_SIGNAL: GitActivitySignal = {
  repos: [{ repo: 'daylens', commitCount: 73, messages: ['ship the release'], firstCommitClock: '9:12am', lastCommitClock: '11:30pm' }],
  totalCommits: 73,
  prs: [],
}

function emptyDayPayload(): DayTimelinePayload {
  return {
    date: DATE,
    sessions: [],
    websites: [],
    blocks: [],
    segments: [],
    focusSessions: [],
    computedAt: Date.now(),
    version: 'test',
    totalSeconds: 0,
    focusSeconds: 0,
    focusPct: 0,
    appCount: 0,
    siteCount: 0,
  }
}

test('a wrap of a historical day backfills its signals once; the second wrap re-collects nothing', async () => {
  const db = createProductionTestDatabase()
  setTestDb(db)
  const calls = { git: 0 }
  const deps: CollectExternalSignalsDeps = {
    db,
    collectGit: async () => { calls.git += 1; return GIT_SIGNAL },
    collectCalendar: async () => null,
    collectFocus: async () => null,
    enrichmentSources: {},
    isConsentCurrent: () => true,
  }
  registerExternalSignalBackfill((date) => ensureExternalSignalsForDate(db, date, { deps }))
  try {
    const first = await getWrappedNarrative(emptyDayPayload())
    assert.ok(first, 'the wrap generates')
    assert.equal(
      getExternalSignal<GitActivitySignal>(db, DATE, 'git')?.payload.totalCommits, 73,
      'the wrap collected the release day\'s commits on demand',
    )
    assert.equal(calls.git, 1)

    const second = await getWrappedNarrative(emptyDayPayload())
    assert.ok(second)
    assert.equal(calls.git, 1, 'the second wrap re-runs no connector')
  } finally {
    registerExternalSignalBackfill(async () => {})
    clearTestDb()
    db.close()
  }
})

test('a backfill that rejects outright still produces a wrap', async () => {
  const db = createProductionTestDatabase()
  setTestDb(db)
  registerExternalSignalBackfill(async () => { throw new Error('collection down') })
  try {
    const narrative = await getWrappedNarrative(emptyDayPayload())
    assert.ok(narrative.lines, 'the wrap degrades to no enrichment, never a crash')
    assert.equal(getExternalSignal(db, DATE, 'git'), null)
  } finally {
    registerExternalSignalBackfill(async () => {})
    clearTestDb()
    db.close()
  }
})
