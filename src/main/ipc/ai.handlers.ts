import { ipcMain } from 'electron'
import { clearAIHistory, getAIHistory, sendMessage } from '../services/ai'
import { IPC } from '@shared/types'

export function registerAIHandlers(): void {
  ipcMain.handle(IPC.AI.SEND_MESSAGE, async (_e, message: string) => {
    return sendMessage(message)
  })

  ipcMain.handle(IPC.AI.GET_HISTORY, () => {
    return getAIHistory()
  })

  ipcMain.handle(IPC.AI.CLEAR_HISTORY, () => {
    clearAIHistory()
  })
}
