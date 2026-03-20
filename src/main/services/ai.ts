// AI service — wraps @anthropic-ai/sdk, runs in main process only
// Renderer communicates via IPC (never direct SDK access)
import Anthropic from '@anthropic-ai/sdk'
import {
  appendConversationMessage,
  clearConversation,
  getConversationMessages,
  getOrCreateConversation,
} from '../db/queries'
import { getDb } from './database'
import { getSettings } from './settings'

function buildClient(): Anthropic {
  const { anthropicApiKey } = getSettings()
  if (!anthropicApiKey) throw new Error('No API key configured')
  return new Anthropic({ apiKey: anthropicApiKey })
}

export async function sendMessage(userMessage: string): Promise<string> {
  const client = buildClient()
  const db = getDb()
  const conversationId = getOrCreateConversation(db)

  appendConversationMessage(db, conversationId, 'user', userMessage)

  const history = getConversationMessages(db, conversationId)
  // Last message is the one we just inserted — send all but that as prior context
  const prior = history.slice(0, -1)

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    system:
      'You are Daylens, a personal productivity coach. ' +
      'You help the user understand their computer usage patterns and improve focus. ' +
      'Be concise and actionable.',
    messages: [
      ...prior.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: userMessage },
    ],
  })

  const assistantText =
    response.content[0].type === 'text' ? response.content[0].text : ''

  appendConversationMessage(db, conversationId, 'assistant', assistantText)
  return assistantText
}

export function getAIHistory(): { role: 'user' | 'assistant'; content: string }[] {
  const db = getDb()
  const conversationId = getOrCreateConversation(db)
  return getConversationMessages(db, conversationId)
}

export function clearAIHistory(): void {
  const db = getDb()
  const conversationId = getOrCreateConversation(db)
  clearConversation(db, conversationId)
}
