// Custom title bar — provides the drag region and (on Windows) window controls.
// On macOS the native traffic lights sit at trafficLightPosition in main/index.ts;
// we just need a 40px drag region with a left inset so they aren't covered.

// -webkit-app-region isn't in React.CSSProperties; extend it here.
type DragStyle = React.CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' }

const IS_MAC = navigator.platform.startsWith('Mac')

const DRAG: DragStyle    = { WebkitAppRegion: 'drag' }
const NO_DRAG: DragStyle = { WebkitAppRegion: 'no-drag' }

function WinControls() {
  return (
    <div className="flex items-stretch h-full" style={NO_DRAG}>
      <button
        onClick={() => window.daylens.win.minimize()}
        title="Minimize"
        className="w-11 h-full flex items-center justify-center text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-high)] hover:text-[var(--color-text-primary)] transition-colors"
      >
        <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor">
          <rect width="10" height="1" />
        </svg>
      </button>
      <button
        onClick={() => window.daylens.win.maximize()}
        title="Maximize"
        className="w-11 h-full flex items-center justify-center text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-high)] hover:text-[var(--color-text-primary)] transition-colors"
      >
        <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" strokeWidth="1">
          <rect x="0.5" y="0.5" width="8" height="8" />
        </svg>
      </button>
      <button
        onClick={() => window.daylens.win.close()}
        title="Close"
        className="w-11 h-full flex items-center justify-center text-[var(--color-text-secondary)] hover:bg-red-500 hover:text-white transition-colors"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
          <line x1="1.5" y1="1.5" x2="8.5" y2="8.5" />
          <line x1="8.5" y1="1.5" x2="1.5" y2="8.5" />
        </svg>
      </button>
    </div>
  )
}

export default function TitleBar() {
  return (
    <div
      className="flex items-center h-10 shrink-0 select-none bg-[var(--color-surface-container)] border-b border-[var(--color-border)]"
      style={DRAG}
    >
      {/* macOS: 72px inset so native traffic lights aren't obscured */}
      {IS_MAC && <div className="w-[72px] shrink-0" />}

      {/* Drag region fills the middle */}
      <div className="flex-1" />

      {/* Windows only: min / max / close */}
      {!IS_MAC && <WinControls />}
    </div>
  )
}
