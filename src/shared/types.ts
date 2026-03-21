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
  sessionCount?: number   // populated from DB queries; absent for live/synthetic entries
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

export interface WebsiteSummary {
  domain: string
  totalSeconds: number
  visitCount: number
  topTitle: string | null
  browserBundleId: string | null
}

export type AppTheme = 'system' | 'light' | 'dark'

export interface AppSettings {
  anthropicApiKey: string
  launchOnLogin: boolean
  theme: AppTheme
  onboardingComplete: boolean
  userName: string
  userGoals: string[]
  dailyFocusGoalHours: number
  firstLaunchDate: number       // Unix ms — set on first launch, used for day-7 feedback prompt
  feedbackPromptShown: boolean  // true once the day-7 prompt has been shown
}

// In-flight session that has not yet been flushed to the DB.
// Exposed via IPC so the renderer can merge it into Today's display totals.
export interface LiveSession {
  bundleId: string
  appName: string
  startTime: number   // Unix ms
  category: AppCategory
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
    GET_APP_SESSIONS: 'db:get-app-sessions',
    GET_WEBSITE_SUMMARIES: 'db:get-website-summaries',
  },
  DEBUG: {
    GET_INFO: 'debug:get-info',
  },
  FOCUS: {
    START: 'focus:start',
    STOP: 'focus:stop',
    GET_ACTIVE: 'focus:get-active',
    GET_RECENT: 'focus:get-recent',
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
  TRACKING: {
    GET_LIVE: 'tracking:get-live',
  },
  SYNC: {
    GET_STATUS: 'sync:get-status',
    LINK: 'sync:link',
    CREATE_BROWSER_LINK: 'sync:create-browser-link',
    DISCONNECT: 'sync:disconnect',
    GET_MNEMONIC: 'sync:get-mnemonic',
  },
  SHELL: {
    OPEN_EXTERNAL: 'shell:open-external',
  },
} as const
