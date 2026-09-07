import type { ForwardedRef } from 'react'
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { ipc } from '../../lib/ipc'
import { IconSend, IconStop } from './icons'
import { buildMentionChipElement, MentionRowIcon, type MentionItem, type MentionKind } from './mentions'

export interface AIComposeHandle {
  focus: () => void
  setValue: (text: string) => void
}

interface AIComposeProps {
  onSubmit: (text: string) => boolean
  loading: boolean
  // While loading, the send button becomes Stop and calls this — it aborts
  // the in-flight provider request, not just the spinner.
  onCancel?: () => void
  // DEV-200: pause the in-flight turn as a resumable checkpoint (surviving
  // restart) — shown next to Stop while a turn runs. Distinct from Stop,
  // which discards the turn.
  onPause?: () => void
  placeholder?: string
  initialValue?: string
  onValueChange?: (text: string) => void
  variant?: 'docked' | 'starter'
}

// Composer affordances — `/` commands and `@` entity mentions. Mentions
// insert as inline icon chips (contenteditable), like Notion/Raycast.
type SlashCommand = { id: string; label: string; hint: string; prompt: string }
const SLASH_COMMANDS: SlashCommand[] = [
  { id: 'today', label: '/today', hint: 'What I worked on today', prompt: 'What did I work on today?' },
  { id: 'week', label: '/week', hint: 'Summarise the last 7 days by project', prompt: 'Summarize my last 7 days by project.' },
  { id: 'focus', label: '/focus', hint: 'When I was most focused this week', prompt: 'When was I most focused this week?' },
  { id: 'report', label: '/report', hint: 'A weekly report to share', prompt: 'Generate a weekly report I can share with my manager.' },
  { id: 'export', label: '/export', hint: "Export today's sessions as CSV", prompt: "Export today's work sessions as CSV." },
]

const DAY_MENTIONS: { label: string; insert: string }[] = [
  { label: 'today', insert: 'today' },
  { label: 'yesterday', insert: 'yesterday' },
  { label: 'this week', insert: 'this week' },
  { label: 'last 7 days', insert: 'the last 7 days' },
  { label: 'last 30 days', insert: 'the last 30 days' },
]

type MenuState = { kind: 'slash' | 'at'; query: string }

// Serialize the contenteditable to the plain message string: text as-is, mention
// chips as their stored insert value, <br>/<div> as newlines.
function serializeEditor(el: HTMLElement): string {
  let out = ''
  const walk = (parent: Node) => {
    parent.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.textContent ?? ''
      } else if (node instanceof HTMLElement) {
        if (node.dataset.mentionInsert != null) out += node.dataset.mentionInsert
        else if (node.tagName === 'BR') out += '\n'
        else {
          if (node.tagName === 'DIV' && out && !out.endsWith('\n')) out += '\n'
          walk(node)
        }
      }
    })
  }
  walk(el)
  return out
}

function AIComposeImpl(
  { onSubmit, loading, onCancel, onPause, placeholder, initialValue = '', onValueChange, variant = 'docked' }: AIComposeProps,
  ref: ForwardedRef<AIComposeHandle>,
) {
  const editorRef = useRef<HTMLDivElement>(null)
  const initialValueRef = useRef(initialValue)
  const [empty, setEmpty] = useState(true)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [menuIndex, setMenuIndex] = useState(0)
  const [entities, setEntities] = useState<{ apps: string[]; clients: { name: string; color: string | null; aliases: string[] }[] }>({ apps: [], clients: [] })
  const entitiesLoadedRef = useRef(false)
  // The @-trigger text range to replace on selection (null while a slash menu is open).
  const triggerRangeRef = useRef<{ node: Text; start: number; end: number } | null>(null)

  const setEditorValue = useCallback((text: string) => {
    const editor = editorRef.current
    if (!editor) return
    editor.textContent = text
    editor.dataset.empty = text.trim() ? 'false' : 'true'
    setEmpty(!text.trim())
    editor.focus()
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    setMenu(null)
  }, [])

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
    setValue: setEditorValue,
  }), [setEditorValue])

  useEffect(() => {
    if (initialValueRef.current) setEditorValue(initialValueRef.current)
    else editorRef.current?.focus()
  }, [setEditorValue])

  const loadEntities = useCallback(() => {
    if (entitiesLoadedRef.current) return
    entitiesLoadedRef.current = true
    void Promise.all([
      ipc.db.getAppSummaries(7).catch(() => []),
      ipc.attribution.listClientsDetailed().catch(() => []),
      // DEV-177: the entity repository carries aliases (including renames and
      // merges made in Settings → Memory), so "@acme" finds "ACME Corporation".
      ipc.entities.list({ type: 'client' }).catch(() => []),
    ]).then(([apps, clients, clientEntities]) => {
      const aliasesByName = new Map<string, string[]>(
        clientEntities.map((entity) => [entity.name.toLowerCase(), entity.aliases]),
      )
      setEntities({
        apps: apps.slice(0, 8).map((app) => app.appName).filter(Boolean),
        clients: clients
          .map((client) => ({ name: client.name, color: client.color, aliases: aliasesByName.get(client.name.toLowerCase()) ?? [] }))
          .filter((c) => c.name),
      })
    })
  }, [])

  const atItems = useMemo<MentionItem[]>(() => {
    const all: MentionItem[] = [
      ...entities.apps.map((name, i) => ({ id: `app-${i}`, label: name, insert: name, kind: 'App' as MentionKind })),
      ...entities.clients.map((client, i) => ({ id: `client-${i}`, label: client.name, insert: client.name, kind: 'Client' as MentionKind, color: client.color, aliases: client.aliases })),
      ...DAY_MENTIONS.map((day, i) => ({ id: `day-${i}`, label: day.label, insert: day.insert, kind: 'Day' as MentionKind })),
    ]
    const q = (menu?.kind === 'at' ? menu.query : '').toLowerCase()
    // An alias hit surfaces the canonical entity (DEV-177 alias resolution).
    const matches = (item: MentionItem & { aliases?: string[] }) =>
      item.label.toLowerCase().includes(q)
      || (item.aliases ?? []).some((alias) => alias.toLowerCase().includes(q))
    return (q ? all.filter(matches) : all).slice(0, 8)
  }, [entities, menu])

  const slashItems = useMemo<SlashCommand[]>(() => {
    const q = (menu?.kind === 'slash' ? menu.query : '').toLowerCase()
    return q ? SLASH_COMMANDS.filter((cmd) => cmd.id.includes(q) || cmd.hint.toLowerCase().includes(q)) : SLASH_COMMANDS
  }, [menu])

  const menuItemCount = menu?.kind === 'slash' ? slashItems.length : menu?.kind === 'at' ? atItems.length : 0

  const syncState = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    const serialized = serializeEditor(editor)
    const isEmpty = serialized.replace(/\u00A0/g, '').trim() === '' && editor.querySelector('.dl-mention') == null
    setEmpty(isEmpty)
    editor.dataset.empty = isEmpty ? 'true' : 'false'
    onValueChange?.(serialized)

    // Detect an active `/` (whole-input) or `@` (token-initial) trigger.
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) { setMenu(null); triggerRangeRef.current = null; return }

    const slashMatch = /^\/(\S*)$/.exec(serialized)
    if (slashMatch) {
      triggerRangeRef.current = null
      setMenu((prev) => (prev?.kind === 'slash' && prev.query === slashMatch[1] ? prev : { kind: 'slash', query: slashMatch[1] }))
      return
    }

    const focusNode = selection.focusNode
    if (focusNode && focusNode.nodeType === Node.TEXT_NODE && editor.contains(focusNode)) {
      const textNode = focusNode as Text
      const offset = selection.focusOffset
      const before = textNode.data.slice(0, offset)
      const at = before.lastIndexOf('@')
      if (at >= 0) {
        const boundaryOk = at === 0 || /\s/.test(before[at - 1])
        const token = before.slice(at + 1)
        if (boundaryOk && !/\s/.test(token)) {
          triggerRangeRef.current = { node: textNode, start: at, end: offset }
          loadEntities()
          setMenu((prev) => (prev?.kind === 'at' && prev.query === token ? prev : { kind: 'at', query: token }))
          setMenuIndex((i) => (menu?.kind === 'at' ? i : 0))
          return
        }
      }
    }
    setMenu(null)
    triggerRangeRef.current = null
  }, [loadEntities, menu, onValueChange])

  const selectSlash = useCallback((cmd: SlashCommand) => {
    const editor = editorRef.current
    if (!editor) return
    editor.textContent = cmd.prompt
    editor.focus()
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    setMenu(null)
    triggerRangeRef.current = null
    syncState()
  }, [syncState])

  const selectAt = useCallback((item: MentionItem) => {
    const editor = editorRef.current
    const trigger = triggerRangeRef.current
    if (!editor || !trigger) return
    editor.focus()
    const range = document.createRange()
    try {
      range.setStart(trigger.node, Math.min(trigger.start, trigger.node.length))
      range.setEnd(trigger.node, Math.min(trigger.end, trigger.node.length))
    } catch { return }
    range.deleteContents()
    const chip = buildMentionChipElement(item)
    const space = document.createTextNode(' ')
    range.insertNode(space)
    range.insertNode(chip)
    const after = document.createRange()
    after.setStartAfter(space)
    after.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(after)
    setMenu(null)
    triggerRangeRef.current = null
    syncState()
  }, [syncState])

  const send = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    const text = serializeEditor(editor).replace(/\u00A0/g, ' ').trim()
    if (!text || loading) return
    if (!onSubmit(text)) return
    editor.innerHTML = ''
    editor.dataset.empty = 'true'
    setEmpty(true)
    onValueChange?.('')
    setMenu(null)
    triggerRangeRef.current = null
    editor.focus()
  }, [loading, onSubmit, onValueChange])

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (menu && menuItemCount > 0) {
      if (event.key === 'ArrowDown') { event.preventDefault(); setMenuIndex((i) => Math.min(menuItemCount - 1, i + 1)); return }
      if (event.key === 'ArrowUp') { event.preventDefault(); setMenuIndex((i) => Math.max(0, i - 1)); return }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        if (menu.kind === 'slash') { const cmd = slashItems[menuIndex]; if (cmd) selectSlash(cmd) }
        else { const item = atItems[menuIndex]; if (item) selectAt(item) }
        return
      }
      if (event.key === 'Escape') { event.preventDefault(); setMenu(null); triggerRangeRef.current = null; return }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
      return
    }
    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault()
      document.execCommand('insertText', false, '\n')
      syncState()
    }
  }, [menu, menuItemCount, slashItems, atItems, menuIndex, selectSlash, selectAt, send, syncState])

  const onPaste = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault()
    const text = event.clipboardData.getData('text/plain')
    if (text) document.execCommand('insertText', false, text)
    syncState()
  }, [syncState])

  const showMenu = Boolean(menu) && menuItemCount > 0

  return (
    <div style={{ position: 'relative' }}>
      {showMenu && (
        <div
          role="listbox"
          aria-label={menu?.kind === 'slash' ? 'Commands' : 'Mentions'}
          style={{ position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, right: 0, maxHeight: 260, overflowY: 'auto', background: 'var(--color-surface)', border: '1px solid var(--color-border-ghost)', borderRadius: 12, boxShadow: 'var(--color-shadow-floating)', padding: 5, zIndex: 30 }}
        >
          {menu?.kind === 'slash'
            ? slashItems.map((cmd, idx) => (
              <button
                key={cmd.id}
                type="button"
                role="option"
                aria-selected={idx === menuIndex}
                onMouseEnter={() => setMenuIndex(idx)}
                onMouseDown={(e) => { e.preventDefault(); selectSlash(cmd) }}
                style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none', borderRadius: 8, background: idx === menuIndex ? 'var(--color-surface-high)' : 'transparent', color: 'var(--color-text-primary)', cursor: 'pointer', fontSize: 12.5 }}
              >
                <span style={{ fontWeight: 700 }}>{cmd.label}</span>
                <span style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>{cmd.hint}</span>
              </button>
            ))
            : atItems.map((item, idx) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={idx === menuIndex}
                onMouseEnter={() => setMenuIndex(idx)}
                onMouseDown={(e) => { e.preventDefault(); selectAt(item) }}
                style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left', padding: '7px 10px', border: 'none', borderRadius: 8, background: idx === menuIndex ? 'var(--color-surface-high)' : 'transparent', color: 'var(--color-text-primary)', cursor: 'pointer', fontSize: 12.5 }}
              >
                <MentionRowIcon item={item} size={18} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', flexShrink: 0 }}>{item.kind}</span>
              </button>
            ))}
        </div>
      )}
      {/* Compact composer: the box starts at a single centered line and grows
          only as the text does — never a big empty well with the caret
          stranded at the top. */}
      <div style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 8,
        borderRadius: 16,
        border: '1px solid var(--color-border-ghost)',
        background: 'var(--color-surface)',
        padding: variant === 'starter' ? '9px 10px 9px 18px' : '8px 8px 8px 16px',
        boxShadow: 'var(--color-shadow-floating)',
      }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
          {empty && (
            <span
              aria-hidden="true"
              className="dl-composer-placeholder"
            >
              {placeholder ?? 'Ask anything — / for commands, @ to mention…'}
            </span>
          )}
          <div
            ref={editorRef}
            className="dl-composer"
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            aria-label="Ask Daylens about your work history"
            data-empty="true"
            onInput={syncState}
            onKeyUp={syncState}
            onClick={syncState}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={() => { window.setTimeout(() => setMenu(null), 120) }}
            style={{
              minHeight: 24,
              maxHeight: 184,
              overflowY: 'auto',
              border: 'none',
              background: 'transparent',
              outline: 'none',
              color: 'var(--color-text-primary)',
              caretColor: 'var(--color-text-primary)',
              fontSize: variant === 'starter' ? 14 : 13.5,
              lineHeight: '22px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              padding: '6px 0',
            }}
          />
        </div>
        {loading && onCancel ? (
          <>
            {onPause && (
              <button
                onClick={onPause}
                type="button"
                aria-label="Pause — resume later, even after a restart"
                title="Pause — resume later, even after a restart"
                style={{
                  width: 34,
                  height: 34,
                  padding: 0,
                  borderRadius: 999,
                  border: '1px solid var(--color-border-ghost)',
                  cursor: 'pointer',
                  background: 'var(--color-surface-high)',
                  color: 'var(--color-text-primary)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  transition: 'background 160ms ease, color 160ms ease',
                }}
              >
                <IconPause />
              </button>
            )}
            <button
              onClick={onCancel}
              type="button"
              aria-label="Stop generating"
              title="Stop generating"
              style={{
                width: 34,
                height: 34,
                padding: 0,
                borderRadius: 999,
                border: '1px solid var(--color-border-ghost)',
                cursor: 'pointer',
                background: 'var(--color-surface-high)',
                color: 'var(--color-text-primary)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                transition: 'background 160ms ease, color 160ms ease',
              }}
            >
              <IconStop />
            </button>
          </>
        ) : (
          <button
            onClick={send}
            disabled={loading || empty}
            type="button"
            aria-label="Send message"
            style={{
              width: 34,
              height: 34,
              padding: 0,
              borderRadius: 999,
              border: 'none',
              cursor: loading || empty ? 'default' : 'pointer',
              background: !empty && !loading ? 'var(--gradient-primary)' : 'var(--color-surface-high)',
              color: !empty && !loading ? 'var(--color-primary-contrast)' : 'var(--color-text-tertiary)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              transition: 'background 160ms ease, color 160ms ease',
            }}
          >
            <IconSend />
          </button>
        )}
      </div>
    </div>
  )
}

// Pause glyph (two bars) for the in-flight pause affordance.
function IconPause() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="3.5" y="2.5" width="3.4" height="11" rx="1.3" />
      <rect x="9.1" y="2.5" width="3.4" height="11" rx="1.3" />
    </svg>
  )
}

// React.memo so chunk-driven parent re-renders skip the composer. The
// contenteditable is uncontrolled (DOM-owned), so typing never re-renders React —
// the only re-render triggers are `loading` and the open dropdown's own state.
export const AICompose = memo(forwardRef<AIComposeHandle, AIComposeProps>(AIComposeImpl))
