// Settings → Entities: fix identity (rename / merge duplicates). Default view
// is “Needs attention” — same-name pairs like Canva/Canva — not a dump of
// every observed thing. Browse is opt-in and capped so the page stays fast.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ipc } from '../../lib/ipc'

type EntityType =
  | 'application' | 'page' | 'file' | 'person' | 'meeting' | 'repository'
  | 'project' | 'client' | 'timeline_block' | 'ai_thread'

interface EntitySummary {
  id: string
  type: EntityType
  name: string
  nameSource: 'inferred' | 'user'
  origin: string
  sensitivity: string
  status: string
  firstObservedAt: number | null
  lastObservedAt: number | null
  aliases: string[]
  evidenceCount: number
}

interface EntityDetail extends EntitySummary {
  aliasRows: Array<{ id: string; entity_id: string; alias: string; raw_label: string | null; source: string }>
  evidenceRefs: Array<{ id: string; source_type: string; source_id: string; span_start_ms: number | null; span_end_ms: number | null }>
  related: Array<{ id: string; name: string; type: EntityType; kind: string }>
  mergedEntities: Array<{ id: string; name: string }>
  blockRefs: Array<{ blockId: string | null; degraded: boolean; spanStartMs: number | null; spanEndMs: number | null }>
}

interface SuggestedMerge {
  type: EntityType
  leftId: string
  leftName: string
  rightId: string
  rightName: string
  reason: string
}

interface MergePreview {
  description: string
  entity: { id: string; name: string; aliases: string[]; evidenceCount: number } | null
  surfaces: string[]
}

type ViewMode = 'attention' | 'browse'

const TYPE_TABS: Array<{ id: EntityType | null; label: string }> = [
  { id: 'application', label: 'Apps' },
  { id: 'project', label: 'Projects' },
  { id: 'client', label: 'Clients' },
  { id: 'person', label: 'People' },
  { id: 'repository', label: 'Repos' },
  { id: 'page', label: 'Pages' },
  { id: 'file', label: 'Files' },
  { id: 'meeting', label: 'Meetings' },
  { id: null, label: 'All' },
]

const LIST_LIMIT = 40

const buttonStyle: React.CSSProperties = {
  fontSize: 12.5,
  padding: '6px 12px',
  borderRadius: 9,
  border: '1px solid var(--color-border-ghost)',
  background: 'var(--color-surface-low)',
  color: 'var(--color-text-primary)',
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: 'var(--gradient-primary)',
  color: 'var(--color-primary-contrast)',
  border: 'none',
  fontWeight: 620,
}

const quietButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: 'transparent',
}

export function EntityMemorySection() {
  const [view, setView] = useState<ViewMode>('attention')
  const [typeFilter, setTypeFilter] = useState<EntityType | null>('application')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [entities, setEntities] = useState<EntitySummary[]>([])
  const [loaded, setLoaded] = useState(false)
  const [suggestionsLoaded, setSuggestionsLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [detail, setDetail] = useState<EntityDetail | null>(null)
  const [suggestions, setSuggestions] = useState<SuggestedMerge[]>([])
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(new Set())
  const [mergePreview, setMergePreview] = useState<{ preview: MergePreview; targetId: string; sourceId: string } | null>(null)
  const [undoToast, setUndoToast] = useState<{ correctionId: string; description: string } | null>(null)
  const [newProjectName, setNewProjectName] = useState('')
  const [addingProject, setAddingProject] = useState(false)
  const [aliasDraft, setAliasDraft] = useState('')
  const [reviewingKey, setReviewingKey] = useState<string | null>(null)

  const [bulkBusy, setBulkBusy] = useState(false)

  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedSearch(search), 200)
    return () => window.clearTimeout(handle)
  }, [search])

  const reloadSuggestions = useCallback(async () => {
    try {
      const rows = await ipc.entities.suggestedMerges()
      setSuggestions(rows as SuggestedMerge[])
      setError(null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setSuggestionsLoaded(true)
    }
  }, [])

  const reloadBrowse = useCallback(async () => {
    try {
      const rows = await ipc.entities.list({
        type: typeFilter,
        search: debouncedSearch || null,
        limit: LIST_LIMIT,
      })
      setEntities(rows as EntitySummary[])
      setError(null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoaded(true)
    }
  }, [typeFilter, debouncedSearch])

  useEffect(() => {
    if (view === 'attention') void reloadSuggestions()
  }, [view, reloadSuggestions])

  useEffect(() => {
    if (view === 'browse') void reloadBrowse()
  }, [view, reloadBrowse])

  const openDetail = useCallback(async (entityId: string) => {
    try {
      const row = await ipc.entities.detail(entityId)
      setDetail(row as EntityDetail | null)
      setAliasDraft('')
    } catch { /* detail failures leave the browser usable */ }
  }, [])

  async function applyAndToast(command: unknown, options: { reload?: boolean } = {}) {
    const shouldReload = options.reload !== false
    const result = await ipc.entities.applyCorrection(command) as { correctionId: string; description: string }
    setUndoToast(result)
    if (shouldReload) {
      if (view === 'browse') await reloadBrowse()
      await reloadSuggestions()
      if (detail) await openDetail(detail.id)
    }
    return result
  }

  async function mergePair(targetId: string, sourceId: string) {
    const key = `${targetId}:${sourceId}`
    setReviewingKey(key)
    setError(null)
    try {
      await applyAndToast({ kind: 'entity-merge', targetId, sourceId })
      setMergePreview(null)
      setSelected([])
    } catch (mergeError) {
      setError(mergeError instanceof Error ? mergeError.message : 'Couldn’t merge those. Try again.')
    } finally {
      setReviewingKey(null)
    }
  }

  // Browse "Merge selected" — confirm bar at the top of the page.
  async function startMergePreview(targetId: string, sourceId: string) {
    const key = `${targetId}:${sourceId}`
    setReviewingKey(key)
    setError(null)
    try {
      const preview = await ipc.entities.previewCorrection({ kind: 'entity-merge', targetId, sourceId }) as MergePreview
      setMergePreview({ preview, targetId, sourceId })
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : 'Couldn’t prepare that merge. Try again.')
    } finally {
      setReviewingKey(null)
    }
  }

  const visibleSuggestions = useMemo(
    () => suggestions.filter((item) => !dismissedSuggestions.has(`${item.leftId}:${item.rightId}`)),
    [suggestions, dismissedSuggestions],
  )

  // One IPC call: the main process merges every genuine duplicate to fixpoint
  // and reports only merges that actually happened (DEV-257). Pairs the user
  // dismissed as "Not the same" are passed along so they stay unmerged.
  async function mergeAllVisible() {
    if (visibleSuggestions.length === 0 || bulkBusy) return
    setBulkBusy(true)
    setError(null)
    try {
      const excludedPairs = [...dismissedSuggestions].map((key) => {
        const [leftId = '', rightId = ''] = key.split(':')
        return { leftId, rightId }
      })
      const result = await ipc.entities.mergeAllDuplicates({ excludedPairs }) as {
        merged: number
        failed: number
        lastCorrectionId: string | null
        lastDescription: string | null
      }
      if (result.lastCorrectionId) {
        setUndoToast({
          correctionId: result.lastCorrectionId,
          description: result.failed > 0
            ? `Merged ${result.merged} duplicate${result.merged === 1 ? '' : 's'} (${result.failed} skipped). Undo reverses the last one.`
            : `Merged ${result.merged} duplicate${result.merged === 1 ? '' : 's'}. Undo reverses the last one.`,
        })
      } else if (result.failed > 0) {
        setError(`Couldn’t merge ${result.failed} pair${result.failed === 1 ? '' : 's'}. Try again.`)
      }
    } catch (mergeError) {
      setError(mergeError instanceof Error ? mergeError.message : 'Couldn’t merge those. Try again.')
    } finally {
      setBulkBusy(false)
      await reloadSuggestions()
      if (view === 'browse') await reloadBrowse()
    }
  }

  const selectedEntities = entities.filter((entity) => selected.includes(entity.id))
  const canMerge = selectedEntities.length === 2 && selectedEntities[0]?.type === selectedEntities[1]?.type

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {undoToast && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 12,
          border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface-low)', fontSize: 12.5,
        }}>
          <span style={{ color: 'var(--color-text-secondary)' }}>{undoToast.description}</span>
          <button
            type="button"
            style={{ ...quietButtonStyle, marginLeft: 'auto' }}
            onClick={async () => {
              try {
                await ipc.entities.undoCorrection(undoToast.correctionId)
                setUndoToast(null)
                if (view === 'browse') await reloadBrowse()
                await reloadSuggestions()
                if (detail) await openDetail(detail.id)
              } catch (undoError) {
                setError(undoError instanceof Error ? undoError.message : String(undoError))
              }
            }}
          >
            Undo
          </button>
          <button type="button" style={quietButtonStyle} onClick={() => setUndoToast(null)}>Dismiss</button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={() => setView('attention')}
          style={view === 'attention' ? primaryButtonStyle : buttonStyle}
        >
          Needs attention
          {suggestionsLoaded && visibleSuggestions.length > 0 ? ` · ${visibleSuggestions.length}` : ''}
        </button>
        <button
          type="button"
          onClick={() => { setView('browse'); setLoaded(false) }}
          style={view === 'browse' ? primaryButtonStyle : buttonStyle}
        >
          Browse
        </button>
      </div>

      {error && <div style={{ fontSize: 12.5, color: '#f87171' }}>{error}</div>}

      {mergePreview && (
        <div style={{ display: 'grid', gap: 10, padding: 14, borderRadius: 12, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface-low)' }}>
          <div style={{ fontSize: 13.5, fontWeight: 660 }}>{mergePreview.preview.description}</div>
          {mergePreview.preview.entity && (
            <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
              Keeps “{mergePreview.preview.entity.name}” with {mergePreview.preview.entity.evidenceCount} linked item{mergePreview.preview.entity.evidenceCount === 1 ? '' : 's'}.
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={reviewingKey !== null}
              onClick={() => void mergePair(mergePreview.targetId, mergePreview.sourceId)}
            >
              Confirm merge
            </button>
            <button type="button" style={quietButtonStyle} onClick={() => setMergePreview(null)}>Cancel</button>
          </div>
        </div>
      )}

      {view === 'attention' && (
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.55, flex: 1, minWidth: 200 }}>
              Same name twice usually means Daylens minted two records for one real thing.
              Merge them here — you can undo the last merge.
            </div>
            {visibleSuggestions.length > 1 && (
              <button
                type="button"
                style={primaryButtonStyle}
                disabled={bulkBusy || reviewingKey !== null}
                onClick={() => void mergeAllVisible()}
              >
                {bulkBusy ? 'Merging…' : `Merge all ${visibleSuggestions.length}`}
              </button>
            )}
          </div>
          {!suggestionsLoaded ? (
            <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>Checking for duplicates…</div>
          ) : visibleSuggestions.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.55 }}>
              Nothing needs a merge right now. Use Browse if you want to rename something.
            </div>
          ) : (
            visibleSuggestions.map((item) => (
              <div
                key={`${item.leftId}:${item.rightId}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '12px 14px',
                  borderRadius: 12,
                  border: '1px solid var(--color-border-ghost)',
                  background: 'var(--color-surface-low)',
                  fontSize: 13,
                }}
              >
                <div style={{ display: 'grid', gap: 2, minWidth: 0, flex: 1 }}>
                  <span style={{ fontWeight: 620, color: 'var(--color-text-primary)' }}>
                    “{item.leftName}” and “{item.rightName}”
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                    {item.type} · {item.reason}
                  </span>
                </div>
                <button
                  type="button"
                  style={primaryButtonStyle}
                  disabled={reviewingKey !== null || bulkBusy}
                  onClick={() => void mergePair(item.leftId, item.rightId)}
                >
                  {reviewingKey === `${item.leftId}:${item.rightId}` ? 'Merging…' : 'Merge'}
                </button>
                <button
                  type="button"
                  style={quietButtonStyle}
                  disabled={bulkBusy}
                  onClick={() => setDismissedSuggestions((current) => new Set([...current, `${item.leftId}:${item.rightId}`]))}
                >
                  Not the same
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {view === 'browse' && (
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {TYPE_TABS.map((tab) => (
              <button
                key={tab.label}
                type="button"
                onClick={() => { setTypeFilter(tab.id); setSelected([]); setLoaded(false) }}
                style={typeFilter === tab.id ? primaryButtonStyle : buttonStyle}
              >
                {tab.label}
              </button>
            ))}
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search…"
              style={{
                marginLeft: 'auto',
                fontSize: 12.5,
                padding: '6px 12px',
                borderRadius: 9,
                border: '1px solid var(--color-border-ghost)',
                background: 'var(--color-surface-high)',
                color: 'var(--color-text-primary)',
                fontFamily: 'inherit',
                minWidth: 160,
              }}
            />
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              type="button"
              style={canMerge ? primaryButtonStyle : { ...buttonStyle, opacity: 0.5, cursor: 'default' }}
              disabled={!canMerge}
              onClick={() => { if (canMerge) void startMergePreview(selected[0]!, selected[1]!) }}
            >
              Merge selected
            </button>
            {(typeFilter === 'project' || typeFilter === null) && (
              addingProject ? (
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  <input
                    value={newProjectName}
                    onChange={(event) => setNewProjectName(event.target.value)}
                    placeholder="Project name"
                    style={{
                      fontSize: 12.5, padding: '6px 10px', borderRadius: 9,
                      border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface-high)',
                      color: 'var(--color-text-primary)', fontFamily: 'inherit',
                    }}
                  />
                  <button
                    type="button"
                    style={primaryButtonStyle}
                    onClick={async () => {
                      try {
                        await ipc.entities.createProject({ name: newProjectName })
                        setNewProjectName('')
                        setAddingProject(false)
                        await reloadBrowse()
                      } catch (createError) {
                        setError(createError instanceof Error ? createError.message : String(createError))
                      }
                    }}
                  >
                    Create
                  </button>
                  <button type="button" style={quietButtonStyle} onClick={() => setAddingProject(false)}>Cancel</button>
                </span>
              ) : (
                <button type="button" style={{ ...quietButtonStyle, marginLeft: 'auto' }} onClick={() => setAddingProject(true)}>
                  New project
                </button>
              )
            )}
          </div>

          {!loaded ? (
            <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>Loading…</div>
          ) : entities.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.55 }}>
              Nothing here yet.
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 6 }}>
              {entities.map((entity) => (
                <div
                  key={entity.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px',
                    borderRadius: 12,
                    border: '1px solid var(--color-border-ghost)',
                    background: detail?.id === entity.id ? 'var(--color-surface-low)' : 'transparent',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(entity.id)}
                    onChange={(event) => setSelected((current) => event.target.checked
                      ? [...current, entity.id].slice(-2)
                      : current.filter((id) => id !== entity.id))}
                  />
                  {renamingId === entity.id ? (
                    <span style={{ display: 'flex', gap: 6, flex: 1 }}>
                      <input
                        value={renameValue}
                        autoFocus
                        onChange={(event) => setRenameValue(event.target.value)}
                        style={{
                          flex: 1, fontSize: 13, padding: '4px 8px', borderRadius: 8,
                          border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface-high)',
                          color: 'var(--color-text-primary)', fontFamily: 'inherit',
                        }}
                      />
                      <button
                        type="button"
                        style={primaryButtonStyle}
                        onClick={async () => {
                          try {
                            await applyAndToast({ kind: 'entity-rename', entityId: entity.id, name: renameValue })
                            setRenamingId(null)
                          } catch (renameError) {
                            setError(renameError instanceof Error ? renameError.message : String(renameError))
                          }
                        }}
                      >
                        Save
                      </button>
                      <button type="button" style={quietButtonStyle} onClick={() => setRenamingId(null)}>Cancel</button>
                    </span>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => void openDetail(entity.id)}
                        style={{
                          background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                          fontSize: 13.5, fontWeight: 600, color: 'var(--color-text-primary)', textAlign: 'left',
                        }}
                      >
                        {entity.name}
                      </button>
                      <span style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>{entity.type}</span>
                      <button
                        type="button"
                        style={{ ...quietButtonStyle, marginLeft: 'auto' }}
                        onClick={() => { setRenamingId(entity.id); setRenameValue(entity.name) }}
                      >
                        Rename
                      </button>
                    </>
                  )}
                </div>
              ))}
              {entities.length >= LIST_LIMIT && (
                <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                  Showing the first {LIST_LIMIT}. Search to narrow.
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {detail && (
        <div style={{ display: 'grid', gap: 10, padding: 14, borderRadius: 12, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface-low)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 660 }}>{detail.name}</span>
            <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{detail.type}</span>
            <button type="button" style={{ ...quietButtonStyle, marginLeft: 'auto' }} onClick={() => setDetail(null)}>Close</button>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {detail.aliasRows.map((alias) => (
              <span key={alias.id} style={{ fontSize: 12, color: 'var(--color-text-secondary)', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                {alias.alias}
                <button
                  type="button"
                  style={{ ...quietButtonStyle, padding: '2px 6px' }}
                  onClick={() => void applyAndToast({ kind: 'entity-remove-alias', entityId: detail.id, aliasId: alias.id }).catch((err) => setError(String(err)))}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              value={aliasDraft}
              onChange={(event) => setAliasDraft(event.target.value)}
              placeholder="Add alias…"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && aliasDraft.trim()) {
                  void applyAndToast({ kind: 'entity-add-alias', entityId: detail.id, alias: aliasDraft.trim() })
                    .then(() => setAliasDraft(''))
                    .catch((err) => setError(String(err)))
                }
              }}
              style={{
                fontSize: 12.5, padding: '4px 8px', borderRadius: 8, minWidth: 120,
                border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface-high)',
                color: 'var(--color-text-primary)', fontFamily: 'inherit',
              }}
            />
          </div>
          {detail.mergedEntities.length > 0 && (
            <div style={{ fontSize: 12.5, display: 'grid', gap: 4 }}>
              <span style={{ color: 'var(--color-text-tertiary)' }}>Merged into this:</span>
              {detail.mergedEntities.map((merged) => (
                <span key={merged.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  “{merged.name}”
                  <button
                    type="button"
                    style={quietButtonStyle}
                    onClick={() => void applyAndToast({ kind: 'entity-split', entityId: merged.id }).catch((err) => setError(String(err)))}
                  >
                    Split back out
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
