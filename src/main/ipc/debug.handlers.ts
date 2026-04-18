import { ipcMain, app } from 'electron'
import path from 'node:path'
import { IPC } from '@shared/types'
import { getCurrentSession, lastClassifyMatch, trackingStatus } from '../services/tracking'
import { getBrowserStatus } from '../services/browser'
import { getRecentAppSessions } from '../db/queries'
import { getDb } from '../services/database'
import { getUpdateAvailable, getUpdaterState } from '../services/updater'
import { getLinuxDesktopDiagnostics } from '../services/linuxDesktop'
import { getTrayDiagnostics } from '../tray'

export function registerDebugHandlers(): void {
  ipcMain.handle(IPC.DEBUG.GET_INFO, () => ({
    dbPath:          path.join(app.getPath('userData'), 'daylens.sqlite'),
    platform:        process.platform,
    appVersion:      app.getVersion(),
    liveSession:     getCurrentSession(),
    lastClassify:    lastClassifyMatch,
    trackingStatus:  { ...trackingStatus },
    recentSessions:  getRecentAppSessions(getDb(), 5),
    browserStatus:   getBrowserStatus(),
    updateAvailable: getUpdateAvailable(),
    updater:         getUpdaterState(),
    tray:            getTrayDiagnostics(),
    linuxDesktop:    getLinuxDesktopDiagnostics(),
  }))
}
