// Apps day totals reconcile exactly with Timeline (invariant 7: the trusted
// Timeline blocks are the canonical day facts, and every downstream total
// reads the same partition). This module rolls one day's trusted blocks into
// per-application summaries whose grand total equals the Timeline payload's
// totalSeconds to the second — the same date and filters can no longer show
// two different day lengths in Timeline and Apps.
//
// Lives outside activityFacts.ts because it consumes the Timeline payload
// (workBlocks), which itself imports the corrected-activity seam.

import type Database from 'better-sqlite3'
import type { AppCategory, AppUsageSummary, LiveSession, WorkContextBlock } from '@shared/types'
import { FOCUSED_CATEGORIES } from '@shared/types'
import { blockActiveSeconds } from '@shared/blockDuration'
import { resolveCanonicalApp } from '../lib/appIdentity'
import { getStoredCanonicalAppLinks } from '../core/inference/appIdentityRegistry'
import { getTimelineDayPayload } from './workBlocks'

// Stable identity for time whose application is unknown (apps.md failure
// behavior: missing application identity never drops time).
export const UNKNOWN_APP_ID = 'unknown-app'

interface ShareProto {
  bundleId: string
  appName: string
  canonicalAppId: string | null
  category: AppCategory
}

interface Share {
  key: string
  proto: ShareProto
  weight: number
}

interface Accumulator {
  proto: ShareProto
  seconds: number
  categorySeconds: Map<AppCategory, number>
  sessionCount: number
  lastSessionEnd: number | null
}

function appKeyFor(
  bundleId: string,
  appName: string,
  canonicalAppId: string | null | undefined,
  canonicalLinks: ReadonlyMap<string, string>,
): {
  key: string
  proto: ShareProto
} {
  const identity = resolveCanonicalApp(bundleId, appName)
  // The stored registry link remaps a twin's derived key onto its canonical
  // counterpart, so one installed app never becomes two rows (DEV-239). The
  // remap runs AFTER the per-session derivation because the canonical
  // projection stamps a catalog miss with the raw bundle/path id.
  const derivedKey = canonicalAppId ?? identity.canonicalAppId ?? bundleId
  const key = canonicalLinks.get(derivedKey) ?? derivedKey
  return {
    key,
    proto: {
      bundleId,
      appName: identity.displayName || appName,
      canonicalAppId: key,
      category: 'uncategorized',
    },
  }
}

/** Integer apportionment of `total` across weighted shares (largest
 *  remainder), so the credited seconds always sum to exactly `total`. */
function apportion(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((acc, weight) => acc + Math.max(0, weight), 0)
  if (sum <= 0 || total <= 0) return weights.map(() => 0)
  const raw = weights.map((weight) => (Math.max(0, weight) * total) / sum)
  const floors = raw.map((value) => Math.floor(value))
  let remainder = total - floors.reduce((acc, value) => acc + value, 0)
  const order = raw
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index)
  const out = [...floors]
  for (const { index } of order) {
    if (remainder <= 0) break
    out[index] += 1
    remainder -= 1
  }
  return out
}

function sharesForBlock(
  block: WorkContextBlock,
  canonicalLinks: ReadonlyMap<string, string>,
): { shares: Share[]; sessionBacked: boolean } {
  if (block.sessions.length > 0) {
    return {
      sessionBacked: true,
      shares: block.sessions.map((session) => {
        const { key, proto } = appKeyFor(session.bundleId, session.appName, session.canonicalAppId, canonicalLinks)
        return { key, proto: { ...proto, category: session.category }, weight: Math.max(0, session.durationSeconds) }
      }),
    }
  }
  // A persisted block whose member ids no longer resolve (evidence migrated
  // underneath it) still carries its per-app evidence summary; those recorded
  // seconds are the best remaining attribution.
  return {
    sessionBacked: false,
    shares: (block.topApps ?? []).map((app) => {
      const { key, proto } = appKeyFor(app.bundleId, app.appName, app.canonicalAppId, canonicalLinks)
      return { key, proto: { ...proto, category: app.category }, weight: Math.max(0, app.totalSeconds) }
    }),
  }
}

/**
 * Per-application summaries for one local day, partitioned by the same
 * trusted Timeline blocks the Timeline payload totals. Invariant: the sum of
 * every summary's totalSeconds equals the payload's totalSeconds exactly.
 */
export function getAppSummariesForTimelineDay(
  db: Database.Database,
  date: string,
  liveSession?: LiveSession | null,
): AppUsageSummary[] {
  const payload = getTimelineDayPayload(db, date, liveSession, { materialize: false })
  const canonicalLinks = getStoredCanonicalAppLinks(db)
  const perApp = new Map<string, Accumulator>()

  const credit = (key: string, proto: ShareProto, seconds: number, category: AppCategory) => {
    if (seconds <= 0) return
    const entry = perApp.get(key) ?? {
      proto,
      seconds: 0,
      categorySeconds: new Map<AppCategory, number>(),
      sessionCount: 0,
      lastSessionEnd: null,
    }
    entry.seconds += seconds
    entry.categorySeconds.set(category, (entry.categorySeconds.get(category) ?? 0) + seconds)
    perApp.set(key, entry)
  }

  const unknownProto: ShareProto = {
    bundleId: UNKNOWN_APP_ID,
    appName: 'Unknown app',
    canonicalAppId: UNKNOWN_APP_ID,
    category: 'uncategorized',
  }

  for (const block of payload.blocks) {
    const base = blockActiveSeconds(block)
    const { shares, sessionBacked } = sharesForBlock(block, canonicalLinks)
    const weightSum = shares.reduce((acc, share) => acc + share.weight, 0)

    if (weightSum <= 0) {
      credit(UNKNOWN_APP_ID, unknownProto, base, block.dominantCategory)
      continue
    }

    const rounded = shares.map((share) => Math.round(share.weight))
    const roundedSum = rounded.reduce((acc, value) => acc + value, 0)
    if (sessionBacked || roundedSum >= base) {
      // Session-backed blocks (and over-counted evidence) apportion the
      // block's active seconds exactly across the shares.
      const credited = apportion(base, shares.map((share) => share.weight))
      shares.forEach((share, index) => credit(share.key, share.proto, credited[index], share.proto.category))
    } else {
      // Truncated evidence lists under-count the block: the listed apps keep
      // their recorded seconds and the remainder is honestly unknown rather
      // than inflated onto the wrong applications.
      shares.forEach((share, index) => credit(share.key, share.proto, rounded[index], share.proto.category))
      credit(UNKNOWN_APP_ID, unknownProto, base - roundedSum, block.dominantCategory)
    }

    // Session counts use the same 2-minute-gap rule as the range rollup.
    if (sessionBacked) {
      const ordered = [...block.sessions].sort((a, b) => a.startTime - b.startTime)
      for (const session of ordered) {
        const { key } = appKeyFor(session.bundleId, session.appName, session.canonicalAppId, canonicalLinks)
        const entry = perApp.get(key)
        if (!entry) continue
        if (entry.lastSessionEnd == null || session.startTime - entry.lastSessionEnd >= 2 * 60_000) {
          entry.sessionCount += 1
        }
        entry.lastSessionEnd = Math.max(
          entry.lastSessionEnd ?? session.startTime,
          session.endTime ?? session.startTime + session.durationSeconds * 1_000,
        )
      }
    }
  }

  return [...perApp.entries()].map(([key, entry]) => {
    const category: AppCategory = [...entry.categorySeconds.entries()]
      .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'uncategorized'
    return {
      bundleId: entry.proto.bundleId,
      canonicalAppId: entry.proto.canonicalAppId ?? key,
      appName: entry.proto.appName,
      category,
      totalSeconds: entry.seconds,
      isFocused: FOCUSED_CATEGORIES.includes(category),
      ...(entry.sessionCount > 0 ? { sessionCount: entry.sessionCount } : {}),
    }
  }).sort((a, b) => b.totalSeconds - a.totalSeconds)
}
