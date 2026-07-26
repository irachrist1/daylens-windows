import { useMemo, useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { AppDetailPayload, PageRef } from '@shared/types'
import { partitionDomainsWorkFirst } from '@shared/workKind'
import EntityIcon from '../../components/EntityIcon'
import EvidenceIdentity from '../../components/EvidenceIdentity'
import InlineRevealText from '../../components/InlineRevealText'
import { formatDuration } from '../../lib/format'
import { openArtifact } from '../../lib/openTarget'

export interface WebsiteActivityTarget {
  domain: string
  url?: string | null
  normalizedUrl?: string | null
  pageKey?: string | null
  title?: string | null
}

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

export default function BrowserActivityBreakdown({
  activity,
  deletingActivityKey,
  onDelete,
}: {
  activity: NonNullable<AppDetailPayload['browserActivity']>
  deletingActivityKey: string | null
  onDelete: (target: WebsiteActivityTarget) => void
}) {
  const [expandedDomains, setExpandedDomains] = useState<Set<string>>(() => new Set())
  // DEV-227: a domain can accumulate hundreds of pages over 30 days; drawing
  // them all at once stutters the panel. Render a page window per domain and
  // grow it on demand.
  const [pageLimits, setPageLimits] = useState<Record<string, number>>({})
  const domainSplit = useMemo(
    () => partitionDomainsWorkFirst(activity.domains, (entry) => entry.domain),
    [activity.domains],
  )

  const toggleDomain = (domain: string) => {
    setExpandedDomains((previous) => {
      const next = new Set(previous)
      if (next.has(domain)) next.delete(domain)
      else next.add(domain)
      return next
    })
  }

  const renderPageRow = (page: PageRef) => (
    <div key={page.id} style={{ display: 'flex', alignItems: 'start', gap: 10, width: '100%' }}>
      <button
        type="button"
        onClick={() => void openArtifact(page)}
        disabled={page.openTarget.kind === 'unsupported' || !page.openTarget.value}
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
          cursor: page.openTarget.kind === 'unsupported' || !page.openTarget.value ? 'default' : 'pointer',
        }}
      >
        <EvidenceIdentity
          icon={<EntityIcon artifactType="page" domain={page.domain} url={page.url} size={28} />}
          title={page.displayTitle}
          titleStyle={{ fontSize: 13.5, fontWeight: 620 }}
          detail={<>
            <InlineRevealText text={page.domain} style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }} />
            <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
              {page.visitCount ?? 1} visit{(page.visitCount ?? 1) === 1 ? '' : 's'}
            </div>
          </>}
        />
      </button>
      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
        {formatDuration(page.totalSeconds)}
      </div>
      <DeleteIconButton
        label={`Delete activity for ${page.displayTitle}`}
        busy={deletingActivityKey === (
          page.url || page.normalizedUrl || page.pageKey
            ? `url:${page.normalizedUrl ?? page.url ?? page.pageKey}`
            : `domain:${page.domain}`
        )}
        onClick={() => onDelete({
          domain: page.domain,
          url: page.url,
          normalizedUrl: page.normalizedUrl,
          pageKey: page.pageKey,
          title: page.displayTitle,
        })}
      />
    </div>
  )

  const renderDomainGroup = (entry: typeof activity.domains[number]) => {
    const expanded = expandedDomains.has(entry.domain)
    return (
      <div key={entry.domain}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            type="button"
            onClick={() => toggleDomain(entry.domain)}
            aria-expanded={expanded}
            style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0, padding: 0, border: 'none', background: 'transparent', textAlign: 'left', cursor: 'pointer' }}
          >
            <span aria-hidden="true" style={{ display: 'inline-flex', width: 10, justifyContent: 'center', color: 'var(--color-text-tertiary)', fontSize: 9, transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease' }}>
              ▶
            </span>
            <EntityIcon artifactType="page" domain={entry.domain} size={26} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <InlineRevealText text={entry.domain} style={{ fontSize: 13, fontWeight: 620, color: 'var(--color-text-primary)' }} />
              <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                {entry.visitCount} visit{entry.visitCount === 1 ? '' : 's'} · {entry.pages.length} page{entry.pages.length === 1 ? '' : 's'}
              </div>
            </div>
          </button>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
            {formatDuration(entry.totalSeconds)}
          </div>
          <DeleteIconButton
            label={`Delete activity for ${entry.domain}`}
            busy={deletingActivityKey === `domain:${entry.domain}`}
            onClick={() => onDelete({ domain: entry.domain, title: entry.domain })}
          />
        </div>
        {expanded && entry.pages.length > 0 && (
          <div style={{ display: 'grid', gap: 12, margin: '10px 0 4px', paddingLeft: 20, borderLeft: '2px solid var(--color-border-ghost)', marginLeft: 4 }}>
            {entry.pages.slice(0, pageLimits[entry.domain] ?? PAGE_WINDOW).map(renderPageRow)}
            {entry.pages.length > (pageLimits[entry.domain] ?? PAGE_WINDOW) && (
              <button
                type="button"
                onClick={() => setPageLimits((limits) => ({
                  ...limits,
                  [entry.domain]: (limits[entry.domain] ?? PAGE_WINDOW) + PAGE_WINDOW,
                }))}
                style={{ justifySelf: 'start', padding: '4px 10px', borderRadius: 8, border: '1px solid var(--color-border-ghost)', background: 'transparent', color: 'var(--color-text-secondary)', fontSize: 12, cursor: 'pointer' }}
              >
                Show {Math.min(PAGE_WINDOW, entry.pages.length - (pageLimits[entry.domain] ?? PAGE_WINDOW))} more of {entry.pages.length} pages
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  if (domainSplit.work.length === 0 && domainSplit.leisure.length === 0 && activity.unattributedSeconds <= 0) return null

  return (
    <section style={{ borderRadius: 18, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', padding: '18px 20px' }}>
      <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 12 }}>
        Where your {formatDuration(activity.totalSeconds)} went
      </div>
      <div style={{ display: 'grid', gap: 10 }}>{domainSplit.work.map(renderDomainGroup)}</div>
      {domainSplit.leisure.length > 0 && (
        <>
          {domainSplit.work.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '14px 0 10px', color: 'var(--color-text-tertiary)' }}>
              <div style={{ flex: 1, height: 1, background: 'var(--color-border-ghost)' }} />
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Off to the side</span>
              <div style={{ flex: 1, height: 1, background: 'var(--color-border-ghost)' }} />
            </div>
          )}
          <div style={{ display: 'grid', gap: 10 }}>{domainSplit.leisure.map(renderDomainGroup)}</div>
        </>
      )}
      {activity.unattributedSeconds > 0 && (
        <div style={{ marginTop: (domainSplit.work.length > 0 || domainSplit.leisure.length > 0) ? 12 : 0, opacity: 0.75 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span aria-hidden="true" style={{ width: 10 }} />
            <span aria-hidden="true" style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--color-surface-high)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>—</span>
            <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--color-text-tertiary)' }}>No page recorded</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>{formatDuration(activity.unattributedSeconds)}</div>
          </div>
          {activity.coverageNote && (
            <div style={{ marginLeft: 46, marginTop: 4, fontSize: 11.5, lineHeight: 1.55, color: 'var(--color-text-tertiary)' }}>
              {activity.coverageNote}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
