import type { DayTimelinePayload } from '@shared/types'

interface DailySummaryNavigationDeps {
  getTimelineDay: (date: string) => Promise<DayTimelinePayload>
  openWrapped: (payload: {
    day: DayTimelinePayload
    threadId: number | null
    artifactId: number | null
  }) => void
  navigate: (route: string) => void
  todayString: () => string
}

function numberParam(value: string | null): number | null {
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function emptyDay(date: string): DayTimelinePayload {
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
    version: 'fallback',
  }
}

export async function handleDailySummaryNavigation(
  route: string,
  deps: DailySummaryNavigationDeps,
): Promise<boolean> {
  const url = new URL(route, 'http://x')
  if (url.searchParams.get('source') !== 'daily-summary') {
    deps.navigate(route)
    return false
  }

  const threadId = numberParam(url.searchParams.get('threadId'))
  const artifactId = numberParam(url.searchParams.get('artifactId'))
  const wrappedDate = url.searchParams.get('date') || deps.todayString()

  try {
    const day = await deps.getTimelineDay(wrappedDate)
    deps.openWrapped({ day, threadId, artifactId })
  } catch {
    deps.openWrapped({ day: emptyDay(wrappedDate), threadId, artifactId })
  }

  return true
}
