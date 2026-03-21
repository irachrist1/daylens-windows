export function localDateString(date: Date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function localDayBounds(dateStr: string): [number, number] {
  const [year, month, day] = dateStr.split('-').map(Number)
  const from = new Date(year, month - 1, day).getTime()
  return [from, from + 86_400_000]
}

export function daysFromTodayLocalDateString(offsetDays: number): string {
  const today = new Date()
  return localDateString(
    new Date(today.getFullYear(), today.getMonth(), today.getDate() + offsetDays),
  )
}
