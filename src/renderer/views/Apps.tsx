import { useEffect, useMemo, useRef, useState } from 'react'
import { ANALYTICS_EVENT, trackedTimeBucket } from '@shared/analytics'
import type { AISurfaceSummary, AppCategory, AppDetailPayload, AppUsageSummary, LiveSession } from '@shared/types'
import EntityIcon from '../components/EntityIcon'
import InlineRevealText from '../components/InlineRevealText'
import { useProjectionResource } from '../hooks/useProjectionResource'
import { track } from '../lib/analytics'
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


function normalizedActivityLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function detailSummary(detail: AppDetailPayload, selectedAppName: string): string {
  const blockLabels = detail.blockAppearances
    .slice(0, 3)
    .map((block) => block.label)
    .filter(Boolean)
    .filter((label) => normalizedActivityLabel(label) !== normalizedActivityLabel(selectedAppName))
    .filter((label, index, labels) => labels.indexOf(label) === index)

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
  return parts.join('. ') || 'Daylens needs more context to describe this tool.'
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
  const [days, setDays] = useState<(typeof DAYS_OPTIONS)[number]>(1)
  const [selectedCategory, setSelectedCategory] = useState<AppCategory | null>(null)
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null)
  const [isCompact, setIsCompact] = useState(() => window.innerWidth < 1120)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const lastTrackedDetailKeyRef = useRef<string | null>(null)

  useEffect(() => {
    const onResize = () => setIsCompact(window.innerWidth < 1120)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    track(ANALYTICS_EVENT.APPS_OPENED, {
      surface: 'apps',
      trigger: 'navigation',
      view: 'apps',
    })
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
    const seenLabels = new Set<string>()
    const result: AppCategory[] = []
    for (const summary of summaries) {
      const label = categoryLabel(summary.category)
      if (!seenLabels.has(label)) {
        seenLabels.add(label)
        result.push(summary.category)
      }
    }
    return result.sort((left, right) => categoryLabel(left).localeCompare(categoryLabel(right)))
  }, [summaries])

  const filteredSummaries = useMemo(
    () => selectedCategory
      ? summaries.filter((summary) => categoryLabel(summary.category) === categoryLabel(selectedCategory))
      : summaries,
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
  const narrativeResource = useProjectionResource<AISurfaceSummary | null>({
    scope: 'apps',
    enabled: !!selectedCanonicalId,
    dependencies: [selectedCanonicalId, days],
    intervalMs: 0,
    shouldReload: (event) => (
      !event.canonicalAppId
      || event.canonicalAppId === selectedCanonicalId
    ),
    load: () => ipc.ai.getAppNarrative(selectedCanonicalId as string, days).catch(() => null),
  })

  const expectedRangeKey = `${days}d:${todayString()}`
  const detail = detailResource.data && detailResource.data.canonicalAppId === selectedCanonicalId
    && detailResource.data.rangeKey === expectedRangeKey
    ? detailResource.data
    : null
  // Only trust the narrative if it was produced for the currently selected
  // app. Without this guard, switching apps briefly shows a stale narrative
  // from the previously selected app while the new one loads.
  // scopeKey format matches `app:${canonicalAppId}:${rangeKey}` produced by
  // the main-process narrative builder.
  const expectedNarrativeScopeKey = selectedCanonicalId
    ? `app:${selectedCanonicalId}:${expectedRangeKey}`
    : null
  const narrative = narrativeResource.data
    && narrativeResource.data.scope === 'app_detail'
    && narrativeResource.data.scopeKey === expectedNarrativeScopeKey
    ? narrativeResource.data
    : null

  useEffect(() => {
    if (!detail) return
    const detailKey = `${detail.canonicalAppId}:${detail.rangeKey}`
    if (lastTrackedDetailKeyRef.current === detailKey) return
    lastTrackedDetailKeyRef.current = detailKey
    track(ANALYTICS_EVENT.APP_DETAIL_OPENED, {
      surface: 'apps',
      tracked_time_bucket: trackedTimeBucket(detail.totalSeconds),
      trigger: 'click',
      view: 'apps',
    })
  }, [detail])

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
                      <EntityIcon appName={summary.appName} bundleId={summary.bundleId} canonicalAppId={summary.canonicalAppId} size={26} />
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
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', minHeight: 200 }}>
                <span style={{ fontSize: 13, color: 'var(--color-text-tertiary)', opacity: 0.5 }}>Select an app</span>
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
                    <EntityIcon appName={selectedSummary.appName} bundleId={selectedSummary.bundleId} canonicalAppId={selectedSummary.canonicalAppId} size={38} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <InlineRevealText
                        text={formatDisplayAppName(selectedSummary.appName)}
                        style={{ fontSize: 27, fontWeight: 780, letterSpacing: '-0.03em', color: 'var(--color-text-primary)' }}
                      />
                      <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 4 }}>
                        {categoryLabel(selectedSummary.category)} • {formatDuration(selectedSummary.totalSeconds)} in the last {days === 1 ? 'day' : `${days} days`}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void narrativeResource.refresh()}
                      style={{
                        padding: '7px 10px',
                        borderRadius: 8,
                        border: '1px solid var(--color-border-ghost)',
                        background: 'var(--color-surface-low)',
                        color: 'var(--color-text-secondary)',
                        fontSize: 11.5,
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      Refresh
                    </button>
                  </div>
                  <p style={{ fontSize: 13.5, lineHeight: 1.7, color: 'var(--color-text-secondary)', margin: '14px 0 0' }}>
                    {narrative?.summary || (detail ? detailSummary(detail, formatDisplayAppName(selectedSummary.appName)) : 'Loading app context…')}
                  </p>
                  {narrativeResource.loading && !narrative && (
                    <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 10 }}>
                      Generating a stronger app narrative…
                    </div>
                  )}
                  {narrative?.stale && (
                    <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 10 }}>
                      Showing the last saved narrative while new activity settles.
                    </div>
                  )}
                </div>

                {detailResource.error && (
                  <div style={{ color: '#f87171', fontSize: 13 }}>
                    Could not load app detail: {detailResource.error}
                  </div>
                )}

                {detail && (() => {
                  const appDisplayName = formatDisplayAppName(selectedSummary.appName)
                  const filteredAppearances = detail.blockAppearances.filter(
                    (block) => block.label.toLowerCase() !== appDisplayName.toLowerCase(),
                  )
                  const fileArtifacts = detail.topArtifacts.filter((a) => a.artifactType !== 'page')
                  return (
                    <>
                      {filteredAppearances.length > 0 && (
                        <section style={{ borderRadius: 18, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', padding: '18px 20px' }}>
                          <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 12 }}>
                            What you did there
                          </div>
                          <div style={{ display: 'grid', gap: 8 }}>
                            {filteredAppearances.slice(0, 10).map((block) => (
                              <button
                                key={block.blockId}
                                type="button"
                                onClick={() => { window.location.hash = `#/timeline?view=day&date=${localDateKey(block.startTime)}` }}
                                style={{
                                  width: '100%',
                                  border: '1px solid var(--color-border-ghost)',
                                  background: 'var(--color-surface-low)',
                                  borderRadius: 12,
                                  padding: '10px 14px',
                                  textAlign: 'left',
                                  cursor: 'pointer',
                                }}
                              >
                                <div style={{ fontSize: 13.5, fontWeight: 620, color: 'var(--color-text-primary)' }}>
                                  {block.label}
                                </div>
                                <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 3 }}>
                                  {formatBlockRange(block.startTime, block.endTime)}
                                </div>
                              </button>
                            ))}
                          </div>
                        </section>
                      )}

                      {fileArtifacts.length > 0 && (
                        <section style={{ borderRadius: 18, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', padding: '18px 20px' }}>
                          <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 12 }}>
                            Files & documents
                          </div>
                          <div style={{ display: 'grid', gap: 12 }}>
                            {fileArtifacts.slice(0, 8).map((artifact) => (
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
                                  canonicalAppId={artifact.canonicalAppId}
                                  ownerBundleId={artifact.ownerBundleId}
                                  ownerAppName={artifact.ownerAppName}
                                  ownerAppInstanceId={artifact.ownerAppInstanceId}
                                  title={artifact.displayTitle}
                                  path={artifact.path}
                                  domain={artifact.host}
                                  url={artifact.url}
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
                      )}

                      {detail.topPages.length > 0 && (
                        <section style={{ borderRadius: 18, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', padding: '18px 20px' }}>
                          <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 12 }}>
                            Pages visited
                          </div>
                          <div style={{ display: 'grid', gap: 12 }}>
                            {detail.topPages.slice(0, 8).map((page) => (
                              <button
                                key={page.id}
                                type="button"
                                onClick={() => void openArtifact(page)}
                                disabled={page.openTarget.kind === 'unsupported' || !page.openTarget.value}
                                style={{
                                  display: 'flex',
                                  alignItems: 'start',
                                  gap: 10,
                                  width: '100%',
                                  padding: 0,
                                  border: 'none',
                                  background: 'transparent',
                                  textAlign: 'left',
                                  cursor: page.openTarget.kind === 'unsupported' || !page.openTarget.value ? 'default' : 'pointer',
                                }}
                              >
                                <EntityIcon
                                  artifactType="page"
                                  domain={page.domain}
                                  url={page.url}
                                  size={28}
                                />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <InlineRevealText
                                    text={page.displayTitle}
                                    style={{ fontSize: 13.5, fontWeight: 620, color: 'var(--color-text-primary)' }}
                                  />
                                  <InlineRevealText
                                    text={page.domain}
                                    style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}
                                  />
                                </div>
                                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
                                  {formatDuration(page.totalSeconds)}
                                </div>
                              </button>
                            ))}
                          </div>
                        </section>
                      )}

                      {detail.pairedApps.length > 0 && (
                        <section style={{ borderRadius: 18, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', padding: '18px 20px' }}>
                          <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 12 }}>
                            Often used with
                          </div>
                          <div style={{ display: 'grid', gap: 12 }}>
                            {detail.pairedApps.slice(0, 8).map((app) => (
                              <div key={app.canonicalAppId} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <EntityIcon appName={app.displayName} bundleId={app.bundleId} canonicalAppId={app.canonicalAppId} size={28} />
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
                      )}
                    </>
                  )
                })()}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
