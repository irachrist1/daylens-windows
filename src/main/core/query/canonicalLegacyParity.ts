// Local-only comparison of canonical shared-query facts vs legacy app_sessions.
// Differences are recorded on disk for migration measurement — never sent to analytics.

import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { ownedDayBounds } from '../../lib/dayOwnership'
import { legacyAppSessionsAsAppSessions, listLegacyAppSessionInputs } from '../evidence/legacyAdapter'
import {
  queryCorrectedActivityFactsForDay,
  type CorrectedActivityDayFacts,
} from './activityFactsQuery'

export interface CanonicalLegacyDayParity {
  date: string
  comparedAt: string
  canonical: {
    evidenceSource: CorrectedActivityDayFacts['evidenceSource']
    sessionCount: number
    totalSeconds: number
    focusSeconds: number
    gapCount: number
    focusEventCount: number
  }
  legacy: {
    sessionCount: number
    totalSeconds: number
    focusSeconds: number
  }
  delta: {
    sessionCount: number
    totalSeconds: number
    focusSeconds: number
  }
  notes: string[]
}

export function compareCanonicalAndLegacyDay(
  db: Database.Database,
  date: string,
  options: { nowMs?: number; asOfMs?: number } = {},
): CanonicalLegacyDayParity {
  const [fromMs, dayEndMs] = ownedDayBounds(db, date)
  const asOfMs = options.asOfMs ?? dayEndMs
  const canonical = queryCorrectedActivityFactsForDay(db, date, {
    nowMs: options.nowMs,
    asOfMs,
  })
  const legacySessions = legacyAppSessionsAsAppSessions(
    listLegacyAppSessionInputs(db, fromMs, asOfMs),
  )
  const legacyTotal = legacySessions.reduce((sum, session) => sum + session.durationSeconds, 0)
  const legacyFocusRaw = legacySessions
    .filter((session) => session.isFocused)
    .reduce((sum, session) => sum + session.durationSeconds, 0)
  const legacyFocus = Math.min(legacyFocusRaw, legacyTotal)

  const notes: string[] = []
  if (canonical.evidenceSource === 'legacy') {
    notes.push('No canonical focus_events in range; shared query fell back to legacy sessions.')
  } else if (canonical.evidenceSource === 'mixed') {
    notes.push('Both focus_events and legacy app_sessions present; shared query used canonical projection.')
  }
  if (canonical.focusSeconds > canonical.totalSeconds) {
    notes.push('Invariant broken: canonical focusSeconds exceeded totalSeconds.')
  }
  if (Math.abs(canonical.totalSeconds - legacyTotal) > 0) {
    notes.push(
      `Tracked duration differs by ${canonical.totalSeconds - legacyTotal}s (canonical − legacy).`,
    )
  }

  return {
    date,
    comparedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
    canonical: {
      evidenceSource: canonical.evidenceSource,
      sessionCount: canonical.sessions.length,
      totalSeconds: canonical.totalSeconds,
      focusSeconds: canonical.focusSeconds,
      gapCount: canonical.gaps.length,
      focusEventCount: canonical.focusEventCount,
    },
    legacy: {
      sessionCount: legacySessions.length,
      totalSeconds: legacyTotal,
      focusSeconds: legacyFocus,
    },
    delta: {
      sessionCount: canonical.sessions.length - legacySessions.length,
      totalSeconds: canonical.totalSeconds - legacyTotal,
      focusSeconds: canonical.focusSeconds - legacyFocus,
    },
    notes,
  }
}

/** Write a parity report to a local directory. Never phones home. */
export function writeLocalCanonicalLegacyParityReport(
  report: CanonicalLegacyDayParity,
  directory: string,
): string {
  fs.mkdirSync(directory, { recursive: true })
  const filePath = path.join(directory, `${report.date}-canonical-vs-legacy.json`)
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return filePath
}

export function formatCanonicalLegacyParitySideBySide(report: CanonicalLegacyDayParity): string {
  const lines = [
    `Canonical vs legacy — ${report.date}`,
    `  canonical: ${report.canonical.totalSeconds}s tracked, ${report.canonical.focusSeconds}s focused, ${report.canonical.sessionCount} sessions (${report.canonical.evidenceSource}, ${report.canonical.focusEventCount} focus_events)`,
    `  legacy:    ${report.legacy.totalSeconds}s tracked, ${report.legacy.focusSeconds}s focused, ${report.legacy.sessionCount} sessions`,
    `  delta:     ${report.delta.totalSeconds}s tracked, ${report.delta.focusSeconds}s focused, ${report.delta.sessionCount} sessions`,
  ]
  for (const note of report.notes) lines.push(`  note: ${note}`)
  return lines.join('\n')
}
