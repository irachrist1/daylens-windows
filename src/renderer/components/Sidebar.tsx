import { NavLink } from 'react-router-dom'

interface NavItem {
  to: string
  label: string
  icon: string
}

const NAV: NavItem[] = [
  { to: '/today', label: 'Today', icon: '◎' },
  { to: '/focus', label: 'Focus', icon: '⊙' },
  { to: '/history', label: 'History', icon: '≡' },
  { to: '/apps', label: 'Apps', icon: '⊞' },
  { to: '/insights', label: 'Insights', icon: '✦' },
]

export default function Sidebar() {
  return (
    <aside className="flex flex-col w-48 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)]">
      {/* App name */}
      <div className="px-5 py-5 text-sm font-semibold tracking-wide text-[var(--color-text-primary)]">
        Daylens
      </div>

      {/* Nav items */}
      <nav className="flex flex-col gap-0.5 px-2">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              [
                'flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] transition-colors',
                isActive
                  ? 'bg-[var(--color-surface-raised)] text-[var(--color-text-primary)]'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text-primary)]',
              ].join(' ')
            }
          >
            <span className="w-4 text-center opacity-70">{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>

      {/* Settings at bottom */}
      <div className="mt-auto px-2 pb-4">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            [
              'flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] transition-colors',
              isActive
                ? 'bg-[var(--color-surface-raised)] text-[var(--color-text-primary)]'
                : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text-primary)]',
            ].join(' ')
          }
        >
          <span className="w-4 text-center opacity-70">⚙</span>
          Settings
        </NavLink>
      </div>
    </aside>
  )
}
