import { useEffect, useMemo, useRef, useState } from 'react'
import { ANALYTICS_EVENT, trackedTimeBucket } from '@shared/analytics'
import { activityCategoryLabel } from '@shared/activityCategories'
import { ALL_TIME_DAYS } from '@shared/types'
import type { AISurfaceSummary, AppCategory, AppDetailPayload, AppUsageSummary } from '@shared/types'
import { evidenceTitlesFromBreakdown } from '@shared/appDetailAccount'
import { appDetailRangeKey, appNarrativeScopeKey, isThinAppNarrative, selectVisibleAppNarrative } from '@shared/appNarrativeContract'
import PeriodNavigator from '../components/PeriodNavigator'
import { useCompactLayout } from '../hooks/useCompactLayout'
import { useProjectionResource } from '../hooks/useProjectionResource'
import { track } from '../lib/analytics'
import { shiftDateString, todayString } from '../lib/format'
import { ipc } from '../lib/ipc'
import AppDetail, { type GenerationStatus } from './apps/AppDetail'
import AppList from './apps/AppList'
import type { WebsiteActivityTarget } from './apps/BrowserActivityBreakdown'
import { appSummaryId, filterAppSummariesByCategory, splitAppSummaries } from './apps/appsViewModel'

const DAYS_OPTIONS = [1, 7, 30, ALL_TIME_DAYS] as const

function formatAppsDateLabel(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    .format(new Date(year, month - 1, day))
}

export default function Apps() {
  const [days, setDays] = useState<(typeof DAYS_OPTIONS)[number]>(1)
  const [selectedDate, setSelectedDate] = useState(todayString())
  const dateMode = days === 1
  const isAppsToday = dateMode && selectedDate === todayString()
  const isAppsPastDay = dateMode && selectedDate !== todayString()
  const [selectedCategory, setSelectedCategory] = useState<AppCategory | null>(null)
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null)
  const isCompact = useCompactLayout()
  const contentRef = useRef<HTMLDivElement | null>(null)
  const lastTrackedDetailKeyRef = useRef<string | null>(null)

  useEffect(() => {
    track(ANALYTICS_EVENT.APPS_OPENED, { surface: 'apps', trigger: 'navigation', view: 'apps' })
  }, [])

  const appsResource = useProjectionResource<{ summaries: AppUsageSummary[] }>({
    scope: 'apps',
    dependencies: [days, dateMode ? selectedDate : null],
    intervalMs: isAppsToday ? 30_000 : 0,
    load: async () => {
      const summaries = await (dateMode
        ? (isAppsToday ? ipc.db.getAppSummaries(1) : ipc.db.getAppSummariesForDate(selectedDate))
        : ipc.db.getAppSummaries(days))
      return { summaries }
    },
  })

  // The main process returns live-inclusive summaries (canonical facts carry
  // the open live interval; legacy fallback merges the tracker session), so
  // adding live seconds here again would double-count the in-progress stretch.
  const summaries = appsResource.data?.summaries ?? []

  const categories = useMemo(() => {
    const categories = [...new Set(summaries.map((summary) => summary.category))]
    return categories.sort((left, right) => activityCategoryLabel(left).localeCompare(activityCategoryLabel(right)))
  }, [summaries])

  const filteredSummaries = useMemo(
    () => filterAppSummariesByCategory(summaries, selectedCategory),
    [selectedCategory, summaries],
  )
  const { primary, fleeting } = useMemo(
    () => splitAppSummaries(filteredSummaries, selectedCategory),
    [filteredSummaries, selectedCategory],
  )

  useEffect(() => {
    if (!selectedAppId || summaries.length === 0) return
    if (!summaries.some((summary) => appSummaryId(summary) === selectedAppId)) setSelectedAppId(null)
  }, [summaries, selectedAppId])

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0
  }, [days, selectedCategory, selectedAppId])

  const selectedSummary = summaries.find((summary) => appSummaryId(summary) === selectedAppId) ?? null
  const selectedCanonicalId = selectedSummary ? appSummaryId(selectedSummary) : null
  const requestRange = isAppsPastDay ? selectedDate : days

  const detailResource = useProjectionResource<AppDetailPayload>({
    scope: 'apps',
    enabled: !!selectedCanonicalId,
    dependencies: [selectedCanonicalId, days, isAppsPastDay ? selectedDate : null],
    shouldReload: (event) => !event.canonicalAppId || event.canonicalAppId === selectedCanonicalId,
    load: () => ipc.db.getAppDetail(selectedCanonicalId as string, requestRange),
  })

  const narrativeResource = useProjectionResource<AISurfaceSummary | null>({
    scope: 'apps',
    enabled: !!selectedCanonicalId,
    dependencies: [selectedCanonicalId, days, isAppsPastDay ? selectedDate : null],
    intervalMs: 0,
    shouldReload: (event) => !event.canonicalAppId || event.canonicalAppId === selectedCanonicalId,
    load: () => ipc.ai.getAppNarrative(selectedCanonicalId as string, requestRange, false),
  })

  const expectedRangeKey = appDetailRangeKey(requestRange, todayString())
  const detail = detailResource.data
    && detailResource.data.canonicalAppId === selectedCanonicalId
    && detailResource.data.rangeKey === expectedRangeKey
    ? detailResource.data
    : null
  const expectedNarrativeScopeKey = selectedCanonicalId
    ? appNarrativeScopeKey(selectedCanonicalId, expectedRangeKey)
    : null
  const rawNarrative = narrativeResource.data
    && narrativeResource.data.scope === 'app_detail'
    && narrativeResource.data.scopeKey === expectedNarrativeScopeKey
    ? narrativeResource.data
    : null
  const evidenceTitles = [
    ...evidenceTitlesFromBreakdown(detail?.activityBreakdown),
    ...(detail?.topArtifacts ?? []).map((artifact) => artifact.displayTitle),
    ...(detail?.blockAppearances ?? []).map((block) => block.label),
  ]
  const visibleNarrativeSummary = rawNarrative
    ? selectVisibleAppNarrative(rawNarrative.summary, evidenceTitles)
    : null
  const narrative = rawNarrative && visibleNarrativeSummary
    ? { ...rawNarrative, summary: visibleNarrativeSummary }
    : null

  const [activeGenerationScopes, setActiveGenerationScopes] = useState<Set<string>>(() => new Set())
  const [lastGenerationStatus, setLastGenerationStatus] = useState<Record<string, GenerationStatus>>({})
  const [deletingActivityKey, setDeletingActivityKey] = useState<string | null>(null)
  const [deleteActivityError, setDeleteActivityError] = useState<string | null>(null)
  const isUserGenerating = expectedNarrativeScopeKey
    ? activeGenerationScopes.has(expectedNarrativeScopeKey)
    : false
  const currentGenerationStatus = expectedNarrativeScopeKey
    ? lastGenerationStatus[expectedNarrativeScopeKey] ?? null
    : null

  const handleGenerateAppNarrative = async () => {
    if (!selectedCanonicalId || !expectedNarrativeScopeKey || activeGenerationScopes.has(expectedNarrativeScopeKey)) return
    const scopeKey = expectedNarrativeScopeKey
    setActiveGenerationScopes((previous) => new Set(previous).add(scopeKey))
    setLastGenerationStatus((previous) => {
      if (!(scopeKey in previous)) return previous
      const next = { ...previous }
      delete next[scopeKey]
      return next
    })
    try {
      const result = await ipc.ai.getAppNarrative(selectedCanonicalId, requestRange, true)
      const status: GenerationStatus = !result
        ? { kind: 'no-bundle' }
        : isThinAppNarrative(result.summary)
          || (evidenceTitles.length > 0 && !selectVisibleAppNarrative(result.summary, evidenceTitles))
          ? { kind: 'thin' }
          : { kind: 'ok' }
      setLastGenerationStatus((previous) => ({ ...previous, [scopeKey]: status }))
      await narrativeResource.refresh()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setLastGenerationStatus((previous) => ({ ...previous, [scopeKey]: { kind: 'error', message } }))
    } finally {
      setActiveGenerationScopes((previous) => {
        const next = new Set(previous)
        next.delete(scopeKey)
        return next
      })
    }
  }

  const handleDeleteWebsiteActivity = async (target: WebsiteActivityTarget) => {
    const label = target.title?.trim() || target.domain
    const isPage = Boolean(target.url || target.normalizedUrl || target.pageKey)
    const targetKind = isPage ? 'page' : 'domain'
    const confirmed = window.confirm(
      `Permanently delete this ${targetKind} from all Daylens history?\n\n${label}\n\nThis cannot be undone. Any recap built from it will be cleared. A copy may persist in pre-update backups until you delete all local data.`,
    )
    if (!confirmed) return

    const key = isPage
      ? `url:${target.normalizedUrl ?? target.url ?? target.pageKey}`
      : `domain:${target.domain}`
    setDeletingActivityKey(key)
    setDeleteActivityError(null)
    try {
      if (isPage) {
        await ipc.tracking.deleteActivity({
          url: target.url,
          normalizedUrl: target.normalizedUrl,
          pageKey: target.pageKey,
        })
      } else {
        await ipc.tracking.deleteSiteHistory({ domain: target.domain })
      }
      await appsResource.refresh()
      await detailResource.refresh()
      await narrativeResource.refresh()
    } catch (error) {
      setDeleteActivityError(error instanceof Error ? error.message : String(error))
    } finally {
      setDeletingActivityKey(null)
    }
  }

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

  const selectedRangeLabel = dateMode
    ? (isAppsToday ? 'today' : formatAppsDateLabel(selectedDate))
    : (days >= ALL_TIME_DAYS ? 'all time' : `last ${days} days`)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ padding: '28px 32px 18px', borderBottom: '1px solid var(--color-border-ghost)', background: 'var(--color-bg)' }}>
        <div style={{ marginBottom: 16 }}>
          <PeriodNavigator
            label={dateMode ? (isAppsToday ? 'Today' : formatAppsDateLabel(selectedDate)) : (days >= ALL_TIME_DAYS ? 'All time' : `Last ${days} days`)}
            value={days === 1 ? 'day' : days === 7 ? '7d' : days === 30 ? '30d' : 'all'}
            options={[{ value: 'day', label: 'Day' }, { value: '7d', label: '7d' }, { value: '30d', label: '30d' }, { value: 'all', label: 'All' }]}
            onChange={(value) => {
              const nextDays = value === 'day' ? 1 : value === '7d' ? 7 : value === '30d' ? 30 : ALL_TIME_DAYS
              setDays(nextDays)
              if (nextDays === 1) setSelectedDate(todayString())
            }}
            onPrevious={() => { setDays(1); setSelectedDate((current) => shiftDateString(dateMode ? current : todayString(), -1)) }}
            onNext={() => {
              const next = shiftDateString(dateMode ? selectedDate : todayString(), 1)
              if (next <= todayString()) { setDays(1); setSelectedDate(next) }
            }}
            nextDisabled={dateMode && selectedDate === todayString()}
            onToday={(!dateMode || selectedDate !== todayString()) ? () => { setDays(1); setSelectedDate(todayString()) } : undefined}
          />
        </div>

        {categories.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {[null, ...categories].map((category) => (
              <button
                key={category ?? 'all'}
                type="button"
                aria-pressed={selectedCategory === category}
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
                {category === null ? 'All' : activityCategoryLabel(category)}
              </button>
            ))}
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', justifyContent: 'center' }}>
        <div style={{ display: 'grid', gridTemplateColumns: isCompact ? 'minmax(0, 1fr)' : '320px minmax(0, 1fr)', height: '100%', width: '100%', maxWidth: 1180, minWidth: 0 }}>
          <AppList
            error={appsResource.error}
            summaries={filteredSummaries}
            primary={primary}
            fleeting={fleeting}
            selectedAppId={selectedAppId}
            compact={isCompact}
            onSelect={setSelectedAppId}
          />
          <div ref={contentRef} style={{ overflowY: 'auto', padding: '22px 24px 32px' }}>
            <AppDetail
              summary={selectedSummary}
              rangeLabel={selectedRangeLabel}
              detail={detail}
              detailError={detailResource.error}
              narrative={narrative}
              narrativeError={narrativeResource.error}
              generationStatus={currentGenerationStatus}
              isGenerating={isUserGenerating}
              deleteError={deleteActivityError}
              deletingActivityKey={deletingActivityKey}
              onGenerate={() => { void handleGenerateAppNarrative() }}
              onDeleteWebsiteActivity={(target) => { void handleDeleteWebsiteActivity(target) }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
