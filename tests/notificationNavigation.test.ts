import test from 'node:test'
import assert from 'node:assert/strict'
import { handleDailySummaryNavigation } from '../src/renderer/lib/dailySummaryNavigation.ts'
import { buildDailyReportRoute, openDailySummaryRoute } from '../src/main/services/dailySummaryNavigation.ts'

function makeEmptyDay(date: string) {
  return {
    date,
    totalSeconds: 0,
    focusSeconds: 0,
    focusPct: 0,
    appCount: 0,
    siteCount: 0,
    sessions: [],
    websites: [],
    blocks: [],
    segments: [],
    focusSessions: [],
    computedAt: Date.now(),
    version: 'test',
  }
}

test('daily summary navigation opens Day Wrapped for the date in the route even when data is empty', async () => {
  const fetchedDates: string[] = []
  const openedDates: string[] = []
  const navigatedRoutes: string[] = []

  await handleDailySummaryNavigation('/ai?source=daily-summary&date=2026-04-29&threadId=42&artifactId=7', {
    getTimelineDay: async (date) => {
      fetchedDates.push(date)
      return makeEmptyDay(date)
    },
    openWrapped: ({ day }) => {
      openedDates.push(day.date)
    },
    navigate: (route) => {
      navigatedRoutes.push(route)
    },
    todayString: () => '2026-04-30',
  })

  assert.deepEqual(fetchedDates, ['2026-04-29'])
  assert.deepEqual(openedDates, ['2026-04-29'])
  assert.deepEqual(navigatedRoutes, [])
})

test('daily report route includes the report date for Morning Brief click-through', () => {
  const route = buildDailyReportRoute({
    date: '2026-04-29',
    threadId: 42,
    artifactId: 7,
    prepared: true,
    status: 'ready',
  })

  assert.equal(route, '/ai?threadId=42&artifactId=7&date=2026-04-29&source=daily-summary')
})

test('notification click shows a hidden window before sending the navigation event', () => {
  const calls: string[] = []
  const sentRoutes: string[] = []
  const window = {
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => false,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
    webContents: {
      isLoadingMainFrame: () => false,
      once: () => {},
      send: (_channel: string, route: string) => sentRoutes.push(route),
    },
  }

  openDailySummaryRoute('/ai?source=daily-summary&date=2026-04-29', () => window)

  assert.deepEqual(calls, ['show', 'focus'])
  assert.deepEqual(sentRoutes, ['/ai?source=daily-summary&date=2026-04-29'])
})
