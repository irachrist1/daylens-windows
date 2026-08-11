// T3: delete already-captured history for an app or site the user just excluded
// (or wants gone). Deletes the source rows (app_sessions / website_visits), then
// rebuilds the affected day projections from what remains and notifies the
// surfaces so the data disappears from the timeline, Apps, AI answers, and
// search — "gone, not just hidden". Forward capture is stopped separately by the
// gate in tracking.ts / browserContext.ts.

import fs from 'node:fs'
import type Database from 'better-sqlite3'
import { getDb } from './database'
import { localDateString } from '../lib/localDate'
import { materializeTimelineDayProjection } from '../core/query/projections'
import { invalidateProjectionScope } from '../core/projections/invalidation'
import { projectDay } from '../core/projections/chunk2'
import { bumpRangeFactsEvidenceEpoch } from '../core/query/rangeFactsCache'
import { normalizeUrlForStorage, pageKeyForUrl, resolveCanonicalBrowser } from '../lib/appIdentity'

export interface PurgeResult {
  deletedRows: number
  affectedDates: string[]
}

export interface DeleteTrackedActivityInput {
  appSessionIds?: number[] | null
  derivedSessionIds?: number[] | null
  bundleId?: string | null
  canonicalAppId?: string | null
  appName?: string | null
  domain?: string | null
  url?: string | null
  normalizedUrl?: string | null
  pageKey?: string | null
  startTime?: number | null
  endTime?: number | null
  date?: string | null
}

function rematerializeAndNotify(affectedDates: string[]): void {
  if (affectedDates.length === 0) return
  const db = getDb()
  // Purges UPDATE evidence rows in place (title nulling), which the
  // range-facts cache's count/max signature cannot see. Bump the DB-backed
  // evidence epoch so every process's cache (main AND the range worker)
  // drops the stale windows — a purged title must never be served (DEV-227).
  bumpRangeFactsEvidenceEpoch(db)
  for (const date of affectedDates) {
    try {
      materializeTimelineDayProjection(db, date, null)
    } catch (err) {
      console.warn('[tracking-controls] re-materialize failed for', date, err)
    }
  }
  // Deleted activity can affect any read surface; refresh them all.
  invalidateProjectionScope('timeline', 'tracking_controls_purge')
  invalidateProjectionScope('apps', 'tracking_controls_purge')
  invalidateProjectionScope('insights', 'tracking_controls_purge')
}

function distinctLocalDates(timestamps: number[]): string[] {
  return [...new Set(timestamps.map((ms) => localDateString(new Date(ms))))]
}

function clearGeneratedActivitySummaries(db: ReturnType<typeof getDb>): void {
  // A page/domain deletion changes the evidence behind app recaps and wider
  // period summaries. Clear generated surfaces so no stale prose survives the
  // user's explicit deletion; the next Generate action rebuilds from what
  // remains.
  db.prepare('DELETE FROM ai_surface_summaries').run()
}

function escapeLike(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1')
}

function identifierPattern(value: string): RegExp {
  const escaped = value.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i')
}

export function deleteHistoryForApp(input: { bundleId?: string | null; appName?: string | null }): PurgeResult {
  const db = getDb()
  const bundle = (input.bundleId ?? '').trim()
  const name = (input.appName ?? '').trim()
  if (!bundle && !name) return { deletedRows: 0, affectedDates: [] }

  const where = 'WHERE (? <> \'\' AND lower(bundle_id) = lower(?)) OR (? <> \'\' AND lower(app_name) = lower(?))'
  const params = [bundle, bundle, name, name]
  const affected = new Set<string>()
  let deletedRows = 0
  const identifiers = new Set<string>()
  if (bundle.length >= 3) identifiers.add(bundle)
  if (name.length >= 5) identifiers.add(name)
  try {
    const rows = db.prepare(`
      SELECT app_instance_id, bundle_id, canonical_app_id
      FROM app_identities
      WHERE (? <> '' AND lower(bundle_id) = lower(?))
         OR (? <> '' AND (lower(raw_app_name) = lower(?) OR lower(display_name) = lower(?)))
    `).all(bundle, bundle, name, name, name) as Array<Record<string, string | null>>
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (typeof value === 'string' && value.trim().length >= 3) identifiers.add(value.trim())
      }
    }
  } catch {
    // Older databases may not have identity observations yet.
  }

  const purge = db.transaction(() => {
    const rows = db.prepare(`SELECT start_time FROM app_sessions ${where}`).all(...params) as { start_time: number }[]
    for (const date of distinctLocalDates(rows.map((row) => row.start_time))) affected.add(date)
    deletedRows += db.prepare(`DELETE FROM app_sessions ${where}`).run(...params).changes

    const focusRows = db.prepare(`
      SELECT ts_ms
      FROM focus_events
      WHERE (? <> '' AND lower(app_bundle_id) = lower(?))
         OR (? <> '' AND lower(app_name) = lower(?))
    `).all(...params) as { ts_ms: number }[]
    for (const date of distinctLocalDates(focusRows.map((row) => row.ts_ms))) affected.add(date)
    deletedRows += db.prepare(`
      DELETE FROM focus_events
      WHERE (? <> '' AND lower(app_bundle_id) = lower(?))
         OR (? <> '' AND lower(app_name) = lower(?))
    `).run(...params).changes

    const visitRows = db.prepare(`
      SELECT visit_time
      FROM website_visits
      WHERE (? <> '' AND (
        lower(browser_bundle_id) = lower(?)
        OR lower(browser_bundle_id) LIKE lower(?)
      ))
    `).all(bundle, bundle, `${bundle}:%`) as { visit_time: number }[]
    for (const date of distinctLocalDates(visitRows.map((row) => row.visit_time))) affected.add(date)
    deletedRows += db.prepare(`
      DELETE FROM website_visits
      WHERE (? <> '' AND (
        lower(browser_bundle_id) = lower(?)
        OR lower(browser_bundle_id) LIKE lower(?)
      ))
    `).run(bundle, bundle, `${bundle}:%`).changes

    try {
      const segmentRows = db.prepare(`
        SELECT started_at
        FROM activity_segments
        WHERE (? <> '' AND lower(primary_bundle_id) = lower(?))
      `).all(bundle, bundle) as { started_at: number }[]
      for (const date of distinctLocalDates(segmentRows.map((row) => row.started_at))) affected.add(date)
      deletedRows += db.prepare(`
        DELETE FROM activity_segments
        WHERE (? <> '' AND lower(primary_bundle_id) = lower(?))
      `).run(bundle, bundle).changes
    } catch {
      // Older databases may not have attribution tables yet.
    }

    try {
      const derivedRows = db.prepare(`
        SELECT date
        FROM derived_sessions
        WHERE (? <> '' AND lower(app_bundle_id) = lower(?))
           OR (? <> '' AND lower(app_name) = lower(?))
      `).all(...params) as { date: string }[]
      for (const row of derivedRows) affected.add(row.date)
      deletedRows += db.prepare(`
        DELETE FROM derived_sessions
        WHERE (? <> '' AND lower(app_bundle_id) = lower(?))
           OR (? <> '' AND lower(app_name) = lower(?))
      `).run(...params).changes
    } catch {
      // Derived projection tables are optional on older installs.
    }

    const matchers = [...identifiers].map((value) => ({
      like: `%${escapeLike(value.toLowerCase())}%`,
      pattern: identifierPattern(value),
    }))
    if (matchers.length > 0) {
      const dateColumns: Record<string, string> = {
        website_visits: 'visit_time',
        focus_events: 'ts_ms',
        app_sessions: 'start_time',
        raw_window_sessions: 'started_at',
        derived_sessions: 'start_ts_ms',
        browser_context_events: 'started_at',
        activity_segments: 'started_at',
      }
      const artifactFiles: string[] = []
      try {
        const rows = db
          .prepare('SELECT file_path, title, inline_content, summary FROM ai_artifacts')
          .all() as Array<Record<string, string | null>>
        for (const row of rows) {
          const text = Object.values(row)
            .filter((value): value is string => typeof value === 'string')
            .join(' ')
            .toLowerCase()
          if (
            matchers.some((matcher) => matcher.pattern.test(text)) &&
            row.file_path
          ) {
            artifactFiles.push(row.file_path)
          }
        }
      } catch {
        // Table absent on older installs.
      }

      const tables = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'
      `).all() as Array<{ name: string }>
      for (const { name: table } of tables) {
        if (table === 'schema_version') continue
        try {
          const columns = db
            .prepare(`PRAGMA table_info("${table}")`)
            .all() as Array<{ name: string; type: string }>
          const textColumns = columns
            .filter((column) => !/INT|REAL|BLOB/i.test(column.type ?? ''))
            .map((column) => column.name)
          if (textColumns.length === 0) continue
          const clauses = textColumns.flatMap((column) =>
            matchers.map(() => `lower(CAST("${column}" AS TEXT)) LIKE ? ESCAPE '\\'`),
          )
          const clauseParams = textColumns.flatMap(() => matchers.map((matcher) => matcher.like))
          const clause = clauses.join(' OR ')
          const timeColumn = dateColumns[table]
          const candidates = db
            .prepare(`SELECT rowid AS __purge_rowid, * FROM "${table}" WHERE ${clause}`)
            .all(...clauseParams) as Array<Record<string, unknown>>
          for (const row of candidates) {
            const matches = textColumns.some((column) => {
              const value = row[column]
              return typeof value === 'string' &&
                matchers.some((matcher) => matcher.pattern.test(value))
            })
            if (!matches || typeof row.__purge_rowid !== 'number') continue
            if (timeColumn && typeof row[timeColumn] === 'number') {
              affected.add(localDateString(new Date(row[timeColumn])))
            }
            deletedRows += db
              .prepare(`DELETE FROM "${table}" WHERE rowid = ?`)
              .run(row.__purge_rowid).changes
          }
        } catch {
          // Virtual tables and legacy schema variants are best-effort.
        }
      }
      for (const filePath of artifactFiles) {
        try { fs.unlinkSync(filePath) } catch { /* already gone */ }
      }
      for (const fts of ['website_visits_fts', 'app_sessions_fts', 'timeline_blocks_fts', 'ai_artifacts_fts']) {
        try {
          db.prepare(`INSERT INTO ${fts}(${fts}) VALUES ('rebuild')`).run()
        } catch { /* absent */ }
      }
    }
  })
  purge()
  if (deletedRows > 0) clearGeneratedActivitySummaries(db)

  const affectedDates = [...affected]
  for (const date of affectedDates) {
    try { projectDay(db, date, { finalize: date < localDateString() }) } catch { /* legacy-only install */ }
  }
  rematerializeAndNotify(affectedDates)
  return { deletedRows, affectedDates }
}

export function deleteHistoryForSite(input: { domain: string }): PurgeResult {
  const db = getDb()
  const domain = (input.domain ?? '').trim().toLowerCase().replace(/^www\./, '')
  if (!domain) return { deletedRows: 0, affectedDates: [] }

  // Exact host or any subdomain (so excluding youtube.com also clears m.youtube.com).
  const where = 'WHERE lower(domain) = ? OR lower(domain) LIKE ?'
  const params = [domain, `%.${domain}`]
  const affected = new Set<string>()
  let deletedRows = 0
  const urlPatterns = [`%://${domain}/%`, `%://%.${domain}/%`, `%://${domain}`, `%://%.${domain}`]

  const purge = db.transaction(() => {
    db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS purge_browser_aliases (
        alias TEXT PRIMARY KEY,
        canonical_id TEXT NOT NULL
      );
      CREATE TEMP TABLE IF NOT EXISTS purge_site_pages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        canonical_browser_id TEXT NOT NULL,
        raw_browser_id TEXT NOT NULL,
        profile_id TEXT,
        observed_at INTEGER NOT NULL
      );
      CREATE TEMP TABLE IF NOT EXISTS purge_focus_pages (
        source_event_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        canonical_browser_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL
      );
      CREATE TEMP TABLE IF NOT EXISTS purge_app_session_matches (
        session_id INTEGER PRIMARY KEY
      );
      CREATE TEMP TABLE IF NOT EXISTS purge_derived_session_matches (
        session_id INTEGER PRIMARY KEY
      );
      DELETE FROM purge_browser_aliases;
      DELETE FROM purge_site_pages;
      DELETE FROM purge_focus_pages;
      DELETE FROM purge_app_session_matches;
      DELETE FROM purge_derived_session_matches;
    `)
    const insertAlias = db.prepare(`
      INSERT OR REPLACE INTO purge_browser_aliases (alias, canonical_id) VALUES (?, ?)
    `)
    const addBrowserAlias = (rawValue: string | null, canonicalValue: string | null): void => {
      const rawIdentity = rawValue?.trim()
      if (!rawIdentity) return
      const baseIdentity = /^[a-z]:[\\/]/i.test(rawIdentity) ? rawIdentity : rawIdentity.split(':', 1)[0]
      const raw = rawIdentity.toLowerCase()
      const base = baseIdentity.toLowerCase()
      const canonical = canonicalValue?.trim().toLowerCase()
        || resolveCanonicalBrowser(baseIdentity).canonicalBrowserId
        || base
      insertAlias.run(raw, canonical)
      insertAlias.run(base, canonical)
      insertAlias.run(canonical, canonical)
    }
    const collectAliases = (sql: string): void => {
      try {
        const rows = db.prepare(sql).all() as Array<{ raw_id: string | null; canonical_id: string | null }>
        for (const row of rows) addBrowserAlias(row.raw_id, row.canonical_id)
      } catch {
        // Derived projection tables are optional on older installs.
      }
    }
    collectAliases(`
      SELECT bundle_id AS raw_id, canonical_app_id AS canonical_id FROM app_sessions
      UNION
      SELECT app_bundle_id, NULL FROM focus_events
    `)
    collectAliases('SELECT app_bundle_id AS raw_id, NULL AS canonical_id FROM derived_sessions')
    collectAliases(`
      SELECT browser_bundle_id AS raw_id, canonical_browser_id AS canonical_id FROM website_visits
    `)

    const canonicalBrowser = (expression: string): string => `coalesce(
      (SELECT canonical_id FROM purge_browser_aliases WHERE alias = lower(${expression})),
      lower(${expression})
    )`
    // Profile suffixes live on raw browser identities (bundle/instance), not paths.
    const profileFromBrowserIdentity = (expression: string): string => `lower(nullif(
      CASE
        WHEN instr(${expression}, ':') > 0
          AND ${expression} NOT GLOB '[A-Za-z]:[\\/]*'
          THEN substr(${expression}, instr(${expression}, ':') + 1)
      END,
      ''
    ))`

    const domainCondition = 'lower(domain) = ? OR lower(domain) LIKE ?'
    db.prepare(`
      INSERT INTO purge_site_pages (
        title, canonical_browser_id, raw_browser_id, profile_id, observed_at
      )
      SELECT lower(trim(page_title)),
        ${canonicalBrowser("coalesce(nullif(canonical_browser_id, ''), browser_bundle_id)")},
        lower(browser_bundle_id),
        coalesce(
          lower(nullif(browser_profile_id, '')),
          ${profileFromBrowserIdentity('browser_bundle_id')}
        ),
        visit_time
      FROM website_visits
      WHERE (${domainCondition})
        AND page_title IS NOT NULL AND trim(page_title) <> ''
        AND browser_bundle_id IS NOT NULL AND trim(browser_bundle_id) <> ''
    `).run(...params)

    for (const column of ['page_title', 'window_title']) {
      db.prepare(`
        INSERT INTO purge_site_pages (
          title, canonical_browser_id, raw_browser_id, profile_id, observed_at
        )
        SELECT lower(trim(${column})), ${canonicalBrowser('app_bundle_id')},
          lower(app_bundle_id), ${profileFromBrowserIdentity('app_bundle_id')}, ts_ms
        FROM focus_events
        WHERE (lower(url) LIKE ? OR lower(url) LIKE ? OR lower(url) LIKE ? OR lower(url) LIKE ?)
          AND ${column} IS NOT NULL AND trim(${column}) <> ''
          AND app_bundle_id IS NOT NULL AND trim(app_bundle_id) <> ''
      `).run(...urlPatterns)
      db.prepare(`
        INSERT INTO purge_focus_pages (
          source_event_id, title, canonical_browser_id, started_at, ended_at
        )
        SELECT source.id, lower(trim(source.${column})), ${canonicalBrowser('source.app_bundle_id')},
          source.ts_ms,
          coalesce((
            SELECT boundary.ts_ms
            FROM focus_events boundary
            WHERE (boundary.ts_ms > source.ts_ms
                OR (boundary.ts_ms = source.ts_ms AND boundary.id > source.id))
              AND (
                boundary.url IS NOT NULL
                OR boundary.event_type IN (
                  'tab_changed', 'tab_sampled', 'app_activated', 'app_deactivated',
                  'sleep', 'lock'
                )
                OR coalesce(${canonicalBrowser('boundary.app_bundle_id')}, '')
                  <> ${canonicalBrowser('source.app_bundle_id')}
              )
            ORDER BY boundary.ts_ms, boundary.id
            LIMIT 1
          ), 9223372036854775807)
        FROM focus_events source
        WHERE (lower(source.url) LIKE ? OR lower(source.url) LIKE ?
            OR lower(source.url) LIKE ? OR lower(source.url) LIKE ?)
          AND source.${column} IS NOT NULL AND trim(source.${column}) <> ''
          AND source.app_bundle_id IS NOT NULL AND trim(source.app_bundle_id) <> ''
      `).run(...urlPatterns)
    }

    const rows = db.prepare(`SELECT visit_time FROM website_visits ${where}`).all(...params) as { visit_time: number }[]
    for (const date of distinctLocalDates(rows.map((row) => row.visit_time))) affected.add(date)
    deletedRows += db.prepare(`DELETE FROM website_visits ${where}`).run(...params).changes

    const focusRows = db.prepare(`
      SELECT ts_ms
      FROM focus_events
      WHERE lower(url) LIKE ? OR lower(url) LIKE ? OR lower(url) LIKE ? OR lower(url) LIKE ?
    `).all(...urlPatterns) as { ts_ms: number }[]
    for (const date of distinctLocalDates(focusRows.map((row) => row.ts_ms))) affected.add(date)
    deletedRows += db.prepare(`
      DELETE FROM focus_events
      WHERE lower(url) LIKE ? OR lower(url) LIKE ? OR lower(url) LIKE ? OR lower(url) LIKE ?
    `).run(...urlPatterns).changes

    try {
      const segmentRows = db.prepare(`
        SELECT started_at
        FROM activity_segments
        WHERE lower(domain) = ? OR lower(domain) LIKE ?
      `).all(...params) as { started_at: number }[]
      for (const date of distinctLocalDates(segmentRows.map((row) => row.started_at))) affected.add(date)
      deletedRows += db.prepare(`
        DELETE FROM activity_segments
        WHERE lower(domain) = ? OR lower(domain) LIKE ?
      `).run(...params).changes
    } catch {
      // Older databases may not have attribution tables yet.
    }

    try {
      const derivedRows = db.prepare(`
        SELECT date
        FROM derived_sessions
        WHERE lower(domain) = ? OR lower(domain) LIKE ?
      `).all(...params) as { date: string }[]
      for (const row of derivedRows) affected.add(row.date)
      deletedRows += db.prepare(`
        DELETE FROM derived_sessions
        WHERE lower(domain) = ? OR lower(domain) LIKE ?
      `).run(...params).changes
    } catch {
      // Derived projection tables are optional on older installs.
    }

    const titleMatches = (pageTable: string, column: string): string => `(
      ${pageTable}.title = lower(trim(${column}))
      OR (
        substr(lower(trim(${column})), 1, length(${pageTable}.title)) = ${pageTable}.title
        AND substr(lower(trim(${column})), length(${pageTable}.title) + 1, 3) IN (' - ', ' — ', ' – ')
      )
    )`
    // Allow a short start-side poll lag only; never match past session end.
    const sessionStartToleranceMs = 5_000
    const appSessionEnd = `coalesce(
      app_sessions.end_time,
      app_sessions.start_time + max(app_sessions.duration_sec * 1000, 1)
    )`
    const appSessionProfile = `lower(coalesce(
      CASE
        WHEN instr(coalesce(app_sessions.app_instance_id, ''), ':') > 0
          THEN substr(app_sessions.app_instance_id, instr(app_sessions.app_instance_id, ':') + 1)
      END,
      CASE
        WHEN instr(app_sessions.bundle_id, ':') > 0
          AND app_sessions.bundle_id NOT GLOB '[A-Za-z]:[\\/]*'
          THEN substr(app_sessions.bundle_id, instr(app_sessions.bundle_id, ':') + 1)
      END,
      ''
    ))`
    // Unknown page profile must not wildcard into a profiled browser session.
    const compatibleAppSessionProfile = `(
      (
        purge_site_pages.profile_id IS NULL
        AND ${appSessionProfile} = ''
      )
      OR (
        purge_site_pages.profile_id IS NOT NULL
        AND (
          ${appSessionProfile} = ''
          OR purge_site_pages.profile_id = ${appSessionProfile}
        )
      )
    )`
    db.prepare(`
      INSERT OR IGNORE INTO purge_app_session_matches (session_id)
      SELECT session_id
      FROM (
        SELECT purge_site_pages.id AS page_id, app_sessions.id AS session_id,
          row_number() OVER (
            PARTITION BY purge_site_pages.id
            ORDER BY
              CASE
                WHEN purge_site_pages.raw_browser_id IN (
                  lower(app_sessions.bundle_id),
                  lower(coalesce(app_sessions.app_instance_id, ''))
                ) THEN 0
                WHEN purge_site_pages.profile_id IS NOT NULL
                  AND purge_site_pages.profile_id = ${appSessionProfile} THEN 1
                ELSE 2
              END,
              CASE WHEN purge_site_pages.observed_at >= app_sessions.start_time
                AND purge_site_pages.observed_at < ${appSessionEnd} THEN 0 ELSE 1 END,
              CASE
                WHEN purge_site_pages.observed_at < app_sessions.start_time
                  THEN app_sessions.start_time - purge_site_pages.observed_at
                ELSE 0
              END,
              abs(purge_site_pages.observed_at - app_sessions.start_time),
              app_sessions.id
          ) AS candidate_rank
        FROM purge_site_pages
        JOIN app_sessions
          ON app_sessions.window_title IS NOT NULL
          AND ${titleMatches('purge_site_pages', 'app_sessions.window_title')}
          AND purge_site_pages.canonical_browser_id = coalesce(
            lower(nullif(app_sessions.canonical_app_id, '')),
            ${canonicalBrowser('app_sessions.bundle_id')}
          )
          AND ${compatibleAppSessionProfile}
          AND purge_site_pages.observed_at >= app_sessions.start_time - ?
          AND purge_site_pages.observed_at < ${appSessionEnd}
      )
      WHERE candidate_rank = 1
    `).run(sessionStartToleranceMs)
    const appTitleRows = db.prepare(`
      UPDATE app_sessions
      SET window_title = NULL
      WHERE id IN (SELECT session_id FROM purge_app_session_matches)
      RETURNING start_time
    `).all() as { start_time: number }[]
    for (const date of distinctLocalDates(appTitleRows.map((row) => row.start_time))) affected.add(date)
    deletedRows += appTitleRows.length

    const focusTitleRows = db.prepare(`
      UPDATE focus_events
      SET window_title = NULL, page_title = NULL
      WHERE focus_events.url IS NULL
        AND EXISTS (
          SELECT 1 FROM purge_focus_pages
          WHERE canonical_browser_id = ${canonicalBrowser('focus_events.app_bundle_id')}
            AND (
              focus_events.ts_ms > purge_focus_pages.started_at
              OR (focus_events.ts_ms = purge_focus_pages.started_at
                AND focus_events.id > purge_focus_pages.source_event_id)
            )
            AND focus_events.ts_ms < purge_focus_pages.ended_at
            AND (
              ${titleMatches('purge_focus_pages', 'focus_events.window_title')}
              OR ${titleMatches('purge_focus_pages', 'focus_events.page_title')}
            )
        )
      RETURNING ts_ms
    `).all() as { ts_ms: number }[]
    for (const date of distinctLocalDates(focusTitleRows.map((row) => row.ts_ms))) affected.add(date)
    deletedRows += focusTitleRows.length

    try {
      const derivedSessionEnd = 'derived_sessions.end_ts_ms'
      const derivedSessionProfile = `lower(coalesce(
        CASE
          WHEN instr(coalesce(derived_sessions.app_bundle_id, ''), ':') > 0
            AND derived_sessions.app_bundle_id NOT GLOB '[A-Za-z]:[\\/]*'
            THEN substr(derived_sessions.app_bundle_id, instr(derived_sessions.app_bundle_id, ':') + 1)
        END,
        ''
      ))`
      const compatibleDerivedSessionProfile = `(
        (
          purge_site_pages.profile_id IS NULL
          AND ${derivedSessionProfile} = ''
        )
        OR (
          purge_site_pages.profile_id IS NOT NULL
          AND (
            ${derivedSessionProfile} = ''
            OR purge_site_pages.profile_id = ${derivedSessionProfile}
          )
        )
      )`
      db.prepare(`
        INSERT OR IGNORE INTO purge_derived_session_matches (session_id)
        SELECT session_id
        FROM (
          SELECT purge_site_pages.id AS page_id, derived_sessions.id AS session_id,
            row_number() OVER (
              PARTITION BY purge_site_pages.id
              ORDER BY
                CASE
                  WHEN purge_site_pages.raw_browser_id = lower(derived_sessions.app_bundle_id) THEN 0
                  WHEN purge_site_pages.profile_id IS NOT NULL
                    AND purge_site_pages.profile_id = ${derivedSessionProfile} THEN 1
                  ELSE 2
                END,
                CASE WHEN purge_site_pages.observed_at >= derived_sessions.start_ts_ms
                  AND purge_site_pages.observed_at < ${derivedSessionEnd} THEN 0 ELSE 1 END,
                CASE
                  WHEN purge_site_pages.observed_at < derived_sessions.start_ts_ms
                    THEN derived_sessions.start_ts_ms - purge_site_pages.observed_at
                  ELSE 0
                END,
                abs(purge_site_pages.observed_at - derived_sessions.start_ts_ms),
                derived_sessions.id
            ) AS candidate_rank
          FROM purge_site_pages
          JOIN derived_sessions
            ON derived_sessions.is_browser = 1
            AND (
              ${titleMatches('purge_site_pages', 'derived_sessions.window_title')}
              OR ${titleMatches('purge_site_pages', 'derived_sessions.page_title')}
            )
            AND purge_site_pages.canonical_browser_id
              = ${canonicalBrowser('derived_sessions.app_bundle_id')}
            AND ${compatibleDerivedSessionProfile}
            AND purge_site_pages.observed_at >= derived_sessions.start_ts_ms - ?
            AND purge_site_pages.observed_at < ${derivedSessionEnd}
        )
        WHERE candidate_rank = 1
      `).run(sessionStartToleranceMs)
      const derivedTitleRows = db.prepare(`
        UPDATE derived_sessions
        SET window_title = NULL, page_title = NULL
        WHERE id IN (SELECT session_id FROM purge_derived_session_matches)
        RETURNING date
      `).all() as { date: string }[]
      for (const row of derivedTitleRows) affected.add(row.date)
      deletedRows += derivedTitleRows.length
    } catch {
      // Derived projection tables are optional on older installs.
    }

    // A browser window title is the page title, so the site's name can sit in
    // ANY text column of ANY table: titles, urls, block labels, chat tool
    // traces, narrative JSON, work-memory observations. A hand-maintained
    // table list keeps missing surfaces, so the scrub is generic: every user
    // table, every text-affine column, delete matching rows. Date-bearing
    // tables record their affected dates first so those days reproject.
    const brand = domain.split('.')[0]
    if (brand.length >= 3) {
      const titlePattern = `%${brand}%`

      const dateColumns: Record<string, string> = {
        website_visits: 'visit_time',
        focus_events: 'ts_ms',
        app_sessions: 'start_time',
        raw_window_sessions: 'started_at',
        derived_sessions: 'start_ts_ms',
        browser_context_events: 'started_at',
        activity_segments: 'started_at',
      }
      const skipTables = new Set(['schema_version'])

      // Exported AI artifacts can embed the rows themselves (a CSV of site
      // visits): capture their file paths before the row delete, remove after.
      const artifactFiles: string[] = []
      try {
        const artifactRows = db.prepare(`
          SELECT file_path FROM ai_artifacts
          WHERE file_path IS NOT NULL
            AND (lower(title) LIKE ? OR lower(inline_content) LIKE ? OR lower(summary) LIKE ?)
        `).all(titlePattern, titlePattern, titlePattern) as Array<{ file_path: string }>
        for (const row of artifactRows) artifactFiles.push(row.file_path)
      } catch {
        // Table absent on older installs.
      }

      const tables = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'
      `).all() as Array<{ name: string }>
      for (const { name } of tables) {
        if (skipTables.has(name)) continue
        try {
          const columns = db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string; type: string }>
          const textColumns = columns
            .filter((column) => !/INT|REAL|BLOB/i.test(column.type ?? ''))
            .map((column) => column.name)
          if (textColumns.length === 0) continue
          const clause = textColumns.map((column) => `lower(CAST("${column}" AS TEXT)) LIKE ?`).join(' OR ')
          const clauseParams = textColumns.map(() => titlePattern)
          const timeColumn = dateColumns[name]
          if (timeColumn) {
            const timeRows = db.prepare(`SELECT "${timeColumn}" AS t FROM "${name}" WHERE ${clause}`)
              .all(...clauseParams) as { t: number }[]
            for (const date of distinctLocalDates(timeRows.map((row) => row.t))) affected.add(date)
          }
          deletedRows += db.prepare(`DELETE FROM "${name}" WHERE ${clause}`).run(...clauseParams).changes
        } catch {
          // Virtual/shadow tables and schema oddities: skip rather than fail the purge.
        }
      }

      for (const filePath of artifactFiles) {
        try { fs.unlinkSync(filePath) } catch { /* already gone */ }
      }

      // Rebuild the external-content FTS indexes so no tokenized copy of a
      // deleted row survives in search.
      for (const fts of ['website_visits_fts', 'app_sessions_fts', 'timeline_blocks_fts', 'ai_artifacts_fts']) {
        try {
          db.prepare(`INSERT INTO ${fts}(${fts}) VALUES ('rebuild')`).run()
        } catch {
          // Index absent on older installs.
        }
      }
    }

    db.exec(`
      DELETE FROM purge_site_pages;
      DELETE FROM purge_focus_pages;
      DELETE FROM purge_app_session_matches;
      DELETE FROM purge_derived_session_matches;
      DELETE FROM purge_browser_aliases;
    `)
  })
  purge()
  if (deletedRows > 0) clearGeneratedActivitySummaries(db)

  const affectedDates = [...affected]
  for (const date of affectedDates) {
    try { projectDay(db, date, { finalize: date < localDateString() }) } catch { /* legacy-only install */ }
  }
  rematerializeAndNotify(affectedDates)
  return { deletedRows, affectedDates }
}

export interface PurgeTrackedEvidenceRowsInput {
  kind: 'app' | 'site'
  bundleId?: string
  appName?: string
  domain?: string
  fromMs: number
  toMs: number
}

// Extracted from the PURGE_TRACKED_EVIDENCE IPC handler so the deletion
// journal can replay the same row deletes against a restored database without
// going through IPC or the native confirm dialog. Idempotent: deletes of
// already-absent rows are no-ops.
export function purgeTrackedEvidenceRows(db: Database.Database, input: PurgeTrackedEvidenceRowsInput): void {
  const { fromMs, toMs } = input
  const run = db.transaction(() => {
    if (input.kind === 'site' && input.domain) {
      const domain = input.domain
      const like = `%${domain}%`
      db.prepare(`DELETE FROM website_visits WHERE domain = ? AND visit_time >= ? AND visit_time < ?`)
        .run(domain, fromMs, toMs)
      db.prepare(`DELETE FROM focus_events WHERE ts_ms >= ? AND ts_ms < ? AND (url LIKE ? OR page_title LIKE ?)`)
        .run(fromMs, toMs, like, like)
      db.prepare(`DELETE FROM derived_sessions WHERE start_ts_ms >= ? AND start_ts_ms < ? AND domain = ?`)
        .run(fromMs, toMs, domain)
      // Artifact identities for the host are display aggregates; remove them
      // outright (mentions cascade). Other days' remaining data regenerates
      // its own artifacts on the next rebuild.
      db.prepare(`DELETE FROM artifacts WHERE host = ?`).run(domain)
    } else {
      const bundleId = input.bundleId ?? ''
      const appName = input.appName ?? bundleId
      db.prepare(`DELETE FROM app_sessions WHERE start_time >= ? AND start_time < ? AND (bundle_id = ? OR app_name = ?)`)
        .run(fromMs, toMs, bundleId, appName)
      db.prepare(`DELETE FROM focus_events WHERE ts_ms >= ? AND ts_ms < ? AND (app_bundle_id = ? OR app_name = ?)`)
        .run(fromMs, toMs, bundleId, appName)
      db.prepare(`DELETE FROM derived_sessions WHERE start_ts_ms >= ? AND start_ts_ms < ? AND (app_bundle_id = ? OR app_name = ?)`)
        .run(fromMs, toMs, bundleId, appName)
    }
  })
  run()
}

export interface PurgeTimelineBlockSpanInput {
  fromMs: number
  toMs: number
}

// Extracted from the PURGE_TIMELINE_BLOCK IPC handler for the same reason:
// the deletion journal replays the block-span row deletes verbatim after a
// backup restore. Idempotent by construction.
export function purgeTimelineBlockSpanRows(db: Database.Database, input: PurgeTimelineBlockSpanInput): void {
  const { fromMs, toMs } = input
  const run = db.transaction(() => {
    db.prepare(`DELETE FROM app_sessions WHERE start_time >= ? AND start_time < ?`).run(fromMs, toMs)
    db.prepare(`DELETE FROM website_visits WHERE visit_time >= ? AND visit_time < ?`).run(fromMs, toMs)
    db.prepare(`DELETE FROM focus_events WHERE ts_ms >= ? AND ts_ms < ?`).run(fromMs, toMs)
    db.prepare(`DELETE FROM derived_sessions WHERE start_ts_ms >= ? AND start_ts_ms < ?`).run(fromMs, toMs)
    db.prepare(`DELETE FROM artifact_mentions WHERE start_time >= ? AND start_time < ?`).run(fromMs, toMs)
  })
  run()
}

function normalizeIds(values: number[] | null | undefined): number[] {
  return [...new Set((values ?? [])
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0))]
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ')
}

function appIdentityWhereClause(input: DeleteTrackedActivityInput): { clause: string; params: unknown[] } | null {
  const bundleId = (input.bundleId ?? '').trim()
  const canonicalAppId = (input.canonicalAppId ?? '').trim()
  const appName = (input.appName ?? '').trim()
  const clauses: string[] = []
  const params: unknown[] = []

  if (bundleId) {
    clauses.push('lower(bundle_id) = lower(?)')
    params.push(bundleId)
  }
  if (canonicalAppId) {
    clauses.push('lower(canonical_app_id) = lower(?)')
    params.push(canonicalAppId)
  }
  if (appName) {
    clauses.push('lower(app_name) = lower(?)')
    params.push(appName)
  }

  return clauses.length > 0 ? { clause: `(${clauses.join(' OR ')})`, params } : null
}

function focusEventAppIdentityWhereClause(input: DeleteTrackedActivityInput): { clause: string; params: unknown[] } | null {
  const bundleId = (input.bundleId ?? '').trim()
  const appName = (input.appName ?? '').trim()
  const clauses: string[] = []
  const params: unknown[] = []

  if (bundleId) {
    clauses.push('lower(app_bundle_id) = lower(?)')
    params.push(bundleId)
  }
  if (appName) {
    clauses.push('lower(app_name) = lower(?)')
    params.push(appName)
  }

  return clauses.length > 0 ? { clause: `(${clauses.join(' OR ')})`, params } : null
}

export function deleteTrackedActivity(input: DeleteTrackedActivityInput): PurgeResult {
  const db = getDb()
  const appSessionIds = normalizeIds(input.appSessionIds)
  const derivedSessionIds = normalizeIds(input.derivedSessionIds)
  const explicitDate = (input.date ?? '').trim()
  const explicitStartTime = Number(input.startTime ?? 0)
  const explicitEndTime = Number(input.endTime ?? 0)
  const affectedDates = new Set<string>()
  let deletedRows = 0
  const hasValidExplicitRange = Number.isFinite(explicitStartTime)
    && Number.isFinite(explicitEndTime)
    && explicitEndTime > explicitStartTime

  if (appSessionIds.length > 0) {
    const inClause = placeholders(appSessionIds)
    const rows = db.prepare(`
      SELECT start_time
      FROM app_sessions
      WHERE id IN (${inClause})
    `).all(...appSessionIds) as { start_time: number }[]

    for (const row of rows) affectedDates.add(localDateString(new Date(row.start_time)))
    deletedRows += db.prepare(`DELETE FROM app_sessions WHERE id IN (${inClause})`).run(...appSessionIds).changes
  }

  const appWhere = appIdentityWhereClause(input)
  if (appWhere && hasValidExplicitRange) {
    const rows = db.prepare(`
      SELECT start_time
      FROM app_sessions
      WHERE ${appWhere.clause}
        AND start_time < ?
        AND COALESCE(end_time, start_time + duration_sec * 1000) > ?
    `).all(...appWhere.params, explicitEndTime, explicitStartTime) as { start_time: number }[]

    for (const row of rows) affectedDates.add(localDateString(new Date(row.start_time)))

    deletedRows += db.prepare(`
      DELETE FROM app_sessions
      WHERE ${appWhere.clause}
        AND start_time < ?
        AND COALESCE(end_time, start_time + duration_sec * 1000) > ?
    `).run(...appWhere.params, explicitEndTime, explicitStartTime).changes
  }

  if (derivedSessionIds.length > 0) {
    const inClause = placeholders(derivedSessionIds)
    const rows = db.prepare(`
      SELECT id, date, start_ts_ms, end_ts_ms
      FROM derived_sessions
      WHERE id IN (${inClause})
    `).all(...derivedSessionIds) as Array<{ id: number; date: string; start_ts_ms: number; end_ts_ms: number }>

    for (const row of rows) {
      affectedDates.add(row.date)
      deletedRows += db.prepare(`
        DELETE FROM focus_events
        WHERE ts_ms >= ? AND ts_ms < ?
      `).run(row.start_ts_ms, row.end_ts_ms).changes
    }

    if (rows.length > 0) {
      db.prepare(`DELETE FROM derived_block_sessions WHERE session_id IN (${inClause})`).run(...derivedSessionIds)
      db.prepare(`DELETE FROM derived_sessions WHERE id IN (${inClause})`).run(...derivedSessionIds)
    }
  } else if (
    appSessionIds.length === 0
    && !appWhere
    && explicitDate
    && hasValidExplicitRange
  ) {
    const info = db.prepare(`
      DELETE FROM focus_events
      WHERE ts_ms >= ? AND ts_ms < ?
    `).run(explicitStartTime, explicitEndTime)
    if (info.changes > 0) {
      deletedRows += info.changes
      affectedDates.add(explicitDate)
    }
  }

  const focusEventAppWhere = focusEventAppIdentityWhereClause(input)
  if (focusEventAppWhere && hasValidExplicitRange) {
    const focusEventRows = db.prepare(`
      SELECT ts_ms
      FROM focus_events
      WHERE ${focusEventAppWhere.clause}
        AND ts_ms >= ?
        AND ts_ms < ?
    `).all(...focusEventAppWhere.params, explicitStartTime, explicitEndTime) as { ts_ms: number }[]

    for (const row of focusEventRows) affectedDates.add(localDateString(new Date(row.ts_ms)))

    deletedRows += db.prepare(`
      DELETE FROM focus_events
      WHERE ${focusEventAppWhere.clause}
        AND ts_ms >= ?
        AND ts_ms < ?
    `).run(...focusEventAppWhere.params, explicitStartTime, explicitEndTime).changes
  }

  const domain = (input.domain ?? '').trim().toLowerCase().replace(/^www\./, '')
  const url = (input.url ?? '').trim()
  const normalizedUrl = (input.normalizedUrl ?? normalizeUrlForStorage(url) ?? '').trim()
  const pageKey = (input.pageKey ?? pageKeyForUrl(normalizedUrl || url) ?? '').trim()
  if (!hasValidExplicitRange && (url || normalizedUrl || pageKey)) {
    // Match the strongest page identity available. A page key deliberately
    // drops query parameters, so combining it with a normalized URL would
    // wrongly delete every video or search sharing the same path.
    const pageWhere = normalizedUrl
      ? 'normalized_url = ?'
      : pageKey
        ? 'page_key = ?'
        : 'url = ?'
    const pageParams = [normalizedUrl || pageKey || url]
    const visitRows = db.prepare(`
      SELECT visit_time
      FROM website_visits
      WHERE ${pageWhere}
    `).all(...pageParams) as { visit_time: number }[]
    for (const row of visitRows) affectedDates.add(localDateString(new Date(row.visit_time)))
    deletedRows += db.prepare(`DELETE FROM website_visits WHERE ${pageWhere}`).run(...pageParams).changes

    const focusRows = db.prepare(`
      SELECT id, ts_ms, url
      FROM focus_events
      WHERE url IS NOT NULL
    `).all() as Array<{ id: number; ts_ms: number; url: string }>
    const matchingFocusRows = focusRows.filter((row) =>
      normalizedUrl
        ? normalizeUrlForStorage(row.url) === normalizedUrl
        : pageKey
          ? pageKeyForUrl(row.url) === pageKey
          : row.url === url)
    const deleteFocusEvent = db.prepare('DELETE FROM focus_events WHERE id = ?')
    const purgeFocusRows = db.transaction(() => {
      for (const row of matchingFocusRows) {
        affectedDates.add(localDateString(new Date(row.ts_ms)))
        deletedRows += deleteFocusEvent.run(row.id).changes
      }
    })
    purgeFocusRows()
  }

  if (hasValidExplicitRange && (domain || url)) {
    const clauses: string[] = []
    const params: unknown[] = []
    if (domain) {
      clauses.push('(lower(domain) = ? OR lower(domain) LIKE ?)')
      params.push(domain, `%.${domain}`)
    }
    if (url) {
      clauses.push('url = ?')
      params.push(url)
    }

    const where = clauses.join(' OR ')
    const rows = db.prepare(`
      SELECT visit_time
      FROM website_visits
      WHERE (${where})
        AND visit_time >= ?
        AND visit_time < ?
    `).all(...params, explicitStartTime, explicitEndTime) as { visit_time: number }[]

    for (const row of rows) affectedDates.add(localDateString(new Date(row.visit_time)))

    deletedRows += db.prepare(`
      DELETE FROM website_visits
      WHERE (${where})
        AND visit_time >= ?
        AND visit_time < ?
    `).run(...params, explicitStartTime, explicitEndTime).changes
  }

  if (deletedRows > 0 && (domain || url)) clearGeneratedActivitySummaries(db)

  const dates = [...affectedDates]
  for (const date of dates) {
    try {
      projectDay(db, date, { finalize: true })
    } catch {
      // Some installs may not have focus_events/derived projections populated;
      // the legacy app_sessions materialization below still refreshes the day.
    }
  }

  rematerializeAndNotify(dates)
  return { deletedRows, affectedDates: dates }
}
