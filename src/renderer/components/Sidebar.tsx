import { NavLink } from 'react-router-dom'

// Minimal 16×16 SVG icons — currentColor, no fill unless specified
function IconToday() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="2.2" fill="currentColor" stroke="none" />
    </svg>
  )
}
function IconFocus() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <circle cx="8" cy="8" r="6.5" />
      <circle cx="8" cy="8" r="3" />
    </svg>
  )
}
function IconHistory() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2.5a5.5 5.5 0 1 1-3.9 1.7" />
      <polyline points="3,5.5 7.5,5.5 7.5,9" />
    </svg>
  )
}
function IconApps() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </svg>
  )
}
function IconInsights() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.5 9.6 6H14l-3.5 2.5 1.3 4.2L8 10.2l-3.8 2.5 1.3-4.2L2 6h4.4z" />
    </svg>
  )
}
function IconSettings() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9" />
    </svg>
  )
}

interface NavDef {
  to: string
  label: string
  icon: React.ReactNode
}

const MAIN_NAV: NavDef[] = [
  { to: '/today',    label: 'Today',    icon: <IconToday /> },
  { to: '/focus',    label: 'Focus',    icon: <IconFocus /> },
  { to: '/history',  label: 'History',  icon: <IconHistory /> },
  { to: '/apps',     label: 'Apps',     icon: <IconApps /> },
  { to: '/insights', label: 'Insights', icon: <IconInsights /> },
]

function NavItem({ to, label, icon }: NavDef) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        [
          'flex items-center gap-2.5 px-3 h-9 rounded-lg text-[13px] font-medium transition-colors select-none',
          isActive
            ? 'bg-[var(--color-surface-high)] text-[var(--color-text-primary)]'
            : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-high)] hover:text-[var(--color-text-primary)]',
        ].join(' ')
      }
    >
      <span className="w-4 h-4 shrink-0 flex items-center justify-center opacity-75">
        {icon}
      </span>
      {label}
    </NavLink>
  )
}

export default function Sidebar() {
  return (
    <aside className="flex flex-col w-[220px] shrink-0 bg-[var(--color-surface-container)] border-r border-[var(--color-border)]">
      {/* App wordmark */}
      <div className="px-5 pt-4 pb-3">
        <span className="text-[13px] font-semibold text-[var(--color-text-primary)] tracking-tight">
          Daylens
        </span>
      </div>

      {/* Nav section label */}
      <div className="px-5 pt-3 pb-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--color-text-tertiary)]">
          Menu
        </span>
      </div>

      {/* Main navigation */}
      <nav className="flex flex-col gap-0.5 px-2.5">
        {MAIN_NAV.map((item) => (
          <NavItem key={item.to} {...item} />
        ))}
      </nav>

      {/* Settings — pinned to bottom */}
      <div className="mt-auto px-2.5 pb-4 pt-2 border-t border-[var(--color-border)]">
        <NavItem to="/settings" label="Settings" icon={<IconSettings />} />
      </div>
    </aside>
  )
}
