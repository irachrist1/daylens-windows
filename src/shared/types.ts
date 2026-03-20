// ---------------------------------------------------------------------------
// Shared types — imported by both main and renderer via path alias @shared/*
// ---------------------------------------------------------------------------

export interface AppSession {
  id: number
  bundleId: string          // exe name on Windows, bundle ID on macOS
  appName: string
  startTime: number         // Unix ms
  endTime: number | null
  durationSeconds: number
  category: AppCategory
  isFocused: boolean
}

export interface DailySummary {
  date: string              // YYYY-MM-DD
  totalTrackedSeconds: number
  focusSeconds: number
  topApps: AppUsageSummary[]
}

export interface AppUsageSummary {
  bundleId: string
  appName: string
  category: AppCategory
  totalSeconds: number
  isFocused: boolean
}

export interface FocusSession {
  id: number
  startTime: number
  endTime: number | null
  durationSeconds: number
  label: string | null
}

export interface AIConversation {
  id: number
  messages: AIMessage[]
  createdAt: number
}

export interface AIMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

export interface AppSettings {
  anthropicApiKey: string
  launchOnLogin: boolean
  trackingEnabled: boolean
}

export type AppCategory =
  | 'development'
  | 'communication'
  | 'research'
  | 'writing'
  | 'aiTools'
  | 'design'
  | 'browsing'
  | 'meetings'
  | 'entertainment'
  | 'email'
  | 'productivity'
  | 'social'
  | 'system'
  | 'uncategorized'

export const FOCUSED_CATEGORIES: AppCategory[] = [
  'development',
  'research',
  'writing',
  'aiTools',
  'design',
  'productivity',
]

// IPC channel names — single source of truth
export const IPC = {
  DB: {
    GET_TODAY: 'db:get-today',
    GET_HISTORY: 'db:get-history',
    GET_APP_SUMMARIES: 'db:get-app-summaries',
  },
  FOCUS: {
    START: 'focus:start',
    STOP: 'focus:stop',
    GET_ACTIVE: 'focus:get-active',
  },
  AI: {
    SEND_MESSAGE: 'ai:send-message',
    GET_HISTORY: 'ai:get-history',
    CLEAR_HISTORY: 'ai:clear-history',
  },
  SETTINGS: {
    GET: 'settings:get',
    SET: 'settings:set',
  },
} as const
