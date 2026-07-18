import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props { children: ReactNode; name: string }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Forward to main for Sentry — getDerivedStateFromError only shows the
    // fallback screen; without this the crash never leaves the renderer.
    try {
      window.daylens?.errors?.reportRenderCrash({
        name: error.name,
        message: error.message,
        stack: error.stack ?? null,
        componentStack: errorInfo.componentStack ?? null,
        boundary: this.props.name,
      })
    } catch {
      // Reporting must never take down the fallback UI.
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-3 p-8 text-center">
          <p className="text-sm text-[var(--color-text-secondary)]">
            Something went wrong in {this.props.name}.
          </p>
          <p className="text-xs text-[var(--color-text-muted)] opacity-60">
            {this.state.error.message}
          </p>
          <button
            className="text-xs underline text-[var(--color-text-secondary)] mt-2"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
