// The canonical Daylens read surface: every permitted read capability declared
// once, with the tool name each access path publishes it under, or the reason it
// is unavailable there.
//
// Two paths consume Daylens facts through tools: the local MCP server
// (packages/mcp-server) and the in-app chat agent (src/main/agent). Before this
// catalogue existed each kept its own list, so a capability could exist on one
// path and be silently missing on the other, and the same fact could be
// described two different ways to two models. The catalogue is declaration only
// — no database imports — so the MCP subprocess, the main process, and the drift
// tests all read the same file.
//
// A capability is never dropped by omission. If a path cannot serve it, the path
// records a reason, tests/daylensReadSurface.test.ts requires that reason to
// exist, and the MCP server publishes it through describeReadSurface.
import type { ToolName } from './aiTools'
import type { WrappedToolName } from './wrappedTools'

export type ReadSurfacePath = 'mcp' | 'chat'

/** Which dispatcher runs the capability body. `composed` capabilities have no
 *  executor entry of their own: their body is a shared reader that both paths
 *  call directly (moment evidence, the corrected page ledger, by-meaning
 *  search), still behind the same two exit boundaries. */
export type ReadCapabilityExecutor = 'activity' | 'wrapped' | 'composed'

/** JSON Schema subset the MCP manifest publishes. Kept structural rather than
 *  importing a schema library: this file must stay dependency-free so the MCP
 *  subprocess can load it. */
export interface ReadCapabilitySchema {
  type: 'object'
  properties: Record<string, object>
  required?: string[]
}

export interface ReadCapabilityPublished {
  toolName: string
}

export interface ReadCapabilityUnavailable {
  /** Why this path cannot serve the capability, in words a person or a model can
   *  act on. Never empty. */
  unavailable: string
}

export type ReadCapabilityPathStatus = ReadCapabilityPublished | ReadCapabilityUnavailable

export interface DaylensReadCapability {
  /** Stable identity across paths. For executor-bound capabilities this is the
   *  executor's own tool name, so drift between the catalogue and the executor
   *  is a name mismatch a test can catch. */
  id: string
  executor: ReadCapabilityExecutor
  description: string
  inputSchema: ReadCapabilitySchema
  paths: Record<ReadSurfacePath, ReadCapabilityPathStatus>
}

export function isPublished(status: ReadCapabilityPathStatus): status is ReadCapabilityPublished {
  return 'toolName' in status
}

const DATE_PARAM = {
  type: 'string',
  description: 'Local calendar date in YYYY-MM-DD format (e.g. "2026-04-21").',
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
}

const LIMIT_PARAM = {
  type: 'integer',
  description: 'Maximum number of results to return. Defaults to 25, capped at 100.',
  minimum: 1,
  maximum: 100,
}

const NO_ARTIFACT_SEARCH_IN_CHAT =
  'Not published on the chat tool surface: chat has no artifact-search tool.'

const CHAT_READS_FILES_THROUGH_GRANTS =
  'Not published on the chat tool surface: chat reaches files through the permissioned '
  + 'local-machine read tools, which enforce path policy and record disclosure.'

const CHAT_PUBLISHES_MOMENT_INSTEAD =
  'Not published on the chat tool surface: chat publishes getMoment, which returns the '
  + 'covering block plus the one page active at that minute.'

const WRAPPED_DEPTH_NOT_IN_CHAT =
  'Not published on the chat tool surface: this per-day wrapped read is served to the wrap '
  + 'and to MCP clients, and chat answers the same questions from the day overview.'

export const DAYLENS_READ_CAPABILITIES: readonly DaylensReadCapability[] = [
  // ─── Activity executor (executeTool) ──────────────────────────────────────
  {
    id: 'searchSessions',
    executor: 'composed',
    description:
      'Full-text search across app sessions and browser page visits by app name, window title, URL, and page title. '
      + 'Use this to find when the user worked in a specific app, on a specific project, studied a topic, consumed web '
      + 'pages, or saw a particular window/page title. Results are sorted by recency. When the on-device semantic index '
      + 'is available a separate semanticHits array carries moments found by MEANING; present those as "similar meaning" '
      + 'leads, never as exact matches.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Keywords to search for in app name and window title. '
            + 'Supports FTS5 operators: AND, OR, NOT, phrase quotes, prefix*.',
        },
        startDate: { ...DATE_PARAM, description: 'Restrict results to sessions starting on or after this date.' },
        endDate: { ...DATE_PARAM, description: 'Restrict results to sessions starting on or before this date.' },
        limit: LIMIT_PARAM,
      },
      required: ['query'],
    },
    paths: { mcp: { toolName: 'searchSessions' }, chat: { toolName: 'search_history' } },
  },
  {
    id: 'getDaySummary',
    executor: 'activity',
    description:
      'Return a structured summary of all tracked activity for a given calendar day: '
      + 'total time, top apps, top websites, timeline block labels, and focus metrics.',
    inputSchema: {
      type: 'object',
      properties: { date: { ...DATE_PARAM, description: 'The calendar day to summarize.' } },
      required: ['date'],
    },
    paths: { mcp: { toolName: 'getDaySummary' }, chat: { toolName: 'get_day_overview' } },
  },
  {
    id: 'getAppUsage',
    executor: 'activity',
    description:
      'Return total usage time for a specific application or website/domain, optionally filtered by date range. '
      + 'Also returns a per-day breakdown and recent window titles or page titles. '
      + 'Use this for domain-time questions (Coursera, YouTube, github.com) as well as apps. '
      + 'A site name is not an app: this lookup falls through to website time when the name is not an exact app.',
    inputSchema: {
      type: 'object',
      properties: {
        appName: {
          type: 'string',
          description:
            'App or website name to look up (case-insensitive, e.g. "Figma", "Coursera", "youtube.com").',
        },
        startDate: { ...DATE_PARAM, description: 'Start of the date range (inclusive).' },
        endDate: { ...DATE_PARAM, description: 'End of the date range (inclusive).' },
      },
      required: ['appName'],
    },
    paths: { mcp: { toolName: 'getAppUsage' }, chat: { toolName: 'get_app_usage' } },
  },
  {
    id: 'searchArtifacts',
    executor: 'activity',
    description:
      'Search AI-generated artifacts (reports, charts, CSVs, exports) by title and summary. '
      + 'Use this when the user asks about documents or files they generated via the AI.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to search in artifact title and summary text.' },
      },
      required: ['query'],
    },
    paths: { mcp: { toolName: 'searchArtifacts' }, chat: { unavailable: NO_ARTIFACT_SEARCH_IN_CHAT } },
  },
  {
    id: 'getWeekSummary',
    executor: 'activity',
    description:
      'Return a structured summary for a full calendar week (Mon–Sun): total time, focus percentage, top apps, '
      + 'per-day breakdown, best day, and most active day. Use this for questions about "last week", "this week", '
      + 'or week-over-week comparisons.',
    inputSchema: {
      type: 'object',
      properties: {
        weekStartDate: {
          ...DATE_PARAM,
          description:
            'The Monday that starts the target week in YYYY-MM-DD format. '
            + 'To get last week, subtract 7 days from today\'s Monday.',
        },
      },
      required: ['weekStartDate'],
    },
    paths: { mcp: { toolName: 'getWeekSummary' }, chat: { toolName: 'get_week_summary' } },
  },
  {
    id: 'getAttributionContext',
    executor: 'activity',
    description:
      'Return how much time the user has spent on a specific client or project, based on attribution rules and '
      + 'labeled work sessions. Use this for questions like "how long on ClientX" or "Daylens project time this month".',
    inputSchema: {
      type: 'object',
      properties: {
        entityName: {
          type: 'string',
          description:
            'Client or project name to look up. Partial, case-insensitive match. Examples: "ClientX", "Daylens", "acme".',
        },
      },
      required: ['entityName'],
    },
    paths: { mcp: { toolName: 'getAttributionContext' }, chat: { toolName: 'get_attribution' } },
  },
  {
    id: 'searchFileMentions',
    executor: 'activity',
    description:
      'Extract filename-like tokens from window title strings in the tracked sessions. Use this when the user asks '
      + 'which files, documents, or code files they had open. Results are INFERRED from title strings — not from '
      + 'file-system events — so always surface the note field to the user so they understand the evidence level.',
    inputSchema: {
      type: 'object',
      properties: {
        startDate: { ...DATE_PARAM, description: 'Restrict to sessions starting on or after this date.' },
        endDate: { ...DATE_PARAM, description: 'Restrict to sessions starting on or before this date.' },
      },
      required: [],
    },
    paths: { mcp: { toolName: 'searchFileMentions' }, chat: { unavailable: CHAT_READS_FILES_THROUGH_GRANTS } },
  },
  {
    id: 'getBlockAtTime',
    executor: 'activity',
    description:
      'Return the timeline work block covering a specific moment. Use this for questions like "what was I doing at 4pm" '
      + 'or "what happened yesterday at 3pm". Returns the covering block plus the app sessions overlapping it. '
      + 'If no block covers the moment, `found` is false — do not fabricate an answer.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { ...DATE_PARAM, description: 'Calendar day the moment falls on.' },
        time: {
          type: 'string',
          description: 'Local time in 24-hour HH:MM format (e.g. "16:00" for 4 pm, "09:30" for 9:30 am).',
          pattern: '^\\d{2}:\\d{2}$',
        },
      },
      required: ['date', 'time'],
    },
    paths: { mcp: { toolName: 'getBlockAtTime' }, chat: { unavailable: CHAT_PUBLISHES_MOMENT_INSTEAD } },
  },
  {
    id: 'listClients',
    executor: 'activity',
    description:
      'Return the list of clients Daylens knows about, optionally ranked by attributed time in a date range. '
      + 'Always returns the full client roster from the clients table as `clientRoster`, and additionally returns '
      + 'ranked usage in `attributedClients` when a date range is given or when the most recent week has attributed '
      + 'sessions. Use this for questions like "who are my clients", "list my clients this month".',
    inputSchema: {
      type: 'object',
      properties: {
        startDate: {
          ...DATE_PARAM,
          description: 'Start of the attribution window (inclusive). Optional — omit for the full client roster.',
        },
        endDate: {
          ...DATE_PARAM,
          description: 'End of the attribution window (inclusive). Optional — omit for the full client roster.',
        },
      },
      required: [],
    },
    paths: { mcp: { toolName: 'listClients' }, chat: { toolName: 'list_clients' } },
  },

  // ─── Wrapped executor (executeWrappedTool) ────────────────────────────────
  {
    id: 'getWindowTitleContext',
    executor: 'wrapped',
    description:
      'The window titles from one app on one day, clustered into semantic groups that describe what the user was '
      + 'doing ("SPCS Build Proposal, 9 sessions") — humanized descriptions, never raw titles. '
      + 'Use this to say WHAT was being done inside an app, not just how long the app was open.',
    inputSchema: {
      type: 'object',
      properties: {
        date: DATE_PARAM,
        appName: { type: 'string', description: 'App to inspect ("Cursor", "Safari"). Loose matching is applied.' },
      },
      required: ['date', 'appName'],
    },
    paths: { mcp: { toolName: 'getWindowTitleContext' }, chat: { unavailable: WRAPPED_DEPTH_NOT_IN_CHAT } },
  },
  {
    id: 'getGitActivity',
    executor: 'wrapped',
    description:
      'Git activity for a day from the user\'s local repositories: repos touched, commit counts, commit subjects, '
      + 'and PR activity when the gh CLI is available. Returns null when git has nothing for the day.',
    inputSchema: { type: 'object', properties: { date: DATE_PARAM }, required: ['date'] },
    paths: { mcp: { toolName: 'getGitActivity' }, chat: { toolName: 'get_git_activity' } },
  },
  {
    id: 'getCalendarEvents',
    executor: 'wrapped',
    description:
      'Calendar events for a day: meeting names, durations, and attendee counts (never attendee names). '
      + 'Returns null when no calendar source is available.',
    inputSchema: { type: 'object', properties: { date: DATE_PARAM }, required: ['date'] },
    paths: { mcp: { toolName: 'getCalendarEvents' }, chat: { toolName: 'get_calendar_events' } },
  },
  {
    id: 'getDayComparison',
    executor: 'wrapped',
    description:
      'This day\'s tracked time against the user\'s own 7-day rolling average and the same weekday last week. '
      + 'The evidence behind "this was a long one".',
    inputSchema: { type: 'object', properties: { date: DATE_PARAM }, required: ['date'] },
    paths: { mcp: { toolName: 'getDayComparison' }, chat: { unavailable: WRAPPED_DEPTH_NOT_IN_CHAT } },
  },
  {
    id: 'getLongestFocusStretch',
    executor: 'wrapped',
    description:
      'The single longest unbroken focused work stretch of the day: start, end, duration, primary app, and the '
      + 'work it was, when a clean name exists.',
    inputSchema: { type: 'object', properties: { date: DATE_PARAM }, required: ['date'] },
    paths: { mcp: { toolName: 'getLongestFocusStretch' }, chat: { toolName: 'get_longest_focus_stretch' } },
  },
  {
    id: 'getDistractionProfile',
    executor: 'wrapped',
    description:
      'The split between high-distraction (leisure) and low-distraction time for a day, plus which distraction '
      + 'sites appeared and for how long. Facts, never a score or grade.',
    inputSchema: { type: 'object', properties: { date: DATE_PARAM }, required: ['date'] },
    paths: { mcp: { toolName: 'getDistractionProfile' }, chat: { unavailable: WRAPPED_DEPTH_NOT_IN_CHAT } },
  },
  {
    id: 'getMostSurprisingFact',
    executor: 'wrapped',
    description:
      'The single most likely-to-surprise true data point of the day, judged against the user\'s own baseline: '
      + 'the forgotten app, an unusually early or late session, a stretch record, a volume outlier. '
      + 'Returns null on a day with nothing genuinely surprising.',
    inputSchema: { type: 'object', properties: { date: DATE_PARAM }, required: ['date'] },
    paths: { mcp: { toolName: 'getMostSurprisingFact' }, chat: { unavailable: WRAPPED_DEPTH_NOT_IN_CHAT } },
  },

  // ─── Composed over shared readers ─────────────────────────────────────────
  {
    id: 'getMoment',
    executor: 'composed',
    description:
      'What was actually on screen at one specific clock time: the ONE page or video active at that minute (never the '
      + 'whole block), the covering timeline block, and all visits overlapping that minute. Use for "what was I '
      + 'watching at 3pm" and to break an hour into increments by calling it once per increment.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { ...DATE_PARAM, description: 'Calendar day the moment falls on.' },
        time: {
          type: 'string',
          description: 'Local time in 24-hour HH:MM format (e.g. "16:00" for 4 pm).',
          pattern: '^\\d{1,2}:\\d{2}$',
        },
      },
      required: ['date', 'time'],
    },
    paths: { mcp: { toolName: 'getMoment' }, chat: { toolName: 'get_moment' } },
  },
  {
    id: 'listPageVisits',
    executor: 'composed',
    description:
      'Website visits over a date range, aggregated per page: title, URL, domain, total time, visit count, and first '
      + 'and last seen. Filter by domain or by title words. Time is the reconciled seconds the page was in front of '
      + 'the person, the same ledger the Apps screen totals, NOT the media\'s own length. When coverageNotes is '
      + 'present, page detail explains less time than the browser verifiably had; quote the note instead of '
      + 'presenting the page list as complete.',
    inputSchema: {
      type: 'object',
      properties: {
        startDate: { ...DATE_PARAM, description: 'First day of the range (inclusive).' },
        endDate: { ...DATE_PARAM, description: 'Last day of the range (inclusive). At most 62 days after startDate.' },
        domainContains: {
          type: 'string',
          description: 'Case-insensitive substring match on domain, e.g. "youtube".',
        },
        titleContains: { type: 'string', description: 'Case-insensitive substring match on page title.' },
        limit: {
          type: 'integer',
          description: 'Max aggregated pages returned, default 500, ordered by total time.',
          minimum: 1,
          maximum: 500,
        },
      },
      required: ['startDate', 'endDate'],
    },
    paths: { mcp: { toolName: 'listPageVisits' }, chat: { toolName: 'list_page_visits' } },
  },
  {
    id: 'getTimeChunks',
    executor: 'composed',
    description:
      'Return a complete time span as exact consecutive increments, including captured apps and pages and explicit '
      + 'asleep, locked, idle, or possible tracking-failure gaps. Use for every request to break a day or span into '
      + 'N-minute chunks.',
    inputSchema: {
      type: 'object',
      properties: {
        date: DATE_PARAM,
        startTime: { type: 'string', description: 'Local 24-hour HH:MM start, default "00:00".' },
        endTime: { type: 'string', description: 'Local 24-hour HH:MM end, default "24:00".' },
        incrementMinutes: { type: 'integer', description: 'Increment length in minutes.', minimum: 5, maximum: 120 },
      },
      required: ['date', 'incrementMinutes'],
    },
    paths: {
      mcp: {
        unavailable:
          'The increment builder lives in the chat tool module and is not yet a shared read service, and duplicating '
          + 'it here would fork a derived activity view. Call getMoment once per increment for the same evidence.',
      },
      chat: { toolName: 'get_time_chunks' },
    },
  },
  {
    id: 'readMeetingNotes',
    executor: 'composed',
    description:
      'Granola meeting notes from the local cache: recent meetings by title and date, or one meeting\'s structured '
      + 'notes. Gated by the Granola access switch in Settings.',
    inputSchema: {
      type: 'object',
      properties: {
        meetingId: { type: 'string', description: 'A meeting id from a previous listing call.' },
        startDate: DATE_PARAM,
        endDate: DATE_PARAM,
      },
      required: [],
    },
    paths: {
      mcp: {
        unavailable:
          'Meeting-note bodies are high-sensitivity content governed by the in-app Granola access policy, and are not '
          + 'published across the external MCP boundary. Meeting names and times are available through getCalendarEvents.',
      },
      chat: { toolName: 'read_meeting_notes' },
    },
  },
]

/** Every executor tool name, as an exhaustive record over both executor unions:
 *  adding a tool to `executeTool` or `executeWrappedTool` fails to compile here
 *  until it is listed, and tests/daylensReadSurface.test.ts then requires a
 *  matching capability above. Together they are the single compatibility review
 *  ADR-002 asks for. */
export const EXECUTOR_TOOL_IDS = {
  searchSessions: true,
  getDaySummary: true,
  getAppUsage: true,
  searchArtifacts: true,
  getWeekSummary: true,
  getAttributionContext: true,
  searchFileMentions: true,
  getBlockAtTime: true,
  listClients: true,
  getWindowTitleContext: true,
  getGitActivity: true,
  getCalendarEvents: true,
  getDayComparison: true,
  getLongestFocusStretch: true,
  getDistractionProfile: true,
  getMostSurprisingFact: true,
} satisfies Record<ToolName | WrappedToolName, true>

export function capabilitiesForPath(path: ReadSurfacePath): DaylensReadCapability[] {
  return DAYLENS_READ_CAPABILITIES.filter((capability) => isPublished(capability.paths[path]))
}

export function unavailableForPath(path: ReadSurfacePath): Array<{ id: string; reason: string }> {
  const out: Array<{ id: string; reason: string }> = []
  for (const capability of DAYLENS_READ_CAPABILITIES) {
    const status = capability.paths[path]
    if (!isPublished(status)) out.push({ id: capability.id, reason: status.unavailable })
  }
  return out
}

/** Look a capability up by the name a path publishes it under. */
export function capabilityByToolName(
  path: ReadSurfacePath,
  toolName: string,
): DaylensReadCapability | undefined {
  return DAYLENS_READ_CAPABILITIES.find((capability) => {
    const status = capability.paths[path]
    return isPublished(status) && status.toolName === toolName
  })
}

export function capabilityById(id: string): DaylensReadCapability | undefined {
  return DAYLENS_READ_CAPABILITIES.find((capability) => capability.id === id)
}

export interface ReadSurfaceReport {
  path: ReadSurfacePath
  available: Array<{ id: string; toolName: string; description: string }>
  unavailable: Array<{ id: string; reason: string }>
}

/** The self-description a client reads to learn what this path can and cannot
 *  answer, so a capability missing here is a stated gap rather than a silence. */
export function readSurfaceReport(path: ReadSurfacePath): ReadSurfaceReport {
  return {
    path,
    available: capabilitiesForPath(path).map((capability) => {
      const status = capability.paths[path] as ReadCapabilityPublished
      return { id: capability.id, toolName: status.toolName, description: capability.description }
    }),
    unavailable: unavailableForPath(path),
  }
}
