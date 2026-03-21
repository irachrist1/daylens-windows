import { ipcMain, app } from 'electron'
import path from 'node:path'
import { IPC } from '@shared/types'
import { getCurrentSession, lastClassifyMatch } from '../services/tracking'
import { getBrowserStatus } from '../services/browser'
import { getRecentAppSessions } from '../db/queries'
import { getDb } from '../services/database'

export function registerDebugHandlers(): void {
  ipcMain.handle(IPC.DEBUG.GET_INFO, () => ({
    dbPath:         path.join(app.getPath('userData'), 'daylens.sqlite'),
    platform:       process.platform,
    appVersion:     app.getVersion(),
    liveSession:    getCurrentSession(),
    lastClassify:   lastClassifyMatch,
    recentSessions: getRecentAppSessions(getDb(), 5),
    browserStatus:  getBrowserStatus(),
  }))
}
