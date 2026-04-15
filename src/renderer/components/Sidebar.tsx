import { useState } from 'react'
import { NavLink } from 'react-router-dom'

// ─── Icons ────────────────────────────────────────────────────────────────────

function IconTimeline() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="4" x2="12" y2="4" />
      <line x1="4" y1="8" x2="10" y2="8" />
      <line x1="4" y1="12" x2="13" y2="12" />
      <circle cx="2.5" cy="4" r="1" fill="currentColor" stroke="none" />
      <circle cx="2.5" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="2.5" cy="12" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

function IconApps() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="5" height="5" rx="1.5" />
      <rect x="9" y="2" width="5" height="5" rx="1.5" />
      <rect x="2" y="9" width="5" height="5" rx="1.5" />
      <rect x="9" y="9" width="5" height="5" rx="1.5" />
    </svg>
  )
}

function IconAI() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2c-.8 2-3 3-3 5.5a3 3 0 0 0 6 0C11 5 8.8 4 8 2z" />
      <path d="M6.5 13.5h3" />
      <path d="M8 13v2" />
    </svg>
  )
}

function IconSettings() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1.4v1.2M8 13.4v1.2M1.4 8h1.2M13.4 8h1.2M3.25 3.25l.85.85M11.9 11.9l.85.85M3.25 12.75l.85-.85M11.9 4.1l.85-.85" />
      <circle cx="8" cy="8" r="5.1" opacity="0.7" />
    </svg>
  )
}

// ─── Nav item ─────────────────────────────────────────────────────────────────

interface NavDef {
  to: string
  label: string
  icon: React.ReactNode
}

const MAIN_NAV: NavDef[] = [
  { to: '/timeline', label: 'Timeline', icon: <IconTimeline /> },
  { to: '/apps',     label: 'Apps',     icon: <IconApps /> },
  { to: '/ai',       label: 'AI',       icon: <IconAI /> },
]

function NavItem({ to, label, icon }: NavDef) {
  const [hovered, setHovered] = useState(false)
  return (
    <NavLink
      to={to}
      style={({ isActive }) => ({
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '9px 12px',
        borderRadius: 8,
        fontSize: 13,
        fontWeight: isActive ? 600 : 500,
        letterSpacing: '-0.01em',
        textDecoration: 'none',
        transition: 'all 180ms',
        ...(isActive
          ? {
              color: 'var(--color-text-primary)',
              background: 'var(--color-surface-low)',
              border: '1px solid var(--color-border-ghost)',
              opacity: 1,
            }
          : hovered
            ? {
                color: 'var(--color-text-primary)',
                background: 'var(--color-pill-bg)',
                border: '1px solid transparent',
                opacity: 1,
              }
            : {
                color: 'var(--color-text-secondary)',
                border: '1px solid transparent',
                opacity: 0.78,
              }),
      })}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span style={{ width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {icon}
      </span>
      {label}
    </NavLink>
  )
}

export default function Sidebar() {
  return (
    <aside
      style={{
        width: 190,
        flexShrink: 0,
        background: 'var(--color-sidebar-bg)',
        borderRight: '1px solid var(--color-sidebar-border)',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        padding: '22px 14px',
        boxSizing: 'border-box',
        fontFamily: 'var(--font-sans)',
      }}
    >
      {/* Wordmark */}
      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.03em', paddingLeft: 2 }}>
        Daylens
      </div>

      {/* Primary nav */}
      <nav style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3, marginTop: 26 }}>
        {MAIN_NAV.map((item) => (
          <NavItem key={item.to} {...item} />
        ))}
      </nav>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <NavItem to="/settings" label="Settings" icon={<IconSettings />} />
      </div>
    </aside>
  )
}
