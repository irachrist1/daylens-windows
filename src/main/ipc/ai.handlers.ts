import { ipcMain } from 'electron'
import { clearAIHistory, generateWorkBlockInsight, getAIHistory, sendMessage, suggestAppCategory } from '../services/ai'
import { IPC, type WorkContextBlock } from '@shared/types'

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

  ipcMain.handle(IPC.AI.GENERATE_BLOCK_INSIGHT, async (_e, block: WorkContextBlock) => {
    return generateWorkBlockInsight(block)
  })

  ipcMain.handle(IPC.AI.SUGGEST_APP_CATEGORY, async (_e, bundleId: string, appName: string) => {
    return suggestAppCategory(bundleId, appName)
  })
}
