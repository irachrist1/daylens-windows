import { ipc } from './ipc'

export function track(event: string, properties?: Record<string, unknown>): void {
  ipc.analytics.capture(event, properties ?? {})
}
