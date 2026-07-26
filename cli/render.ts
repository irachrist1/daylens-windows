// Terminal rendering shared by every CLI command. Plain text, TTY-aware
// color, and a --json escape hatch handled by the caller.

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
}

const isTTY = process.stdout.isTTY === true

export function c(key: keyof typeof ANSI, value: string): string {
  return isTTY ? `${ANSI[key]}${value}${ANSI.reset}` : value
}

export function fmtTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function fmtDuration(seconds: number): string {
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  return `${m}m`
}

export function ymd(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function isValidDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

export function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00`)
  d.setDate(d.getDate() + days)
  return ymd(d)
}

/** Print a value as JSON (stable order not required) or hand off to a renderer. */
export function emit<T>(value: T, asJson: boolean, render: (value: T) => void): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  } else {
    render(value)
  }
}

export function fail(message: string): never {
  process.stderr.write(`${c('red', 'error:')} ${message}\n`)
  process.exit(2)
}
