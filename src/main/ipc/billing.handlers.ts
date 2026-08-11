import fs from 'node:fs/promises'
import { dialog, ipcMain, shell } from 'electron'
import { isPaywallTrigger, type PaywallTrigger } from '@shared/analytics'
import { IPC } from '@shared/types'
import {
  createFlutterwaveCheckout,
  createPolarCheckout,
  getBillingAccess,
  getBillingPortalUrl,
  getBillingUsage,
  getPaymentHistory,
  exportUsageRows,
  invalidateBillingAccess,
} from '../services/billing'
import { getSpendGuardrailsReport } from '../services/aiSpendGuardrails'
import { getSettingsAsync } from '../services/settings'
import { getDb } from '../services/database'

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

// The trigger crosses the bridge from the renderer — accept only known
// paywall surfaces, defaulting to 'settings' for anything else.
function checkoutTrigger(payload: unknown): PaywallTrigger {
  const trigger = (payload as { trigger?: unknown } | null)?.trigger
  return isPaywallTrigger(trigger) ? trigger : 'settings'
}

export function registerBillingHandlers(): void {
  ipcMain.handle(IPC.BILLING.GET_ACCESS, () => getBillingAccess())
  ipcMain.handle(IPC.BILLING.REFRESH, () => {
    invalidateBillingAccess()
    return getBillingAccess({ force: true })
  })
  ipcMain.handle(IPC.BILLING.GET_USAGE, (_event, payload: { from: number; to: number }) => (
    getBillingUsage(payload.from, payload.to)
  ))
  ipcMain.handle(IPC.BILLING.GET_SPEND_GUARDRAILS, async () => (
    getSpendGuardrailsReport(getDb(), await getSettingsAsync())
  ))
  ipcMain.handle(IPC.BILLING.CREATE_POLAR_CHECKOUT, async (_event, payload?: { trigger?: string }) => {
    await shell.openExternal(await createPolarCheckout(checkoutTrigger(payload)))
    return true
  })
  ipcMain.handle(IPC.BILLING.CREATE_FLUTTERWAVE_CHECKOUT, async (_event, payload: { email: string; trigger?: string }) => {
    await shell.openExternal(await createFlutterwaveCheckout(payload.email, checkoutTrigger(payload)))
    return true
  })
  ipcMain.handle(IPC.BILLING.OPEN_PORTAL, async () => {
    await shell.openExternal(await getBillingPortalUrl())
    return true
  })
  ipcMain.handle(IPC.BILLING.EXPORT_USAGE_CSV, async (_event, payload: { from: number; to: number }) => {    // Read every event in the range straight from the table, not the 2000-row
    // display cap in the usage report, so the CSV truly covers the whole range.
    const rows = exportUsageRows(payload.from, payload.to)
    const result = await dialog.showSaveDialog({
      title: 'Export AI usage',
      defaultPath: `daylens-ai-usage-${new Date(payload.from).toISOString().slice(0, 10)}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    // 'Calls'/'Failed calls' exist because days older than the telemetry
    // retention window export as one aggregate line per day+feature+model
    // group (see aiUsageRetention.ts) — per-event lines are always 1 / 0-or-1,
    // so summing the columns still reports the whole range exactly.
    const lines = [
      ['Date', 'Type', 'Feature', 'Screen', 'Trigger', 'Provider', 'Model', 'Input tokens', 'Output tokens', 'Cache read tokens', 'Cache write tokens', 'Total tokens', 'Cost USD', 'Success', 'Calls', 'Failed calls'],
      ...rows.map((row) => [
        new Date(row.occurredAt).toISOString(),
        row.type,
        row.feature,
        row.screen ?? '',
        row.triggerSource ?? '',
        row.provider ?? '',
        row.model ?? '',
        row.inputTokens ?? '',
        row.outputTokens ?? '',
        row.cacheReadTokens ?? '',
        row.cacheWriteTokens ?? '',
        row.tokens ?? '',
        row.costUsd ?? '',
        row.success ? 'yes' : 'no',
        row.calls ?? 1,
        row.failures ?? (row.success ? 0 : 1),
      ]),
    ]
    await fs.writeFile(result.filePath, lines.map((line) => line.map(csvCell).join(',')).join('\n'), 'utf8')
    return { canceled: false, path: result.filePath }
  })
  ipcMain.handle(IPC.BILLING.GET_PAYMENTS, () => getPaymentHistory())
}
