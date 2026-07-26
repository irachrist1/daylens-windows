// IPC for Settings → Export (DEV-196). The renderer sees plans, progress
// events, results, and verification reports — never a raw database row. The
// export itself is generated entirely locally by historyExport.ts; nothing
// here can reach the network, and it needs no model and no billing state.
import { app, dialog, ipcMain } from 'electron'
import { IPC } from '@shared/types'
import type { HistoryExportPlan, HistoryExportRunResult, HistoryExportVerification, WrapSlidesExportResult } from '@shared/types'
import { getDb } from '../services/database'
import { planHistoryExport, runHistoryExport, verifyHistoryExport } from '../services/historyExport'
import { validateWrapSlideFiles, writeWrapSlides, type WrapSlideFile } from '../services/wrapSlideExport'

export function registerExportHandlers(): void {
  ipcMain.handle(
    IPC.EXPORT.PLAN,
    (_event, payload: { includeHighSensitivity?: boolean } = {}): HistoryExportPlan => {
      return planHistoryExport(getDb(), { includeHighSensitivity: payload.includeHighSensitivity })
    },
  )

  ipcMain.handle(IPC.EXPORT.CHOOSE_DESTINATION, async (): Promise<{ canceled: boolean; dir?: string }> => {
    const result = await dialog.showOpenDialog({
      title: 'Choose where to save your Daylens export',
      buttonLabel: 'Export here',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    return { canceled: false, dir: result.filePaths[0] }
  })

  ipcMain.handle(
    IPC.EXPORT.RUN,
    async (
      event,
      payload: { destinationDir: string; includeHighSensitivity?: boolean },
    ): Promise<HistoryExportRunResult> => {
      return runHistoryExport(getDb(), {
        destinationDir: payload.destinationDir,
        includeHighSensitivity: payload.includeHighSensitivity,
        appVersion: app.getVersion(),
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send(IPC.EXPORT.PROGRESS, progress)
        },
      })
    },
  )

  // DEV-248: per-slide wrap export. One folder picker, then every slide of the
  // deck lands as its own PNG in a subfolder named after the wrap. A failed
  // write cleans up and REJECTS (the renderer shows the failure); it never
  // resolves as success with files missing.
  ipcMain.handle(
    IPC.EXPORT.WRAP_SLIDES,
    async (_event, payload: { stem: string; files: WrapSlideFile[] }): Promise<WrapSlidesExportResult> => {
      const invalid = validateWrapSlideFiles(payload?.files)
      if (invalid) throw new Error(invalid)
      const result = await dialog.showOpenDialog({
        title: 'Choose where to save your wrap slides',
        buttonLabel: 'Save slides here',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (result.canceled || result.filePaths.length === 0) return { canceled: true }
      const stem = typeof payload.stem === 'string' ? payload.stem : 'daylens-wrap'
      const written = await writeWrapSlides(result.filePaths[0], stem, payload.files)
      return { canceled: false, dir: written.dir, files: written.files }
    },
  )

  // Re-verify any previous export: the person picks the export folder, and we
  // re-check every checksum and row count against its manifest.
  ipcMain.handle(
    IPC.EXPORT.VERIFY,
    async (_event, payload: { exportDir?: string } = {}): Promise<
      { canceled: true } | { canceled: false; exportDir: string; verification: HistoryExportVerification }
    > => {
      let dir = payload.exportDir
      if (!dir) {
        const result = await dialog.showOpenDialog({
          title: 'Choose a Daylens export folder to verify',
          buttonLabel: 'Verify',
          properties: ['openDirectory'],
        })
        if (result.canceled || result.filePaths.length === 0) return { canceled: true }
        dir = result.filePaths[0]
      }
      return { canceled: false, exportDir: dir, verification: await verifyHistoryExport(dir) }
    },
  )
}
