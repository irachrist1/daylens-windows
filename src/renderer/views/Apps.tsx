import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppCategory, AppDetailPayload, AppUsageSummary, LiveSession } from '@shared/types'
import EntityIcon from '../components/EntityIcon'
import InlineRevealText from '../components/InlineRevealText'
import { useProjectionResource } from '../hooks/useProjectionResource'
import { ipc } from '../lib/ipc'
import { formatDisplayAppName } from '../lib/apps'
import { formatDuration, todayString } from '../lib/format'
import { openArtifact } from '../lib/openTarget'

const DAYS_OPTIONS = [1, 7, 30] as const

const CATEGORY_LABELS: Record<AppCategory, string> = {
  development: 'Development',
  communication: 'Communication',
  research: 'Research',
  writing: 'Writing',
  aiTools: 'AI tools',
  design: 'Design',
  browsing: 'Browsing',
  meetings: 'Meetings',
  entertainment: 'Entertainment',
  email: 'Email',
  productivity: 'Productivity',
  social: 'Social',
  system: 'System',
  uncategorized: 'Other',
}

function categoryLabel(category: AppCategory): string {
  return CATEGORY_LABELS[category] ?? category
}

function liveAwareSummaries(
  summaries: AppUsageSummary[],
  live: LiveSession | null,
  days: (typeof DAYS_OPTIONS)[number],
): AppUsageSummary[] {
  if (!live) return summaries

  const end = Date.now()
  const today = new Date()
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const rangeStart = days === 1 ? todayStart : todayStart - (days - 1) * 86_400_000
  const liveStart = Math.max(live.startTime, rangeStart)
  const seconds = Math.max(0, Math.round((end - liveStart) / 1000))

  if (seconds <= 0) return summaries

  const index = summaries.findIndex((summary) => summary.bundleId === live.bundleId)
  if (index >= 0) {
    return summaries
      .map((summary, position) => position === index
        ? { ...summary, totalSeconds: summary.totalSeconds + seconds }
        : summary)
      .sort((left, right) => right.totalSeconds - left.totalSeconds)
  }

  return [
    ...summaries,
    {
      bundleId: live.bundleId,
      canonicalAppId: live.canonicalAppId ?? live.bundleId,
      appName: live.appName,
      category: live.category,
      totalSeconds: seconds,
      isFocused: ['development', 'research', 'writing', 'aiTools', 'design', 'productivity'].includes(live.category),
      sessionCount: 1,
    },
  ].sort((left, right) => right.totalSeconds - left.totalSeconds)
}

function topHours(detail: AppDetailPayload): string | null {
  const busy = [...detail.timeOfDayDistribution]
    .filter((entry) => entry.totalSeconds > 0)
    .sort((left, right) => right.totalSeconds - left.totalSeconds)
    .slice(0, 3)

  if (busy.length === 0) return null

  return busy.map((entry) => {
    const endHour = (entry.hour + 1) % 24
    return `${entry.hour}:00–${String(endHour).padStart(2, '0')}:00`
  }).join(' • ')
}

function detailSummary(detail: AppDetailPayload): string {
  const blockLabels = detail.blockAppearances
    .slice(0, 3)
    .map((block) => block.label)
    .filter(Boolean)

  const artifacts = detail.topArtifacts
    .slice(0, 3)
    .map((artifact) => artifact.displayTitle)
    .filter(Boolean)

  const paired = detail.pairedApps
    .slice(0, 3)
    .map((app) => app.displayName)
    .filter(Boolean)

  const parts: string[] = []
  if (blockLabels.length > 0) parts.push(`Most often part of ${blockLabels.join(', ')}`)
  if (artifacts.length > 0) parts.push(`Key artifacts include ${artifacts.join(', ')}`)
  if (paired.length > 0) parts.push(`Often used alongside ${paired.join(', ')}`)
  return parts.join('. ') || 'This tool has tracked activity, but Daylens still needs more context to describe how you use it.'
}

function formatBlockRange(startTime: number, endTime: number): string {
  const formatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return `${formatter.format(startTime)} – ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(endTime)}`
}

function localDateKey(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export default function Apps() {
  const [days, setDays] = useState<(typeof DAYS_OPTIONS)[number]>(7)
  const [selectedCategory, setSelectedCategory] = useState<AppCategory | null>(null)
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null)
  const [isCompact, setIsCompact] = useState(() => window.innerWidth < 1120)
  const contentRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onResize = () => setIsCompact(window.innerWidth < 1120)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const appsResource = useProjectionResource<{
    summaries: AppUsageSummary[]
    live: LiveSession | null
  }>({
    scope: 'apps',
    dependencies: [days],
    intervalMs: 30_000,
    load: async () => {
      const [summaries, live] = await Promise.all([
        ipc.db.getAppSummaries(days),
        ipc.tracking.getLiveSession(),
      ])
      return {
        summaries: summaries as AppUsageSummary[],
        live: live as LiveSession | null,
      }
    },
  })

  const summaries = useMemo(
    () => liveAwareSummaries(appsResource.data?.summaries ?? [], appsResource.data?.live ?? null, days),
    [appsResource.data, days],
  )

  const categories = useMemo(() => {
    const seen = new Set<AppCategory>()
    for (const summary of summaries) {
      seen.add(summary.category)
    }
    return [...seen].sort((left, right) => categoryLabel(left).localeCompare(categoryLabel(right)))
  }, [summaries])

  const filteredSummaries = useMemo(
    () => selectedCategory ? summaries.filter((summary) => summary.category === selectedCategory) : summaries,
    [selectedCategory, summaries],
  )

  useEffect(() => {
    if (!selectedAppId) return
    const current = filteredSummaries.find((summary) => (summary.canonicalAppId ?? summary.bundleId) === selectedAppId)
    if (!current) {
      setSelectedAppId(null)
    }
  }, [filteredSummaries, selectedAppId])

  useEffect(() => {
    const node = contentRef.current
    if (!node) return
    node.scrollTop = 0
  }, [days, selectedCategory, selectedAppId])

  const selectedSummary = filteredSummaries.find((summary) => (summary.canonicalAppId ?? summary.bundleId) === selectedAppId) ?? null
  const selectedCanonicalId = selectedSummary ? (selectedSummary.canonicalAppId ?? selectedSummary.bundleId) : null
  const totalFilteredSeconds = filteredSummaries.reduce((sum, summary) => sum + summary.totalSeconds, 0)
  const leadingApps = filteredSummaries.slice(0, 5)
  const categoryBreakdown = useMemo(() => {
    const totals = new Map<AppCategory, number>()
    for (const summary of filteredSummaries) {
      totals.set(summary.category, (totals.get(summary.category) ?? 0) + summary.totalSeconds)
    }
    return Array.from(totals.entries()).sort((left, right) => right[1] - left[1]).slice(0, 4)
  }, [filteredSummaries])

  const detailResource = useProjectionResource<AppDetailPayload>({
    scope: 'apps',
    enabled: !!selectedCanonicalId,
    dependencies: [selectedCanonicalId, days],
    shouldReload: (event) => (
      !event.canonicalAppId
      || event.canonicalAppId === selectedCanonicalId
    ),
    load: () => ipc.db.getAppDetail(selectedCanonicalId as string, days),
  })

  const expectedRangeKey = `${days}d:${todayString()}`
  const detail = detailResource.data && detailResource.data.canonicalAppId === selectedCanonicalId
    && detailResource.data.rangeKey === expectedRangeKey
    ? detailResource.data
    : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{
        padding: '28px 32px 18px',
        borderBottom: '1px solid var(--color-border-ghost)',
        background: 'var(--color-bg)',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
          <div>
            <h1 style={{ fontSize: 30, lineHeight: 1.1, letterSpacing: '-0.03em', margin: 0, color: 'var(--color-text-primary)' }}>
              Apps
            </h1>
            <p style={{ fontSize: 13.5, color: 'var(--color-text-secondary)', margin: '6px 0 0' }}>
              What each tool was helping you do, which artifacts you touched there, and what it was paired with.
            </p>
          </div>
          <div style={{
            display: 'flex',
            gap: 3,
            padding: 3,
            borderRadius: 9,
            background: 'var(--color-surface-high)',
            border: '1px solid var(--color-border-ghost)',
            flexShrink: 0,
          }}>
            {DAYS_OPTIONS.map((option) => (
              <button
                key={option}
                onClick={() => setDays(option)}
                style={{
                  padding: '4px 12px',
                  borderRadius: 7,
                  border: 'none',
                  cursor: 'pointer',
                  background: days === option ? 'var(--gradient-primary)' : 'transparent',
                  color: days === option ? 'var(--color-primary-contrast)' : 'var(--color-text-secondary)',
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {option === 1 ? 'Today' : `${option}d`}
              </button>
            ))}
          </div>
        </div>

        {categories.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button
              onClick={() => setSelectedCategory(null)}
              style={{
                padding: '6px 11px',
                borderRadius: 999,
                border: '1px solid var(--color-border-ghost)',
                background: selectedCategory === null ? 'var(--color-surface-low)' : 'transparent',
                color: selectedCategory === null ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              All
            </button>
            {categories.map((category) => (
              <button
                key={category}
                onClick={() => setSelectedCategory(category)}
                style={{
                  padding: '6px 11px',
                  borderRadius: 999,
                  border: '1px solid var(--color-border-ghost)',
                  background: selectedCategory === category ? 'var(--color-surface-low)' : 'transparent',
                  color: selectedCategory === category ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                {categoryLabel(category)}
              </button>
            ))}
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflow: 'hidden' }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: isCompact ? 'minmax(0, 1fr)' : '320px minmax(0, 1fr)',
          height: '100%',
        }}>
          <div style={{
            borderRight: isCompact ? 'none' : '1px solid var(--color-border-ghost)',
            overflowY: 'auto',
            padding: '18px 16px 28px',
          }}>
            {appsResource.error && (
              <div style={{ color: '#f87171', fontSize: 13 }}>Could not load apps: {appsResource.error}</div>
            )}

            {!appsResource.error && filteredSummaries.length === 0 && (
              <div style={{
                borderRadius: 16,
                border: '1px solid var(--color-border-ghost)',
                background: 'var(--color-surface)',
                padding: '24px 18px',
                textAlign: 'center',
                color: 'var(--color-text-tertiary)',
              }}>
                No app activity in this range yet.
              </div>
            )}

            <div style={{ display: 'grid', gap: 8 }}>
              {filteredSummaries.map((summary) => {
                const key = summary.canonicalAppId ?? summary.bundleId
                const selected = key === selectedAppId
                return (
                  <button
                    key={key}
                    onClick={() => setSelectedAppId(key)}
                    style={{
                      width: '100%',
                      border: selected ? '1px solid var(--color-border-ghost)' : '1px solid transparent',
                      background: selected ? 'var(--color-surface-low)' : 'transparent',
                      borderRadius: 14,
                      padding: '12px 14px',
                      textAlign: 'left',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <EntityIcon appName={summary.appName} bundleId={summary.bundleId} size={26} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 650, color: 'var(--color-text-primary)' }}>
                          {formatDisplayAppName(summary.appName)}
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
                          {categoryLabel(summary.category)}
                        </div>
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 650, color: 'var(--color-text-primary)', whiteSpace: 'nowrap' }}>
                        {formatDuration(summary.totalSeconds)}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          <div ref={contentRef} style={{ overflowY: 'auto', padding: '22px 24px 32px' }}>
            {!selectedSummary && (
              <div style={{ display: 'grid', gap: 16 }}>
                <div style={{
                  borderRadius: 18,
                  border: '1px solid var(--color-border-ghost)',
                  background: 'var(--color-surface)',
                  padding: '24px 22px',
                }}>
                  <div style={{ fontSize: 27, fontWeight: 780, letterSpacing: '-0.03em', color: 'var(--color-text-primary)' }}>
                    {selectedCategory ? categoryLabel(selectedCategory) : 'Range summary'}
                  </div>
                  <p style={{ fontSize: 13.5, lineHeight: 1.7, color: 'var(--color-text-secondary)', margin: '10px 0 0' }}>
                    {filteredSummaries.length > 0
                      ? `${formatDuration(totalFilteredSeconds)} tracked across ${filteredSummaries.length} app${filteredSummaries.length !== 1 ? 's' : ''} in the last ${days === 1 ? 'day' : `${days} days`}. Pick an app to inspect its own artifacts, pairings, and block context.`
                      : 'No tracked app activity in this range yet.'}
                  </p>
                </div>

                {filteredSummaries.length > 0 && (
                  <>
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: isCompact ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))',
                      gap: 12,
                    }}>
                      <div style={{ borderRadius: 16, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', padding: '16px 18px' }}>
                        <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 8 }}>
                          Top apps
                        </div>
                        <div style={{ display: 'grid', gap: 10 }}>
                          {leadingApps.map((summary) => (
                            <button
                              key={`summary:${summary.canonicalAppId ?? summary.bundleId}`}
                              type="button"
                              onClick={() => setSelectedAppId(summary.canonicalAppId ?? summary.bundleId)}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 10,
                                width: '100%',
                                padding: 0,
                                border: 'none',
                                background: 'transparent',
                                textAlign: 'left',
                                cursor: 'pointer',
                              }}
                            >
                              <EntityIcon appName={summary.appName} bundleId={summary.bundleId} size={26} />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <InlineRevealText
                                  text={formatDisplayAppName(summary.appName)}
                                  style={{ fontSize: 13.5, fontWeight: 620, color: 'var(--color-text-primary)' }}
                                />
                                <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
                                  {categoryLabel(summary.category)}
                                </div>
                              </div>
                              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
                                {formatDuration(summary.totalSeconds)}
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>

                      <div style={{ borderRadius: 16, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', padding: '16px 18px' }}>
                        <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 8 }}>
                          Category mix
                        </div>
                        <div style={{ display: 'grid', gap: 10 }}>
                          {categoryBreakdown.map(([category, seconds]) => (
                            <div key={category} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-accent)' }} />
                                <span style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>{categoryLabel(category)}</span>
                              </div>
                              <span style={{ fontSize: 12, color: 'var(--color-text-primary)' }}>{formatDuration(seconds)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {selectedSummary && (
              <div style={{ display: 'grid', gap: 18 }}>
                <div style={{
                  borderRadius: 18,
                  border: '1px solid var(--color-border-ghost)',
                  background: 'var(--color-surface)',
                  padding: '20px 22px',
                }}>
                  <div style={{ display: 'flex', alignItems: 'start', gap: 14 }}>
                    <EntityIcon appName={selectedSummary.appName} bundleId={selectedSummary.bundleId} size={38} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <InlineRevealText
                        text={formatDisplayAppName(selectedSummary.appName)}
                        style={{ fontSize: 27, fontWeight: 780, letterSpacing: '-0.03em', color: 'var(--color-text-primary)' }}
                      />
                      <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 4 }}>
                        {categoryLabel(selectedSummary.category)} • {formatDuration(selectedSummary.totalSeconds)} in the last {days === 1 ? 'day' : `${days} days`}
                      </div>
                    </div>
                  </div>
                  <p style={{ fontSize: 13.5, lineHeight: 1.7, color: 'var(--color-text-secondary)', margin: '14px 0 0' }}>
                    {detail ? detailSummary(detail) : 'Loading app context…'}
                  </p>
                </div>

                {detailResource.error && (
                  <div style={{ color: '#f87171', fontSize: 13 }}>
                    Could not load app detail: {detailResource.error}
                  </div>
                )}

                {detail && (
                  <>
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: isCompact ? 'minmax(0, 1fr)' : 'repeat(3, minmax(0, 1fr))',
                      gap: 12,
                    }}>
                      <div style={{ borderRadius: 16, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', padding: '16px 18px' }}>
                        <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 8 }}>
                          Key Artifacts
                        </div>
                        <div style={{ fontSize: 24, fontWeight: 760, color: 'var(--color-text-primary)' }}>
                          {detail.topArtifacts.length}
                        </div>
                      </div>
                      <div style={{ borderRadius: 16, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', padding: '16px 18px' }}>
                        <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 8 }}>
                          Used Alongside
                        </div>
                        <div style={{ fontSize: 24, fontWeight: 760, color: 'var(--color-text-primary)' }}>
                          {detail.pairedApps.length}
                        </div>
                      </div>
                      <div style={{ borderRadius: 16, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', padding: '16px 18px' }}>
                        <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 8 }}>
                          Busiest Hours
                        </div>
                        <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--color-text-primary)' }}>
                          {topHours(detail) ?? 'Not enough data yet'}
                        </div>
                      </div>
                    </div>

                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: isCompact ? 'minmax(0, 1fr)' : 'minmax(0, 1.25fr) minmax(0, 1fr)',
                      gap: 16,
                    }}>
                      <section style={{ borderRadius: 18, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', padding: '18px 20px' }}>
                        <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 12 }}>
                          Key Artifacts
                        </div>
                        <div style={{ display: 'grid', gap: 12 }}>
                          {detail.topArtifacts.slice(0, 8).map((artifact) => (
                            <button
                              key={artifact.id}
                              type="button"
                              onClick={() => void openArtifact(artifact)}
                              disabled={artifact.openTarget.kind === 'unsupported' || !artifact.openTarget.value}
                              style={{
                                display: 'flex',
                                alignItems: 'start',
                                gap: 10,
                                width: '100%',
                                padding: 0,
                                border: 'none',
                                background: 'transparent',
                                textAlign: 'left',
                                cursor: artifact.openTarget.kind === 'unsupported' || !artifact.openTarget.value ? 'default' : 'pointer',
                              }}
                            >
                              <EntityIcon
                                artifactType={artifact.artifactType}
                                title={artifact.displayTitle}
                                path={artifact.path}
                                domain={artifact.host}
                                size={28}
                              />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <InlineRevealText
                                  text={artifact.displayTitle}
                                  style={{ fontSize: 13.5, fontWeight: 620, color: 'var(--color-text-primary)' }}
                                />
                                <InlineRevealText
                                  text={artifact.subtitle || artifact.host || artifact.path || artifact.artifactType}
                                  style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}
                                />
                              </div>
                              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
                                {formatDuration(artifact.totalSeconds)}
                              </div>
                            </button>
                          ))}
                        </div>
                      </section>

                      <section style={{ borderRadius: 18, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', padding: '18px 20px' }}>
                        <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 12 }}>
                          Used Alongside
                        </div>
                        <div style={{ display: 'grid', gap: 12 }}>
                          {detail.pairedApps.slice(0, 8).map((app) => (
                            <div key={app.canonicalAppId} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <EntityIcon appName={app.displayName} size={28} />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <InlineRevealText
                                  text={app.displayName}
                                  style={{ fontSize: 13.5, fontWeight: 620, color: 'var(--color-text-primary)' }}
                                />
                              </div>
                              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
                                {formatDuration(app.totalSeconds)}
                              </div>
                            </div>
                          ))}
                        </div>
                      </section>
                    </div>

                    <section style={{ borderRadius: 18, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', padding: '18px 20px' }}>
                      <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 12 }}>
                        What You Were Doing There
                      </div>
                      <div style={{ display: 'grid', gap: 12 }}>
                        {detail.blockAppearances.slice(0, 10).map((block) => (
                          <button
                            key={block.blockId}
                            type="button"
                            onClick={() => { window.location.hash = `#/timeline?view=day&date=${localDateKey(block.startTime)}` }}
                            style={{
                              width: '100%',
                              border: '1px solid var(--color-border-ghost)',
                              background: 'var(--color-surface-low)',
                              borderRadius: 14,
                              padding: '12px 14px',
                              textAlign: 'left',
                              cursor: 'pointer',
                            }}
                          >
                            <div style={{ fontSize: 13.5, fontWeight: 650, color: 'var(--color-text-primary)' }}>
                              {block.label}
                            </div>
                            <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 4 }}>
                              {formatBlockRange(block.startTime, block.endTime)}
                            </div>
                          </button>
                        ))}
                      </div>
                    </section>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
