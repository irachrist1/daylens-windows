// Measures the local query cost of a representative heavy year of Daylens
// data against the real schema, so specified performance budgets stay
// grounded in evidence instead of guesses.
//
//   npm run bench:queries
//
// Offline and hermetic: seeds a temporary on-disk SQLite database and deletes
// it afterwards. No user database, no provider, no network.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import Database from 'better-sqlite3'
import { SCHEMA_SQL } from '../src/main/db/schema.ts'
import { ensureSearchSchema } from '../src/main/db/migrations.ts'

// focus_events arrives via a migration on real installs; the migration runner
// is bound to the app database, so the benchmark declares the same shape.
const FOCUS_EVENTS_SQL = `
  CREATE TABLE IF NOT EXISTS focus_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts_ms INTEGER NOT NULL,
    mono_ns INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    app_bundle_id TEXT,
    app_name TEXT,
    pid INTEGER,
    window_title TEXT,
    url TEXT,
    page_title TEXT,
    source TEXT NOT NULL,
    confidence TEXT NOT NULL,
    platform TEXT NOT NULL,
    schema_ver INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_focus_events_ts ON focus_events (ts_ms);
`

const DAYS = 365
const SESSIONS_PER_DAY = 450
const FOCUS_EVENTS_PER_DAY = 3_000
const VISITS_PER_DAY = 300
const RUNS_PER_QUERY = 25

const APPS = [
  ['com.todesktop.230313mzl4w4u92', 'Cursor', 'development'],
  ['com.google.Chrome', 'Google Chrome', 'browsing'],
  ['com.apple.Safari', 'Safari', 'browsing'],
  ['com.tinyspeck.slackmacgap', 'Slack', 'communication'],
  ['com.microsoft.VSCode', 'Visual Studio Code', 'development'],
  ['com.figma.Desktop', 'Figma', 'design'],
  ['us.zoom.xos', 'Zoom', 'meetings'],
  ['com.apple.mail', 'Mail', 'communication'],
  ['com.spotify.client', 'Spotify', 'entertainment'],
  ['com.apple.Notes', 'Notes', 'writing'],
] as const

const DOMAINS = ['github.com', 'linear.app', 'news.ycombinator.com', 'docs.google.com', 'stackoverflow.com', 'youtube.com', 'daylens.app', 'developer.apple.com']

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
}

function seed(db: Database.Database, startMs: number): void {
  const insertSession = db.prepare(`
    INSERT INTO app_sessions (bundle_id, app_name, start_time, end_time, duration_sec, category, window_title, canonical_app_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertFocus = db.prepare(`
    INSERT INTO focus_events (ts_ms, mono_ns, event_type, app_bundle_id, app_name, pid, window_title, url, page_title, source, confidence, platform, schema_ver)
    VALUES (?, ?, 'app_activated', ?, ?, 501, ?, NULL, NULL, 'nsworkspace_event', 'observed', 'darwin', 2)
  `)
  const insertVisit = db.prepare(`
    INSERT INTO website_visits (domain, page_title, url, visit_time, visit_time_us, duration_sec, browser_bundle_id, canonical_browser_id)
    VALUES (?, ?, ?, ?, ?, ?, 'com.google.Chrome', 'chrome')
  `)

  const dayMs = 24 * 60 * 60 * 1000
  const seedDay = db.transaction((dayStart: number, day: number) => {
    for (let i = 0; i < SESSIONS_PER_DAY; i += 1) {
      const app = APPS[(day + i) % APPS.length]
      const start = dayStart + 8 * 3600_000 + i * 70_000
      const duration = 15 + ((i * 37) % 600)
      insertSession.run(app[0], app[1], start, start + duration * 1000, duration, app[2], `${app[1]} — task ${day}-${i} planning notes`, app[0])
    }
    for (let i = 0; i < FOCUS_EVENTS_PER_DAY; i += 1) {
      const app = APPS[(day * 3 + i) % APPS.length]
      const ts = dayStart + 8 * 3600_000 + i * 10_500
      insertFocus.run(ts, BigInt(ts) * 1_000_000n, app[0], app[1], `${app[1]} — window ${day}-${i}`)
    }
    for (let i = 0; i < VISITS_PER_DAY; i += 1) {
      const domain = DOMAINS[(day + i) % DOMAINS.length]
      const ts = dayStart + 9 * 3600_000 + i * 90_000
      insertVisit.run(domain, `Page ${day}-${i} about ${domain.split('.')[0]} research`, `https://${domain}/item/${day}/${i}`, ts, ts * 1000 + i, 20 + (i % 300))
    }
  })

  for (let day = 0; day < DAYS; day += 1) seedDay(startMs + day * dayMs, day)
}

function time(label: string, run: () => unknown): { label: string; medianMs: number; p95Ms: number } {
  const samples: number[] = []
  run() // warm
  for (let i = 0; i < RUNS_PER_QUERY; i += 1) {
    const before = performance.now()
    run()
    samples.push(performance.now() - before)
  }
  return { label, medianMs: median(samples), p95Ms: p95(samples) }
}

function main(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-bench-'))
  const file = path.join(dir, 'year.sqlite')
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA_SQL)
  db.exec(FOCUS_EVENTS_SQL)
  ensureSearchSchema(db)

  const startMs = new Date(2025, 6, 1).getTime()
  const dayMs = 24 * 60 * 60 * 1000
  const seedStarted = performance.now()
  seed(db, startMs)
  const seedSeconds = (performance.now() - seedStarted) / 1000

  const counts = {
    app_sessions: (db.prepare('SELECT COUNT(*) AS n FROM app_sessions').get() as { n: number }).n,
    focus_events: (db.prepare('SELECT COUNT(*) AS n FROM focus_events').get() as { n: number }).n,
    website_visits: (db.prepare('SELECT COUNT(*) AS n FROM website_visits').get() as { n: number }).n,
  }
  const sizeMb = fs.statSync(file).size / (1024 * 1024)

  const midDay = startMs + 180 * dayMs
  const results = [
    time('day: app_sessions range read', () =>
      db.prepare('SELECT * FROM app_sessions WHERE start_time >= ? AND start_time < ?').all(midDay, midDay + dayMs)),
    time('day: focus_events range read', () =>
      db.prepare('SELECT * FROM focus_events WHERE ts_ms >= ? AND ts_ms < ? ORDER BY ts_ms ASC, id ASC').all(midDay, midDay + dayMs)),
    time('day: website_visits range read', () =>
      db.prepare('SELECT * FROM website_visits WHERE visit_time >= ? AND visit_time < ?').all(midDay, midDay + dayMs)),
    time('month: per-app aggregate', () =>
      db.prepare('SELECT canonical_app_id, SUM(duration_sec) AS total FROM app_sessions WHERE start_time >= ? AND start_time < ? GROUP BY canonical_app_id ORDER BY total DESC').all(midDay - 30 * dayMs, midDay)),
    time('year: per-app aggregate', () =>
      db.prepare('SELECT canonical_app_id, SUM(duration_sec) AS total FROM app_sessions WHERE start_time >= ? AND start_time < ? GROUP BY canonical_app_id ORDER BY total DESC').all(startMs, startMs + DAYS * dayMs)),
    time('year: unindexed LIKE over titles (worst case)', () =>
      db.prepare("SELECT COUNT(*) AS n FROM app_sessions WHERE window_title LIKE '%planning notes%'").get()),
    time('year: domain-day aggregate', () =>
      db.prepare('SELECT domain, SUM(duration_sec) AS total FROM website_visits WHERE visit_time >= ? AND visit_time < ? GROUP BY domain ORDER BY total DESC').all(startMs, startMs + DAYS * dayMs)),
  ]

  let ftsResult: { label: string; medianMs: number; p95Ms: number } | null = null
  try {
    db.exec("INSERT INTO app_sessions_fts(app_sessions_fts) VALUES('rebuild')")
    ftsResult = time('year: FTS5 exact search over titles', () =>
      db.prepare("SELECT COUNT(*) AS n FROM app_sessions_fts WHERE app_sessions_fts MATCH 'planning'").get())
  } catch (error) {
    console.warn(`FTS rebuild unavailable in this harness: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (ftsResult) results.push(ftsResult)

  console.log(`\nSeeded ${DAYS} days in ${seedSeconds.toFixed(1)}s → ${counts.app_sessions.toLocaleString()} sessions, ${counts.focus_events.toLocaleString()} focus events, ${counts.website_visits.toLocaleString()} visits, ${sizeMb.toFixed(0)} MB on disk (WAL).`)
  console.log(`Machine: ${os.cpus()[0]?.model ?? 'unknown'} · ${os.platform()} ${os.arch()}\n`)
  for (const result of results) {
    console.log(`${result.label.padEnd(48)} median ${result.medianMs.toFixed(1).padStart(7)} ms · p95 ${result.p95Ms.toFixed(1).padStart(7)} ms`)
  }

  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
}

main()
