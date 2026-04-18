import { ipcMain } from 'electron'
import { ANALYTICS_EVENT, classifyFailureKind } from '@shared/analytics'
import { capture, captureException } from '../services/analytics'
import { IPC } from '@shared/types'
import {
  createWorkspace,
  createBrowserLink,
  disconnect,
  getSyncStatus,
  getStoredMnemonic,
} from '../services/workspaceLinker'
import { getLastSyncAt, startSync, stopSync } from '../services/syncUploader'

export function registerSyncHandlers(): void {
  ipcMain.handle(IPC.SYNC.GET_STATUS, async () => {
    return getSyncStatus(getLastSyncAt())
  })

  ipcMain.handle(IPC.SYNC.LINK, async () => {
    capture(ANALYTICS_EVENT.SYNC_LINK_STARTED, {
      surface: 'settings',
      trigger: 'settings',
    })

    try {
      const result = await createWorkspace()
      // Start syncing after linking
      startSync()
      capture(ANALYTICS_EVENT.SYNC_LINK_COMPLETED, {
        result: 'success',
        surface: 'settings',
        trigger: 'settings',
      })
      return result
    } catch (error) {
      capture(ANALYTICS_EVENT.SYNC_LINK_FAILED, {
        failure_kind: classifyFailureKind(error),
        result: 'error',
        surface: 'settings',
        trigger: 'settings',
      })
      captureException(error, {
        tags: {
          process_type: 'main',
          reason: 'sync_link_failed',
        },
      })
      throw error
    }
  })

  ipcMain.handle(IPC.SYNC.CREATE_BROWSER_LINK, async () => {
    const result = await createBrowserLink()
    capture(ANALYTICS_EVENT.SYNC_BROWSER_LINK_CREATED, {
      result: 'success',
      surface: 'settings',
      trigger: 'settings',
    })
    return result
  })

  ipcMain.handle(IPC.SYNC.DISCONNECT, async () => {
    stopSync()
    await disconnect()
    capture(ANALYTICS_EVENT.SYNC_DISCONNECTED, {
      result: 'success',
      surface: 'settings',
      trigger: 'settings',
    })
    return { success: true }
  })

  ipcMain.handle(IPC.SYNC.GET_MNEMONIC, async () => {
    return getStoredMnemonic()
  })
}
