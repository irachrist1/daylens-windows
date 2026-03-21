// Formatting utilities shared across views

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h === 0) return `${m}m`
  return `${h}h ${m}m`
}

export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

// Returns e.g. "Monday, March 18" from a YYYY-MM-DD string.
// Parses via components to stay timezone-safe.
export function formatFullDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

// Returns a short relative label: "Today", "Yesterday", or "Mon Mar 18"
export function formatRelativeDate(dateStr: string): string {
  const today = todayString()
  if (dateStr === today) return 'Today'
  const [y, m, d] = dateStr.split('-').map(Number)
  const [ty, tm, td] = today.split('-').map(Number)
  const diff = new Date(ty, tm - 1, td).getTime() - new Date(y, m - 1, d).getTime()
  if (diff === 86_400_000) return 'Yesterday'
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

export function dateStringFromMs(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Returns today's date as a local YYYY-MM-DD string.
// DO NOT use new Date().toISOString().split('T')[0] — that returns the UTC date
// which is wrong in UTC- timezones after ~7 pm local time.
export function todayString(): string {
  return dateStringFromMs(Date.now())
}

// "Mon, Mar 18" — short date from a Unix ms timestamp, for multi-day session lists
export function formatDateShort(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    weekday: 'short',
    month:   'short',
    day:     'numeric',
  })
}

export function percentOf(part: number, total: number): number {
  if (total === 0) return 0
  return Math.round((part / total) * 100)
}

export function dayBounds(dateStr: string): [number, number] {
  const [y, m, d] = dateStr.split('-').map(Number)
  const from = new Date(y, m - 1, d).getTime()
  return [from, from + 86_400_000]
}

export function rollingDayBounds(days: number): [number, number] {
  const [todayFrom, todayTo] = dayBounds(todayString())
  if (days <= 1) return [todayFrom, todayTo]
  return [todayFrom - (days - 1) * 86_400_000, todayTo]
}
