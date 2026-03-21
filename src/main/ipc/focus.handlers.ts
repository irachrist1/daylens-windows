import { ipcMain } from 'electron'
import {
  getActiveFocusSession,
  getRecentFocusSessions,
  startFocusSession,
  stopFocusSession,
} from '../db/queries'
import { getDb } from '../services/database'
import { IPC } from '@shared/types'

export function registerFocusHandlers(): void {
  ipcMain.handle(IPC.FOCUS.START, (_e, label: string | null = null) => {
    return startFocusSession(getDb(), label)
  })

  ipcMain.handle(IPC.FOCUS.STOP, (_e, id: number) => {
    stopFocusSession(getDb(), id)
  })

  ipcMain.handle(IPC.FOCUS.GET_ACTIVE, () => {
    return getActiveFocusSession(getDb())
  })

  ipcMain.handle(IPC.FOCUS.GET_RECENT, (_e, limit: number = 20) => {
    return getRecentFocusSessions(getDb(), limit)
  })
}
