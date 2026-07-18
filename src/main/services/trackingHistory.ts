// T3: delete already-captured history for an app or site the user just excluded
// (or wants gone). Deletes the source rows (app_sessions / website_visits), then
// rebuilds the affected day projections from what remains and notifies the
// surfaces so the data disappears from the timeline, Apps, AI answers, and
// search — "gone, not just hidden". Forward capture is stopped separately by the
// gate in tracking.ts / browserContext.ts.

import fs from 'node:fs'
import { getDb } from './database'
import { localDateString } from '../lib/localDate'
import { materializeTimelineDayProjection } from '../core/query/projections'
import { invalidateProjectionScope } from '../core/projections/invalidation'
import { projectDay } from '../core/projections/chunk2'
import { normalizeUrlForStorage, pageKeyForUrl } from '../lib/appIdentity'

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
