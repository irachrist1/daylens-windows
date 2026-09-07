import { useMemo, useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { AppActivityBreakdown, AppActivityGroup, AppActivityItem } from '@shared/types'
import { MIN_DOMAIN_ROW_SECONDS } from '@shared/types'
import { partitionDomainsWorkFirst } from '@shared/workKind'
import EntityIcon from '../../components/EntityIcon'
import EvidenceIdentity from '../../components/EvidenceIdentity'
import InlineRevealText from '../../components/InlineRevealText'
import { formatDuration } from '../../lib/format'
import { openArtifact } from '../../lib/openTarget'
import type { WebsiteActivityTarget } from './BrowserActivityBreakdown'

const PAGE_WINDOW = 40

function DeleteIconButton({ label, busy, onClick }: { label: string; busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={busy}
      onClick={onClick}
      style={{
        width: 30,
        height: 30,
        borderRadius: 8,
        border: '1px solid rgba(248, 113, 113, 0.28)',
        background: busy ? 'rgba(248, 113, 113, 0.12)' : 'transparent',
        color: '#ef4444',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: busy ? 'default' : 'pointer',
        opacity: busy ? 0.55 : 0.82,
        flexShrink: 0,
      }}
    >
      <Trash2 size={14} strokeWidth={1.9} aria-hidden="true" />
    </button>
  )
}

function itemDeleteTarget(item: AppActivityItem): WebsiteActivityTarget | null {
  const domain = item.domain ?? item.host
  if (!domain) return null
  return {
    domain,
    url: item.url,
    normalizedUrl: item.normalizedUrl,
    pageKey: item.pageKey,
    title: item.displayTitle,
  }
}

function groupDeleteTarget(group: AppActivityGroup): WebsiteActivityTarget | null {
  if (group.kind !== 'domain') return null
  return { domain: group.label, title: group.label }
}

export default function ActivityBreakdown({
  activity,
  deletingActivityKey,
  onDelete,
}: {
  activity: AppActivityBreakdown
  deletingActivityKey: string | null
  onDelete: (target: WebsiteActivityTarget) => void
}) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set())
  const [pageLimits, setPageLimits] = useState<Record<string, number>>({})
  const groupSplit = useMemo(
    () => partitionDomainsWorkFirst(activity.groups, (entry) => (
      entry.kind === 'domain' ? entry.label : null
    ), (entry) => entry.totalSeconds),
    [activity.groups],
  )

  const toggleGroup = (id: string) => {
    setExpandedGroups((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const renderItemRow = (item: AppActivityItem, groupKind: AppActivityGroup['kind']) => {
    const deleteTarget = itemDeleteTarget(item)
    return (
      <div key={item.id} style={{ display: 'flex', alignItems: 'start', gap: 10, width: '100%' }}>
        <button
          type="button"
          onClick={() => void openArtifact(item)}
          disabled={item.openTarget.kind === 'unsupported' || !item.openTarget.value}
          style={{
            display: 'flex',
            alignItems: 'start',
            gap: 10,
            flex: 1,
            minWidth: 0,
            padding: 0,
            border: 'none',
            background: 'transparent',
            textAlign: 'left',
            cursor: item.openTarget.kind === 'unsupported' || !item.openTarget.value ? 'default' : 'pointer',
          }}
        >
          <EvidenceIdentity
            icon={(
              <EntityIcon
                artifactType={item.artifactType ?? 'document'}
                canonicalAppId={item.canonicalAppId}
                ownerBundleId={item.ownerBundleId}
                ownerAppName={item.ownerAppName}
                title={item.displayTitle}
                path={item.path}
                domain={item.domain ?? item.host}
                url={item.url}
                size={28}
              />
            )}
            title={item.displayTitle}
            titleStyle={{ fontSize: 13.5, fontWeight: 620 }}
            detail={<>
              {item.detail && (
                <InlineRevealText text={item.detail} style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }} />
              )}
              {groupKind === 'domain' && item.visitCount != null && (
                <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                  {item.visitCount} visit{item.visitCount === 1 ? '' : 's'}
                </div>
              )}
            </>}
          />
        </button>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
          {formatDuration(item.totalSeconds)}
        </div>
        {deleteTarget && (
          <DeleteIconButton
            label={`Delete activity for ${item.displayTitle}`}
            busy={deletingActivityKey === (
              item.url || item.normalizedUrl || item.pageKey
                ? `url:${item.normalizedUrl ?? item.url ?? item.pageKey}`
                : `domain:${deleteTarget.domain}`
            )}
            onClick={() => onDelete(deleteTarget)}
          />
        )}
      </div>
    )
  }

  const renderGroup = (entry: AppActivityGroup) => {
    const expanded = expandedGroups.has(entry.id)
    const deleteTarget = groupDeleteTarget(entry)
    return (
      <div key={entry.id}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            type="button"
            onClick={() => toggleGroup(entry.id)}
            aria-expanded={expanded}
            style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0, padding: 0, border: 'none', background: 'transparent', textAlign: 'left', cursor: 'pointer' }}
          >
            <span aria-hidden="true" style={{ display: 'inline-flex', width: 10, justifyContent: 'center', color: 'var(--color-text-tertiary)', fontSize: 9, transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease' }}>
              ▶
            </span>
            <EntityIcon artifactType={entry.kind === 'domain' ? 'page' : 'document'} domain={entry.kind === 'domain' ? entry.label : undefined} size={26} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <InlineRevealText text={entry.label} style={{ fontSize: 13, fontWeight: 620, color: 'var(--color-text-primary)' }} />
              <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                {entry.kind === 'domain' && entry.visitCount != null
                  ? `${entry.visitCount} visit${entry.visitCount === 1 ? '' : 's'} · ${entry.itemCount} page${entry.itemCount === 1 ? '' : 's'}`
                  : `${entry.itemCount} item${entry.itemCount === 1 ? '' : 's'}`}
              </div>
            </div>
          </button>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
            {formatDuration(entry.totalSeconds)}
          </div>
          {deleteTarget && (
            <DeleteIconButton
              label={`Delete activity for ${entry.label}`}
              busy={deletingActivityKey === `domain:${deleteTarget.domain}`}
              onClick={() => onDelete(deleteTarget)}
            />
          )}
        </div>
        {expanded && entry.items.length > 0 && (
          <div style={{ display: 'grid', gap: 12, margin: '10px 0 4px', paddingLeft: 20, borderLeft: '2px solid var(--color-border-ghost)', marginLeft: 4 }}>
            {entry.items.slice(0, pageLimits[entry.id] ?? PAGE_WINDOW).map((item) => renderItemRow(item, entry.kind))}
            {entry.items.length > (pageLimits[entry.id] ?? PAGE_WINDOW) && (
              <button
                type="button"
                onClick={() => setPageLimits((limits) => ({
                  ...limits,
                  [entry.id]: (limits[entry.id] ?? PAGE_WINDOW) + PAGE_WINDOW,
                }))}
                style={{ justifySelf: 'start', padding: '4px 10px', borderRadius: 8, border: '1px solid var(--color-border-ghost)', background: 'transparent', color: 'var(--color-text-secondary)', fontSize: 12, cursor: 'pointer' }}
              >
                Show {Math.min(PAGE_WINDOW, entry.items.length - (pageLimits[entry.id] ?? PAGE_WINDOW))} more of {entry.items.length} {entry.kind === 'domain' ? 'pages' : 'items'}
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  const everythingElse = activity.everythingElse

  if (groupSplit.work.length === 0 && groupSplit.leisure.length === 0
    && !everythingElse && activity.unattributedSeconds <= 0) return null

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'grid', gap: 10 }}>{groupSplit.work.map(renderGroup)}</div>
      {groupSplit.leisure.length > 0 && (
        <>
          {groupSplit.work.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0', color: 'var(--color-text-tertiary)' }}>
              <div style={{ flex: 1, height: 1, background: 'var(--color-border-ghost)' }} />
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Off to the side</span>
              <div style={{ flex: 1, height: 1, background: 'var(--color-border-ghost)' }} />
            </div>
          )}
          <div style={{ display: 'grid', gap: 10 }}>{groupSplit.leisure.map(renderGroup)}</div>
        </>
      )}
      {everythingElse && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: (groupSplit.work.length > 0 || groupSplit.leisure.length > 0) ? 2 : 0 }}>
          <span aria-hidden="true" style={{ width: 10 }} />
          <span aria-hidden="true" style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--color-surface-high)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>+</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 620, color: 'var(--color-text-secondary)' }}>Everything else</div>
            <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
              {everythingElse.groupCount} group{everythingElse.groupCount === 1 ? '' : 's'} under {MIN_DOMAIN_ROW_SECONDS} seconds each
            </div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
            {formatDuration(everythingElse.totalSeconds)}
          </div>
        </div>
      )}
      {activity.unattributedSeconds > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: (groupSplit.work.length > 0 || groupSplit.leisure.length > 0) ? 2 : 0, opacity: 0.75 }}>
          <span aria-hidden="true" style={{ width: 10 }} />
          <span aria-hidden="true" style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--color-surface-high)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>—</span>
          <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--color-text-tertiary)' }}>No page recorded</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>{formatDuration(activity.unattributedSeconds)}</div>
        </div>
      )}
    </div>
  )
}
