import { useEffect, useState } from 'react'
import { ipc } from '../lib/ipc'
import { dayBounds, formatDuration, formatTime, percentOf, todayString } from '../lib/format'
import { catColor, formatCategory } from '../lib/category'
import type { AppSession, AppUsageSummary, AppCategory, LiveSession, WebsiteSummary } from '@shared/types'
import { FOCUSED_CATEGORIES } from '@shared/types'

// ─── Derived types ────────────────────────────────────────────────────────────

interface CategorySummary {
  category: AppCategory
  totalSeconds: number
  apps: string[]
}

function buildCategorySummaries(summaries: AppUsageSummary[]): CategorySummary[] {
  const map = new Map<AppCategory, CategorySummary>()
  for (const app of summaries) {
    const existing = map.get(app.category)
    if (existing) {
      existing.totalSeconds += app.totalSeconds
      existing.apps.push(app.appName)
    } else {
      map.set(app.category, { category: app.category, totalSeconds: app.totalSeconds, apps: [app.appName] })
    }
  }
  return Array.from(map.values()).sort((a, b) => b.totalSeconds - a.totalSeconds)
}

// ─── Greeting ─────────────────────────────────────────────────────────────────

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

function focusLabel(pct: number, hasData: boolean): string {
  if (!hasData) return 'No data yet'
  if (pct >= 80) return 'Deep focus'
  if (pct >= 60) return 'Focused'
  if (pct >= 40) return 'Mixed'
  if (pct >= 20) return 'Scattered'
  return 'Low focus'
}

// ─── Live session merge ───────────────────────────────────────────────────────
// Merges the in-flight session into DB data for display only — never written to DB.
// Double-counting is impossible: DB sessions are all committed (endTime set) before
// currentSession.startTime; there is no temporal overlap.
// We re-fetch DB data on every tick, so no cached base is needed (unlike the Swift app).

function mergeLive(
  dbSummaries: AppUsageSummary[],
  dbSessions: AppSession[],
  live: LiveSession | null,
  fromMs: number,
  toMs: number,
): { summaries: AppUsageSummary[]; sessions: AppSession[] } {
  if (!live) return { summaries: dbSummaries, sessions: dbSessions }

  const liveNow = Date.now()
  const liveStart = Math.max(live.startTime, fromMs)
  const liveEnd = Math.min(liveNow, toMs)
  const liveDur = Math.max(0, Math.round((liveEnd - liveStart) / 1_000))
  if (liveDur < 3) return { summaries: dbSummaries, sessions: dbSessions }

  // Add live duration to existing app summary or create a new entry
  const existingIdx = dbSummaries.findIndex((s) => s.bundleId === live.bundleId)
  const summaries: AppUsageSummary[] =
    existingIdx >= 0
      ? dbSummaries.map((s, i) =>
          i === existingIdx ? { ...s, totalSeconds: s.totalSeconds + liveDur } : s,
        )
      : [
          ...dbSummaries,
          {
            bundleId: live.bundleId,
            appName:  live.appName,
            category: live.category,
            totalSeconds: liveDur,
            isFocused: FOCUSED_CATEGORIES.includes(live.category),
          },
        ]

  // Synthetic session for the timeline (endTime = now so it shows up in the band)
  const liveSession: AppSession = {
    id:              -1,
    bundleId:        live.bundleId,
    appName:         live.appName,
    startTime:       liveStart,
    endTime:         liveEnd,
    durationSeconds: liveDur,
    category:        live.category,
    isFocused:       FOCUSED_CATEGORIES.includes(live.category),
  }

  return {
    summaries: summaries.sort((a, b) => b.totalSeconds - a.totalSeconds),
    sessions: [...dbSessions, liveSession].sort((a, b) => a.startTime - b.startTime),
  }
}

const PRESENTATION_NOISE_SEC = 120

function isPresentationNoise(category: AppCategory, durationSeconds: number): boolean {
  return (category === 'system' || category === 'uncategorized') &&
    durationSeconds < PRESENTATION_NOISE_SEC
}

// ─── Timeline constants ───────────────────────────────────────────────────────

const TL_START = 6   // 6 AM
const TL_END   = 24  // midnight
const TL_TOTAL = TL_END - TL_START
const TL_LABELS = [6, 9, 12, 15, 18, 21]

function hourLabel(h: number): string {
  if (h === 12) return '12p'
  if (h > 12)  return `${h - 12}p`
  return `${h}a`
}

// ─── Main view ────────────────────────────────────────────────────────────────

export default function Today() {
  const [dbSummaries, setDbSummaries] = useState<AppUsageSummary[]>([])
  const [dbSessions,  setDbSessions]  = useState<AppSession[]>([])
  const [live,        setLive]        = useState<LiveSession | null>(null)
  const [loading,     setLoading]     = useState(true)

  useEffect(() => {
    let cancelled = false

    async function refresh() {
      const [s, sess, lv] = await Promise.all([
        ipc.db.getToday(),
        ipc.db.getHistory(todayString()),
        ipc.tracking.getLiveSession(),
      ])
      if (cancelled) return
      setDbSummaries(s as AppUsageSummary[])
      setDbSessions(sess as AppSession[])
      setLive(lv as LiveSession | null)
      setLoading(false)
    }

    void refresh()
    const timer = setInterval(() => void refresh(), 30_000)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  if (loading) return <LoadingSkeleton />

  const [fromMs, toMs] = dayBounds(todayString())
  const { summaries, sessions } = mergeLive(dbSummaries, dbSessions, live, fromMs, toMs)

  const meaningfulSummaries = summaries.filter(
    (app) => !isPresentationNoise(app.category, app.totalSeconds),
  )
  const meaningfulSessions = sessions.filter(
    (session) => !isPresentationNoise(session.category, session.durationSeconds),
  )

  const totalSec = summaries.reduce((n, a) => n + a.totalSeconds, 0)
  const focusSec = meaningfulSummaries
    .filter((a) => a.isFocused)
    .reduce((n, a) => n + a.totalSeconds, 0)
  const focusPct = percentOf(focusSec, totalSec)
  const appCount = meaningfulSummaries.length
  const cats     = buildCategorySummaries(meaningfulSummaries)

  return (
    <div className="p-6 max-w-[920px] mx-auto">

      {/* ── 1. Hero ────────────────────────────────────────────────────── */}
      <HeroCard totalSec={totalSec} focusSec={focusSec} appCount={appCount} />

      {/* ── 2. Stat cards ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-3 mt-4">
        <StatCard
          icon="⏱"
          label="Screen time"
          value={totalSec > 0 ? formatDuration(totalSec) : '—'}
          sub={`${appCount} apps`}
        />
        <StatCard
          icon="⚡"
          label="Focus time"
          value={focusSec > 0 ? formatDuration(focusSec) : '—'}
          sub={totalSec > 0 ? `${focusPct}% of tracked time` : 'No tracked focus yet'}
          accent
        />
        <StatCard
          icon="◎"
          label="Focus share"
          value={totalSec > 0 ? `${focusPct}%` : '—'}
          sub={`${focusLabel(focusPct, totalSec > 0)} · app-category based`}
        />
      </div>

      {/* ── 3. Category allocation ─────────────────────────────────────── */}
      <div className="mt-4">
        <AllocationCard categories={cats} totalSec={totalSec} />
      </div>

      {/* ── 4. Activity timeline ───────────────────────────────────────── */}
      <div className="mt-4">
        <TimelineCard sessions={meaningfulSessions} cats={cats} />
      </div>

      {/* ── 5+6. Recent sessions + Insight ────────────────────────────── */}
      <div className="flex gap-3 mt-4 items-start">
        <div className="flex-1 min-w-0">
          <RecentSessionsCard sessions={meaningfulSessions} />
        </div>
        <div className="w-[264px] shrink-0">
          <InsightCard
            focusSec={focusSec}
            focusPct={focusPct}
            topCategory={cats[0]?.category ?? null}
            totalSec={totalSec}
          />
        </div>
      </div>

      {/* ── 7. Top websites ────────────────────────────────────────────── */}
      <div className="mt-4 mb-2">
        <WebsitesCard />
      </div>

    </div>
  )
}

// ─── 1. Hero card ─────────────────────────────────────────────────────────────

function HeroCard({
  totalSec,
  focusSec,
  appCount,
}: {
  totalSec: number
  focusSec: number
  appCount: number
}) {
  return (
    <div
      className="rounded-xl p-5 flex flex-col gap-2"
      style={{
        background: 'var(--color-hero-gradient)',
        border:     '1px solid var(--color-hero-border)',
      }}
    >
      <p className="text-[13px] text-[var(--color-text-secondary)]">{greeting()}</p>

      <div className="flex items-baseline gap-2 mt-0.5">
        <span
          className="leading-none tracking-[-1.5px] tabular-nums font-bold text-[var(--color-text-primary)]"
          style={{ fontSize: 48 }}
        >
          {totalSec > 0 ? formatDuration(totalSec) : '—'}
        </span>
      </div>

      <p className="text-[13px] opacity-60 text-[var(--color-text-secondary)]">active today</p>

      <div className="flex gap-2 mt-1">
        <HeroPill>⊞ {appCount} apps</HeroPill>
        {focusSec > 0 && <HeroPill>⚡ {formatDuration(focusSec)} focus</HeroPill>}
      </div>
    </div>
  )
}

function HeroPill({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="text-[12px] font-medium text-[var(--color-text-primary)] px-3 py-1 rounded-full"
      style={{ background: 'var(--color-pill-bg)' }}
    >
      {children}
    </span>
  )
}

// ─── 2. Stat card ─────────────────────────────────────────────────────────────

function StatCard({
  icon, label, value, sub, accent,
}: {
  icon: string
  label: string
  value: string
  sub: string
  accent?: boolean
}) {
  return (
    <div className="card flex flex-col gap-2">
      <div
        className="w-7 h-7 rounded-lg flex items-center justify-center text-sm"
        style={{ background: accent ? 'var(--color-icon-tint)' : 'var(--color-icon-bg)' }}
      >
        {icon}
      </div>

      <p
        className="text-[22px] font-bold leading-tight tracking-tight tabular-nums"
        style={{ color: accent ? 'var(--color-accent)' : 'var(--color-text-primary)' }}
      >
        {value}
      </p>

      <div>
        <p className="section-label">{label}</p>
        {sub && (
          <p className="text-[11px] text-[var(--color-text-secondary)] mt-0.5">{sub}</p>
        )}
      </div>
    </div>
  )
}

// ─── 3. Category allocation card ──────────────────────────────────────────────

function AllocationCard({ categories, totalSec }: { categories: CategorySummary[]; totalSec: number }) {
  const hasData = categories.length > 0 && totalSec > 0

  return (
    <div className="card">
      <p className="section-label mb-3">Time Allocation</p>

      {/* Stacked proportional bar */}
      <div className="flex h-[10px] rounded-full overflow-hidden gap-px mb-3">
        {hasData ? (
          categories.slice(0, 8).map((cat) => (
            <div
              key={cat.category}
              title={`${cat.category} · ${formatDuration(cat.totalSeconds)}`}
              style={{
                width: `${percentOf(cat.totalSeconds, totalSec)}%`,
                background: catColor(cat.category),
                minWidth: 3,
              }}
            />
          ))
        ) : (
          <div className="w-full bg-[var(--color-surface-high)]" />
        )}
      </div>

      {/* Legend chips */}
      {hasData ? (
        <div className="flex flex-wrap gap-1.5">
          {categories.slice(0, 6).map((cat) => {
            const c = catColor(cat.category)
            return (
              <div
                key={cat.category}
                className="flex items-center gap-1.5 px-2 py-1 rounded-full"
                style={{ background: c + '1a' }}
              >
                <div className="w-1.5 h-1.5 rounded-full" style={{ background: c }} />
                <span className="text-[11px] font-medium" style={{ color: c }}>
                  {formatCategory(cat.category)}
                </span>
                <span className="text-[11px] text-[var(--color-text-tertiary)]">
                  {formatDuration(cat.totalSeconds)}
                </span>
              </div>
            )
          })}
          {categories.length > 6 && (
            <span className="text-[11px] text-[var(--color-text-tertiary)] px-2 py-1">
              +{categories.length - 6} more
            </span>
          )}
        </div>
      ) : (
        <p className="text-[12px] text-[var(--color-text-tertiary)]">
          No activity recorded yet today.
        </p>
      )}
    </div>
  )
}

// ─── 4. Activity timeline card ────────────────────────────────────────────────

function TimelineCard({ sessions, cats }: { sessions: AppSession[]; cats: CategorySummary[] }) {
  // Only sessions that have both start and end times
  const finished = sessions.filter((s): s is AppSession & { endTime: number } => s.endTime !== null)
  const recentList = finished
    .filter((s) => s.durationSeconds >= 30)
    .slice()
    .reverse()
    .slice(0, 8)

  return (
    <div className="card">
      <p className="section-label mb-3">Activity Timeline</p>

      {/* Horizontal band */}
      <div
        className="relative rounded-[5px] overflow-hidden mb-1"
        style={{ height: 36, background: 'var(--color-surface-high)' }}
      >
        {/* Subtle hour grid lines */}
        {[9, 12, 15, 18, 21].map((h) => (
          <div
            key={h}
            className="absolute top-0 bottom-0 w-px opacity-20"
            style={{
              left: `${((h - TL_START) / TL_TOTAL) * 100}%`,
              background: 'var(--color-text-tertiary)',
            }}
          />
        ))}

        {/* Session segments */}
        {finished.map((s) => {
          const sd = new Date(s.startTime)
          const ed = new Date(s.endTime)
          const startH = sd.getHours() + sd.getMinutes() / 60
          const endH   = ed.getHours() + ed.getMinutes() / 60

          const clampStart = Math.max(TL_START, Math.min(TL_END, startH))
          const clampEnd   = Math.max(TL_START, Math.min(TL_END, endH))
          if (clampEnd <= clampStart) return null

          const left  = ((clampStart - TL_START) / TL_TOTAL) * 100
          const width = ((clampEnd - clampStart) / TL_TOTAL) * 100
          const color = catColor(s.category)

          return (
            <div
              key={s.id}
              className="absolute top-1 bottom-1 rounded-[3px]"
              title={`${s.appName} · ${formatDuration(s.durationSeconds)}\n${formatTime(s.startTime)} – ${formatTime(s.endTime)}`}
              style={{
                left:     `${left}%`,
                width:    `${Math.max(0.4, width)}%`,
                background: color,
                opacity:  0.85,
                boxShadow: `0 0 5px ${color}55`,
              }}
            />
          )
        })}
      </div>

      {/* Hour labels */}
      <div className="relative h-4 mb-2">
        {TL_LABELS.map((h) => (
          <span
            key={h}
            className="absolute text-[10px] text-[var(--color-text-tertiary)]"
            style={{ left: `${((h - TL_START) / TL_TOTAL) * 100}%`, transform: 'translateX(-50%)' }}
          >
            {hourLabel(h)}
          </span>
        ))}
      </div>

      {/* Category legend */}
      {cats.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {cats.slice(0, 5).map((cat) => {
            const c = catColor(cat.category)
            return (
              <div
                key={cat.category}
                className="flex items-center gap-1 px-2 py-0.5 rounded-full"
                style={{ background: c + '15' }}
              >
                <div className="w-1.5 h-1.5 rounded-full" style={{ background: c }} />
                <span className="text-[10px] font-medium" style={{ color: c }}>
                  {formatCategory(cat.category)}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* Session list below band */}
      {recentList.length > 0 ? (
        <>
          <div className="border-t border-[var(--color-border)] mb-3" />
          <div className="flex flex-col gap-2.5">
            {recentList.map((s) => (
              <div key={s.id} className="flex items-center gap-3">
                <AppInitials name={s.appName} category={s.category} size={28} />

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="text-[13px] text-[var(--color-text-primary)] truncate leading-none">
                      {s.appName}
                    </span>
                    <CategoryChip category={s.category} />
                  </div>
                  <span className="text-[11px] text-[var(--color-text-tertiary)] tabular-nums">
                    {formatTime(s.startTime)} – {formatTime(s.endTime)}
                  </span>
                </div>

                <span className="text-[12px] text-[var(--color-text-secondary)] tabular-nums shrink-0">
                  {formatDuration(s.durationSeconds)}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="text-[12px] text-[var(--color-text-tertiary)]">
          No completed sessions yet today.
        </p>
      )}
    </div>
  )
}

// ─── 5. Recent sessions card ──────────────────────────────────────────────────

function RecentSessionsCard({ sessions }: { sessions: AppSession[] }) {
  const recentSessions = sessions
    .filter((s): s is AppSession & { endTime: number } => s.endTime !== null)
    .filter((s) => s.durationSeconds >= 30)
    .slice()
    .reverse()
    .slice(0, 5)

  return (
    <div className="card">
      <p className="section-label mb-3">Recent Sessions</p>

      {recentSessions.length === 0 ? (
        <p className="text-[12px] text-[var(--color-text-tertiary)]">
          No meaningful sessions yet. Daylens will fill this in once you spend a little longer in an app.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {recentSessions.map((session) => {
            const color = catColor(session.category)
            const dots =
              session.durationSeconds > 3600 ? 3 :
              session.durationSeconds > 1800 ? 2 :
              1
            return (
              <div key={session.id} className="flex items-center gap-3">
                <AppInitials name={session.appName} category={session.category} size={34} />

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="text-[13px] font-medium text-[var(--color-text-primary)] truncate leading-none">
                      {session.appName}
                    </span>
                    <CategoryChip category={session.category} />
                  </div>
                  <span className="text-[11px] text-[var(--color-text-secondary)] tabular-nums">
                    {formatTime(session.startTime)} – {formatTime(session.endTime)}
                    {' · '}
                    {formatDuration(session.durationSeconds)}
                  </span>
                </div>

                {/* Efficiency dots */}
                <div className="flex gap-1 shrink-0">
                  {([0, 1, 2] as const).map((i) => (
                    <div
                      key={i}
                      className="w-1.5 h-1.5 rounded-full"
                      style={{ background: i < dots ? color : 'var(--color-surface-high)' }}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── 6. Intelligence insight card ─────────────────────────────────────────────

function InsightCard({
  focusSec, focusPct, topCategory, totalSec,
}: {
  focusSec: number
  focusPct: number
  topCategory: AppCategory | null
  totalSec: number
}) {
  const title =
    totalSec === 0 ? 'Waiting for more activity' :
    focusPct >= 75 ? 'Strong focus signal' :
    focusPct >= 50 ? 'Balanced workday' :
    'Focus looks fragmented'

  function trackedFact(): string {
    if (!topCategory || totalSec === 0) {
      return 'Tracked facts will appear here after a few minutes of activity.'
    }
    return `${formatDuration(focusSec)} focused activity out of ${formatDuration(totalSec)} tracked today. Top category: ${formatCategory(topCategory)}.`
  }

  function suggestion(): string {
    if (totalSec === 0) {
      return 'Keep Daylens running while you work and this card will switch from placeholders to tracked patterns.'
    }
    if (focusPct >= 75) {
      return 'Your tracked app mix is holding up well. If this matches how the work felt, preserve the same setup for the next block.'
    }
    if (focusPct >= 50) {
      return 'You have a solid base. A cleaner next block or fewer switches would likely move the day into a stronger focus range.'
    }
    return 'The day is tilting toward context switching or low-signal activity. A short deliberate focus block would meaningfully improve the mix.'
  }

  return (
    <div className="card flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <div
          className="w-[22px] h-[22px] rounded-md flex items-center justify-center text-[12px]"
          style={{ background: 'var(--color-icon-tint)' }}
        >
          ✦
        </div>
        <p className="section-label">Intelligence</p>
      </div>

      <p className="text-[14px] font-semibold text-[var(--color-text-primary)] leading-snug">
        {title}
      </p>

      <div className="flex flex-col gap-2">
        <div>
          <p className="section-label mb-1">Tracked facts</p>
          <p className="text-[12px] text-[var(--color-text-secondary)] leading-relaxed">
            {trackedFact()}
          </p>
        </div>
        <div>
          <p className="section-label mb-1">Suggestion</p>
          <p className="text-[12px] text-[var(--color-text-secondary)] leading-relaxed">
            {suggestion()}
          </p>
        </div>
      </div>

      {/* Optimization score bar */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="section-label">Optimization score</span>
          <span
            className="text-[11px] font-semibold tabular-nums"
            style={{ color: 'var(--color-accent)' }}
          >
            {focusPct}/100
          </span>
        </div>
        <div className="h-[5px] rounded-full overflow-hidden bg-[var(--color-surface-high)]">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{
              width:      `${focusPct}%`,
              background: 'var(--color-bar-gradient)',
            }}
          />
        </div>
      </div>
    </div>
  )
}

// ─── 7. Top websites ──────────────────────────────────────────────────────────

function WebsitesCard() {
  const [sites, setSites] = useState<WebsiteSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ipc.db.getWebsiteSummaries(1).then((data) => {
      setSites(data as WebsiteSummary[])
      setLoading(false)
    })
  }, [])

  const maxSec = sites[0]?.totalSeconds ?? 1

  return (
    <div className="card">
      <p className="section-label mb-3">Top Websites</p>

      {loading ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-9 rounded-lg animate-pulse bg-[var(--color-surface-high)]" />
          ))}
        </div>
      ) : sites.length === 0 ? (
        <p className="text-[12px] text-[var(--color-text-tertiary)]">
          No browser visits recorded today. Make sure Chrome, Brave, Arc, or Edge is running.
        </p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {sites.slice(0, 5).map((site) => {
            const barW = (site.totalSeconds / maxSec) * 100
            return (
              <div key={site.domain} className="flex items-center gap-3">
                <div
                  className="w-7 h-7 rounded-lg flex items-center justify-center text-[10px] font-bold shrink-0"
                  style={{ background: 'var(--color-icon-tint)', color: 'var(--color-accent)' }}
                >
                  {site.domain.slice(0, 2).toUpperCase()}
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-[13px] text-[var(--color-text-primary)] truncate leading-none mb-1">
                    {site.domain}
                  </p>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-[3px] rounded-full overflow-hidden bg-[var(--color-surface-high)]">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${barW}%`, background: 'var(--color-accent)' }}
                      />
                    </div>
                    <span className="text-[10px] text-[var(--color-text-tertiary)] shrink-0 tabular-nums">
                      {site.visitCount} {site.visitCount === 1 ? 'visit' : 'visits'}
                    </span>
                  </div>
                </div>

                <span className="text-[12px] text-[var(--color-text-secondary)] shrink-0 tabular-nums">
                  {formatDuration(site.totalSeconds)}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Shared primitives ────────────────────────────────────────────────────────

function AppInitials({ name, category, size }: { name: string; category: AppCategory; size: number }) {
  const words = name.trim().split(/\s+/)
  const initials = words.length >= 2
    ? (words[0][0] + words[1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase()
  const color = catColor(category)

  return (
    <div
      className="flex items-center justify-center rounded-lg shrink-0 font-bold"
      style={{
        width:      size,
        height:     size,
        background: color + '22',
        color,
        fontSize:   Math.round(size * 0.34),
        borderRadius: Math.round(size * 0.22),
      }}
    >
      {initials}
    </div>
  )
}

function CategoryChip({ category }: { category: AppCategory }) {
  const color = catColor(category)
  return (
    <span
      className="text-[9px] font-semibold tracking-[0.4px] px-1.5 py-0.5 rounded shrink-0"
      style={{ background: color + '1a', color }}
    >
      {formatCategory(category)}
    </span>
  )
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="p-6 max-w-[920px] mx-auto space-y-4">
      <div className="h-[132px] rounded-xl animate-pulse bg-[var(--color-surface-card)]" />
      <div className="grid grid-cols-3 gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-24 rounded-xl animate-pulse bg-[var(--color-surface-card)]" />
        ))}
      </div>
      <div className="h-20 rounded-xl animate-pulse bg-[var(--color-surface-card)]" />
      <div className="h-[160px] rounded-xl animate-pulse bg-[var(--color-surface-card)]" />
      <div className="flex gap-3">
        <div className="flex-1 h-[180px] rounded-xl animate-pulse bg-[var(--color-surface-card)]" />
        <div className="w-[264px] h-[180px] rounded-xl animate-pulse bg-[var(--color-surface-card)]" />
      </div>
    </div>
  )
}
