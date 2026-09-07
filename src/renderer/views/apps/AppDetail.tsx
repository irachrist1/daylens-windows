import type { AISurfaceSummary, AppDetailPayload, AppUsageSummary } from '@shared/types'
import { activityBreakdownHasRows, evidenceTitlesFromBreakdown, resolveAppDetailAccount } from '@shared/appDetailAccount'
import { selectVisibleAppNarrative } from '@shared/appNarrativeContract'
import { activityCategoryLabel } from '@shared/activityCategories'
import { activityColorForCategory } from '@shared/activityColors'
import ActivityListCard from '../../components/ActivityListCard'
import EntityIcon from '../../components/EntityIcon'
import InlineRevealText from '../../components/InlineRevealText'
import { formatDisplayAppName } from '../../lib/apps'
import { formatDuration, localDateStringFromMs } from '../../lib/format'
import ActivityBreakdown from './ActivityBreakdown'
import type { WebsiteActivityTarget } from './BrowserActivityBreakdown'

export type GenerationStatus =
  | { kind: 'ok' }
  | { kind: 'thin' }
  | { kind: 'no-bundle' }
  | { kind: 'error'; message: string }

function appMetricSentence(totalSeconds: number, sessionCount?: number): string {
  const sessions = sessionCount ?? 0
  return `Tracked for ${formatDuration(totalSeconds)}${sessions ? ` across ${sessions} session${sessions === 1 ? '' : 's'}` : ''}.`
}

function formatBlockRange(startTime: number, endTime: number): string {
  const formatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return `${formatter.format(startTime)} – ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(endTime)}`
}

export default function AppDetail({
  summary,
  rangeLabel,
  detail,
  detailError,
  narrative,
  narrativeError,
  generationStatus,
  isGenerating,
  deleteError,
  deletingActivityKey,
  onGenerate,
  onDeleteWebsiteActivity,
}: {
  summary: AppUsageSummary | null
  rangeLabel: string
  detail: AppDetailPayload | null
  detailError: string | null
  narrative: AISurfaceSummary | null
  narrativeError: string | null
  generationStatus: GenerationStatus | null
  isGenerating: boolean
  deleteError: string | null
  deletingActivityKey: string | null
  onGenerate: () => void
  onDeleteWebsiteActivity: (target: WebsiteActivityTarget) => void
}) {
  if (!summary) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', minHeight: 200 }}>
        <span style={{ fontSize: 13, color: 'var(--color-text-tertiary)', opacity: 0.5 }}>Select an app</span>
      </div>
    )
  }

  const evidenceTitles = [
    ...evidenceTitlesFromBreakdown(detail?.activityBreakdown),
    ...(detail?.topArtifacts ?? []).map((artifact) => artifact.displayTitle),
    ...(detail?.blockAppearances ?? []).map((block) => block.label),
  ]
  const generatedAccount = selectVisibleAppNarrative(narrative?.summary, evidenceTitles)
  const account = detail
    ? resolveAppDetailAccount(detail, generatedAccount)
    : null
  const breakdown = detail?.activityBreakdown
  const showWhatYouDid = Boolean(account) || activityBreakdownHasRows(breakdown) || (detail != null && detail.totalSeconds > 0)
  const relatedBlocks = (detail?.blockAppearances ?? []).filter((block) => block.label.trim().length > 0)

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <div style={{ borderRadius: 18, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', padding: '20px 22px' }}>
        <div style={{ display: 'flex', alignItems: 'start', gap: 14 }}>
          <EntityIcon
            appName={summary.appName}
            bundleId={summary.bundleId}
            canonicalAppId={summary.canonicalAppId}
            color={activityColorForCategory(summary.category)}
            size={38}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <InlineRevealText
              text={formatDisplayAppName(summary.appName)}
              style={{ fontSize: 27, fontWeight: 780, letterSpacing: '-0.03em', color: 'var(--color-text-primary)' }}
            />
            <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 4 }}>
              {activityCategoryLabel(summary.category)} · {rangeLabel}
            </div>
          </div>
          <button
            type="button"
            disabled={isGenerating}
            onClick={onGenerate}
            style={{
              padding: '7px 10px',
              borderRadius: 8,
              border: '1px solid var(--color-border-ghost)',
              background: 'var(--color-surface-low)',
              color: 'var(--color-text-secondary)',
              fontSize: 11.5,
              fontWeight: 700,
              cursor: isGenerating ? 'default' : 'pointer',
              opacity: isGenerating ? 0.6 : 1,
            }}
          >
            {isGenerating ? 'Generating…' : narrative ? 'Refresh' : 'Generate'}
          </button>
        </div>
        <p style={{ fontSize: 13.5, lineHeight: 1.7, color: 'var(--color-text-secondary)', margin: '14px 0 0' }}>
          {appMetricSentence(summary.totalSeconds, summary.sessionCount)}
        </p>
        {!narrative && !isGenerating && !generationStatus && (
          <p style={{ fontSize: 11.5, lineHeight: 1.6, color: 'var(--color-text-tertiary)', margin: '8px 0 0' }}>
            The sites, files, and pages below are computed from your activity. Press Generate for a written recap when the evidence can support one.
          </p>
        )}
        {narrativeError && !isGenerating && (
          <div style={{ fontSize: 11.5, color: '#f87171', marginTop: 10 }}>Could not load the saved narrative: {narrativeError}</div>
        )}
        {deleteError && (
          <div style={{ fontSize: 11.5, color: '#f87171', marginTop: 10 }}>Could not delete activity: {deleteError}</div>
        )}
        {isGenerating && (
          <div aria-live="polite" style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 10 }}>Generating a stronger app narrative…</div>
        )}
        {!isGenerating && generationStatus?.kind === 'thin' && (
          <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 10 }}>Daylens has only thin signal for this app right now — the breakdown below is the accurate account.</div>
        )}
        {!isGenerating && generationStatus?.kind === 'no-bundle' && (
          <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 10 }}>No recent activity for this app in the selected range.</div>
        )}
        {!isGenerating && generationStatus?.kind === 'error' && (
          <div style={{ fontSize: 11.5, color: '#f87171', marginTop: 10 }}>Could not generate narrative: {generationStatus.message}</div>
        )}
        {narrative?.stale && (
          <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 10 }}>Showing the last saved narrative while new activity settles.</div>
        )}
        <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 14, letterSpacing: '0.02em' }}>
          {formatDuration(summary.totalSeconds)}
          {summary.sessionCount ? ` · ${summary.sessionCount} session${summary.sessionCount === 1 ? '' : 's'}` : ''}
        </div>
      </div>

      {detailError && <div style={{ color: '#f87171', fontSize: 13 }}>Could not load app detail: {detailError}</div>}

      {!detail && !detailError && (
        <div style={{ display: 'grid', gap: 10 }} aria-label="Loading app detail">
          {[80, 64, 72].map((width) => (
            <div key={width} style={{ height: 56, borderRadius: 14, background: 'var(--color-surface)', border: '1px solid var(--color-border-ghost)', opacity: 0.55, width: `${width}%` }} />
          ))}
        </div>
      )}

      {detail && showWhatYouDid && (
        <section style={{ borderRadius: 18, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', padding: '18px 20px' }}>
          <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 12 }}>
            What you did there
          </div>
          {account && (
            <p style={{ fontSize: 13.5, lineHeight: 1.7, color: 'var(--color-text-secondary)', margin: '0 0 14px' }}>
              {account}
            </p>
          )}
          {breakdown && (
            <ActivityBreakdown
              key={`${detail.canonicalAppId}:${detail.rangeKey}`}
              activity={breakdown}
              deletingActivityKey={deletingActivityKey}
              onDelete={onDeleteWebsiteActivity}
            />
          )}
        </section>
      )}

      {detail && relatedBlocks.length > 0 && (
        <ActivityListCard
          title="Related timeline"
          rows={relatedBlocks.slice(0, 10).map((block) => ({
            id: block.blockId,
            label: block.label,
            detail: formatBlockRange(block.startTime, block.endTime),
            onClick: () => { window.location.hash = `#/timeline?view=day&date=${localDateStringFromMs(block.startTime)}` },
          }))}
        />
      )}
    </div>
  )
}
