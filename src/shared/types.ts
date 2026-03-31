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
  targetMinutes: number | null
  plannedApps: string[]
}

export interface FocusStartPayload {
  label?: string | null
  targetMinutes?: number | null
  plannedApps?: string[]
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

export interface PeakHoursResult {
  peakStart: number
  peakEnd: number
  focusPct: number
}

export interface WeeklySummary {
  totalTrackedSeconds: number
  totalFocusSeconds: number
  focusPct: number
  avgFocusScore: number
  bestDay: { date: string; focusPct: number } | null
  mostActiveDay: { date: string; totalSeconds: number } | null
  topApps: { appName: string; bundleId: string; totalSeconds: number; category: AppCategory }[]
  dailyBreakdown: {
    date: string
    focusSeconds: number
    totalSeconds: number
    focusScore: number
  }[]
}

export interface AppCharacter {
  character:
    | 'deep_focus'
    | 'flow_compatible'
    | 'context_switching'
    | 'distraction'
    | 'communication'
    | 'neutral'
  label: string
  confidence: number
  avgSessionMinutes: number
  sessionCount: number
}

export interface BreakRecommendation {
  triggerReason: 'sustained_focus'
  focusedMinutes: number
  currentApp: string | null
  message: string
  urgency: 'medium' | 'high'
}

export type AIProvider = 'anthropic' | 'openai' | 'google'

export interface ProcessSnapshot {
  pid: number
  name: string
  cpuPercent: number
  memoryMb: number
  capturedAt: number
}

export type AppTheme = 'system' | 'light' | 'dark'

export interface AppSettings {
  // Provider API keys are stored in OS keychain via keytar (never in plain-text)
  analyticsOptIn: boolean       // false = no telemetry (default)
  launchOnLogin: boolean
  theme: AppTheme
  onboardingComplete: boolean
  userName: string
  userGoals: string[]
  dailyFocusGoalHours: number
  firstLaunchDate: number       // Unix ms — set on first launch, used for day-7 feedback prompt
  feedbackPromptShown: boolean  // true once the day-7 prompt has been shown
  aiProvider: AIProvider
  anthropicModel: string
  openaiModel: string
  googleModel: string
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
    GET_PEAK_HOURS: 'db:get-peak-hours',
    GET_WEEKLY_SUMMARY: 'db:get-weekly-summary',
    GET_APP_CHARACTER: 'db:get-app-character',
  },
  DEBUG: {
    GET_INFO: 'debug:get-info',
  },
  FOCUS: {
    START: 'focus:start',
    STOP: 'focus:stop',
    GET_ACTIVE: 'focus:get-active',
    GET_RECENT: 'focus:get-recent',
    GET_BREAK_RECOMMENDATION: 'focus:get-break-recommendation',
  },
  AI: {
    SEND_MESSAGE: 'ai:send-message',
    GET_HISTORY: 'ai:get-history',
    CLEAR_HISTORY: 'ai:clear-history',
  },
  SETTINGS: {
    GET: 'settings:get',
    SET: 'settings:set',
    HAS_API_KEY: 'settings:has-api-key',
    SET_API_KEY: 'settings:set-api-key',
    CLEAR_API_KEY: 'settings:clear-api-key',
  },
  TRACKING: {
    GET_LIVE: 'tracking:get-live',
    GET_PROCESS_METRICS: 'tracking:get-process-metrics',
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
