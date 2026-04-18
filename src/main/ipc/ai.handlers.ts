import { ipcMain } from 'electron'
import { updateAIMessageFeedback } from '../db/queries'
import { getDb } from '../services/database'
import {
  clearAIHistory,
  detectCLITools,
  getAppNarrative,
  generateDaySummary,
  generateWorkBlockInsight,
  getAIHistory,
  getWeekReview,
  sendMessage,
  suggestAppCategory,
  testCLITool,
} from '../services/ai'
import { IPC, type AIChatSendRequest, type WorkContextBlock } from '@shared/types'

export function registerAIHandlers(): void {
  ipcMain.handle(IPC.AI.SEND_MESSAGE, async (event, payload: AIChatSendRequest) => {
    return sendMessage(payload, {
      onStreamEvent: (streamEvent) => {
        event.sender.send(IPC.AI.STREAM_EVENT, streamEvent)
      },
    })
  })

  ipcMain.handle(IPC.AI.SET_MESSAGE_FEEDBACK, (_e, payload: { messageId: number; rating: 'up' | 'down' | null }) => {
    return updateAIMessageFeedback(getDb(), payload.messageId, payload.rating)
  })

  ipcMain.handle(IPC.AI.GENERATE_DAY_SUMMARY, async (_e, date: string) => {
    return generateDaySummary(date)
  })

  ipcMain.handle(IPC.AI.GET_WEEK_REVIEW, async (_e, payload: { weekStart: string }) => {
    return getWeekReview(payload.weekStart)
  })

  ipcMain.handle(IPC.AI.GET_APP_NARRATIVE, async (_e, payload: { canonicalAppId: string; days?: number }) => {
    return getAppNarrative(payload.canonicalAppId, payload.days ?? 7)
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

  ipcMain.handle(IPC.AI.DETECT_CLI_TOOLS, async () => {
    return detectCLITools()
  })

  ipcMain.handle(IPC.AI.TEST_CLI_TOOL, async (_e, payload: { tool: 'claude' | 'codex' }) => {
    return testCLITool(payload.tool)
  })
}
