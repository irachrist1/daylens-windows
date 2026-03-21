import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { PostHog } from 'posthog-node'

declare const __POSTHOG_KEY__: string
declare const __POSTHOG_HOST__: string

const posthog = new PostHog(__POSTHOG_KEY__, {
  host: __POSTHOG_HOST__,
  flushInterval: 30_000,
})

// Start with a temporary UUID; replaced with the persisted ID once the store loads
let distinctId: string = randomUUID()

// Load or create the persisted analytics ID (anonymous — never linked to name/email/API key)
void (async () => {
  try {
    const { default: Store } = await import('electron-store')
    const store = new Store() as { get: (k: string, d?: unknown) => unknown; set: (k: string, v: unknown) => void }
    let id = store.get('analyticsId', null) as string | null
    if (!id) {
      id = randomUUID()
      store.set('analyticsId', id)
    }
    distinctId = id
  } catch {
    // Keep the temp UUID if store fails
  }
})()

export function capture(event: string, properties?: Record<string, unknown>): void {
  try {
    posthog.capture({
      distinctId,
      event,
      properties: {
        app_version: app.getVersion(),
        platform: process.platform,
        ...properties,
      },
    })
  } catch {
    // Never let analytics crash the app
  }
}

export function shutdown(): void {
  try {
    posthog.shutdown()
  } catch {
    // Best-effort
  }
}
