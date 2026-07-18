// Counts capture events that were rejected before persistence — malformed
// payloads, unsupported schema versions, contract violations. The counts are
// capture-health facts ("Daylens dropped N observations since launch"), not
// analytics: they stay in memory and surface through the tracking
// diagnostics IPC payload. They contain no event content.

export type CaptureRejectionAdapter = 'mac_focus_helper' | 'windows_focus_helper' | 'focus_repository'

export interface CaptureRejectionCounts {
  total: number
  byReason: Record<string, number>
}

const byAdapter = new Map<CaptureRejectionAdapter, Map<string, number>>()

export function recordCaptureEventRejection(adapter: CaptureRejectionAdapter, reason: string): void {
  let reasons = byAdapter.get(adapter)
  if (!reasons) {
    reasons = new Map()
    byAdapter.set(adapter, reasons)
  }
  reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
}

export function getCaptureEventRejections(): Record<string, CaptureRejectionCounts> {
  const out: Record<string, CaptureRejectionCounts> = {}
  for (const [adapter, reasons] of byAdapter) {
    const byReason: Record<string, number> = {}
    let total = 0
    for (const [reason, count] of reasons) {
      byReason[reason] = count
      total += count
    }
    out[adapter] = { total, byReason }
  }
  return out
}

export function resetCaptureEventRejectionsForTest(): void {
  byAdapter.clear()
}
