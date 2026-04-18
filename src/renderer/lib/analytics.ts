import type { AnalyticsEventName } from '@shared/analytics'
import { ipc } from './ipc'

export function track(event: AnalyticsEventName, properties?: Record<string, unknown>): void {
  ipc.analytics.capture(event, properties ?? {})
}
