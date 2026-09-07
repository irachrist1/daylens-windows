import type { CSSProperties, ReactNode } from 'react'
import { useState } from 'react'
import type { AIArtifactRecord } from '@shared/types'

export function IconSend() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 13 13 3" />
      <path d="M5.5 3H13v7.5" />
    </svg>
  )
}

// The composer's send button flips to this while a generation is running.
export function IconStop() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="3.5" y="3.5" width="9" height="9" rx="2" />
    </svg>
  )
}

export function IconCopy() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="3" width="8" height="10" rx="2" />
      <path d="M3.5 11.5h-1A1.5 1.5 0 0 1 1 10V3.5A1.5 1.5 0 0 1 2.5 2H8" />
    </svg>
  )
}

export function IconThumbsUp() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.5 7 8.8 2.8A1.3 1.3 0 0 1 11.2 4v2h1.4A1.4 1.4 0 0 1 14 7.7l-.8 4A1.8 1.8 0 0 1 11.4 13H6.5" />
      <path d="M2 7h4.5v6H2z" />
    </svg>
  )
}

export function IconThumbsDown() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.5 9 7.2 13.2A1.3 1.3 0 0 1 4.8 12v-2H3.4A1.4 1.4 0 0 1 2 8.3l.8-4A1.8 1.8 0 0 1 4.6 3h4.9" />
      <path d="M9.5 3H14v6H9.5z" />
    </svg>
  )
}

export function IconRetry() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 5V1.8h-3.2" />
      <path d="M13 2.2A6 6 0 1 0 14 8" />
    </svg>
  )
}

export function IconSparkle({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M10 1.5c0 0 .9 4.8 2.5 6.5C14.2 9.7 18.5 10 18.5 10s-4.3.3-6 2c-1.6 1.7-2.5 6.5-2.5 6.5s-.9-4.8-2.5-6.5C6 10.3 1.5 10 1.5 10S6 9.7 7.5 8C9 6.3 10 1.5 10 1.5Z" />
    </svg>
  )
}

// A clearer "new chat" affordance than the bare pencil — a compose square
// with a plus, which reads unambiguously as "start a new chat".
export function IconNewChat() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13.5 8.6V12A1.5 1.5 0 0 1 12 13.5H4A1.5 1.5 0 0 1 2.5 12V4A1.5 1.5 0 0 1 4 2.5h3.4" />
      <path d="M11.2 1.7v4.2M9.1 3.8h4.2" />
    </svg>
  )
}

export function IconChevronDown() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 4l4 4 4-4" />
    </svg>
  )
}

export function IconSearch({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
    </svg>
  )
}

// Sidebar toggle — a panel with a divider, reads as "show/hide the list".
export function IconSidebar({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M6.2 2.7v10.6" />
    </svg>
  )
}

export function IconArchive({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="3" rx="1" />
      <path d="M3 5.5v6A1.5 1.5 0 0 0 4.5 13h7A1.5 1.5 0 0 0 13 11.5v-6" />
      <path d="M6.5 8h3" />
    </svg>
  )
}

export function IconExternal() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12L12 2M7 2h5v5" />
    </svg>
  )
}

export function IconArtifactFile({ kind }: { kind: AIArtifactRecord['kind'] }) {
  if (kind === 'csv' || kind === 'json_table') {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="1" width="12" height="14" rx="2" />
        <path d="M5 6h6M5 9h6M5 12h4" />
      </svg>
    )
  }
  if (kind === 'html_chart') {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 12 L5 8 L8 10 L11 5 L14 7" />
        <rect x="1" y="1" width="14" height="14" rx="2" />
      </svg>
    )
  }
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="1" width="12" height="14" rx="2" />
      <path d="M5 5h6M5 8h6M5 11h4" />
    </svg>
  )
}

const actionButtonStyle: CSSProperties = {
  width: 30,
  height: 30,
  padding: 0,
  borderRadius: 999,
  border: '1px solid var(--color-border-ghost)',
  background: 'transparent',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'transform 140ms ease, background 180ms ease, border-color 180ms ease, color 180ms ease',
  transformOrigin: 'center',
}

export function IconActionButton({
  label,
  feedbackLabel,
  selected = false,
  success = false,
  tone = 'neutral',
  pulseNonce = 0,
  reducedMotion = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string
  feedbackLabel?: string
  selected?: boolean
  success?: boolean
  tone?: 'neutral' | 'positive' | 'negative'
  pulseNonce?: number
  reducedMotion?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  const [pressed, setPressed] = useState(false)
  const pulseName = pulseNonce > 0
    ? (pulseNonce % 2 === 0 ? 'insightsActionBounceA' : 'insightsActionBounceB')
    : null

  const selectedBackground = tone === 'negative'
    ? 'rgba(248, 113, 113, 0.10)'
    : 'var(--color-accent-dim)'
  const selectedBorder = tone === 'negative'
    ? 'rgba(248, 113, 113, 0.30)'
    : 'rgba(173, 198, 255, 0.28)'
  const selectedText = tone === 'negative'
    ? '#f87171'
    : 'var(--color-text-primary)'
  const background = success ? 'rgba(79, 219, 200, 0.12)' : selected ? selectedBackground : 'transparent'
  const borderColor = success ? 'rgba(79, 219, 200, 0.30)' : selected ? selectedBorder : 'var(--color-border-ghost)'
  const textColor = success ? 'var(--color-focus-green)' : selected ? selectedText : 'var(--color-text-secondary)'

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') setPressed(true)
      }}
      onKeyUp={(event) => {
        if (event.key === 'Enter' || event.key === ' ') setPressed(false)
      }}
      onBlur={() => setPressed(false)}
      title={feedbackLabel ?? label}
      aria-label={feedbackLabel ?? label}
      type="button"
      style={{
        ...actionButtonStyle,
        color: textColor,
        background,
        borderColor,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        transform: reducedMotion ? undefined : pressed ? 'scale(0.92)' : undefined,
        animation: !reducedMotion && pulseName
          ? `${pulseName} 200ms cubic-bezier(0.2, 0.9, 0.2, 1.15)`
          : undefined,
      }}
    >
      {children}
    </button>
  )
}
