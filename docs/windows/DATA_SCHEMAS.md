# Data Schemas

This document defines the cross-platform JSON contract for Daylens shared data models.

Two important notes:

1. Several of these Swift structs are currently in-memory view models, not `Codable` types (`AppUsageSummary`, `WebsiteUsageSummary`, `WorkContextBlock`). This doc standardizes their JSON shape anyway so the Windows app can implement the same contract.
2. For cross-platform interoperability, all `Date` values should be serialized as ISO8601 strings with timezone offsets. The field names below match the Swift property names exactly.

## `AppSession`

| Field name | Type | Nullable | Example value | Notes |
|------|------|----------|---------------|-------|
| `id` | integer | Yes | `1842` | Database row id; `null` before insert. |
| `date` | string (ISO8601 datetime) | No | `2026-03-26T00:00:00+02:00` | Logical local start-of-day for the session. |
| `bundleID` | string | No | `com.google.Chrome` | On Windows this stays the same field name but contains a Windows surrogate identifier. |
| `appName` | string | No | `Google Chrome` | Human-readable app name. |
| `startTime` | string (ISO8601 datetime) | No | `2026-03-26T09:12:04+02:00` | Session start. |
| `endTime` | string (ISO8601 datetime) | No | `2026-03-26T09:34:40+02:00` | Session end. |
| `duration` | number | No | `1356.0` | Seconds. |
| `category` | `AppCategory` | No | `Browsing` | Stored as the enum raw string. |
| `isBrowser` | boolean | No | `true` | True only for primary browsers. |

## `AppUsageSummary`

| Field name | Type | Nullable | Example value | Notes |
|------|------|----------|---------------|-------|
| `bundleID` | string | No | `com.apple.dt.Xcode` | Stable app identifier. |
| `appName` | string | No | `Xcode` | Human-readable app name. |
| `totalDuration` | number | No | `14400.0` | Total seconds across all merged sessions for the day. |
| `sessionCount` | integer | No | `7` | Number of contributing sessions. |
| `category` | `AppCategory` | No | `Development` | Post-override category. |
| `isBrowser` | boolean | No | `false` | Same meaning as `AppSession.isBrowser`. |

## `WebsiteUsageSummary`

| Field name | Type | Nullable | Example value | Notes |
|------|------|----------|---------------|-------|
| `domain` | string | No | `github.com` | Normalized host, usually without `www.`. |
| `totalDuration` | number | No | `4200.0` | Total seconds attributed to the domain. |
| `visitCount` | integer | No | `12` | Number of visits/intervals contributing to the total. |
| `topPageTitle` | string | Yes | `Pull requests · irachrist1/daylens` | Most representative page title for the domain. |
| `confidence` | string | No | `high` | Uses `ActivityEvent.ConfidenceLevel` raw values: `high`, `medium`, `low`. |
| `browserName` | string | No | `Chrome` | Friendly browser name. |

## `WorkContextBlock`

Stored/computed properties only. Computed Swift helpers like `duration` and `displayLabel` are not separate JSON fields.

| Field name | Type | Nullable | Example value | Notes |
|------|------|----------|---------------|-------|
| `id` | string (UUID) | No | `1A5A1B54-4D2C-4A44-8A59-9B7DCD4F0A3B` | UUID string. |
| `startTime` | string (ISO8601 datetime) | No | `2026-03-26T09:00:00+02:00` | Block start. |
| `endTime` | string (ISO8601 datetime) | No | `2026-03-26T10:30:00+02:00` | Block end. |
| `dominantCategory` | `AppCategory` | No | `Development` | Dominant category after grouping heuristics. |
| `categoryDistribution` | object | No | `{"Development":5400,"Research":900}` | Keys are `AppCategory` raw strings; values are seconds. |
| `ruleBasedLabel` | string | No | `Building & Testing` | Deterministic fallback label. |
| `aiLabel` | string | Yes | `Fixing Build Errors` | Optional AI-enhanced label. |
| `sessions` | array of `AppSession` | No | `[{"id":1842,"date":"2026-03-26T00:00:00+02:00","bundleID":"com.apple.dt.Xcode","appName":"Xcode","startTime":"2026-03-26T09:00:00+02:00","endTime":"2026-03-26T09:45:00+02:00","duration":2700,"category":"Development","isBrowser":false}]` | Ordered chronologically. |
| `topApps` | array of `AppUsageSummary` | No | `[{"bundleID":"com.apple.dt.Xcode","appName":"Xcode","totalDuration":5400,"sessionCount":3,"category":"Development","isBrowser":false}]` | Up to 3 aggregated apps. |
| `websites` | array of `WebsiteUsageSummary` | No | `[{"domain":"github.com","totalDuration":1200,"visitCount":4,"topPageTitle":"Pull Requests","confidence":"high","browserName":"Chrome"}]` | Added during block enrichment. |
| `switchCount` | integer | No | `5` | App switches inside the block. |
| `confidence` | `BlockConfidence` | No | `medium` | Lowercase string contract. |
| `isLive` | boolean | No | `false` | True only for in-progress UI-only blocks. |

## `DailySummary`

| Field name | Type | Nullable | Example value | Notes |
|------|------|----------|---------------|-------|
| `id` | integer | Yes | `29` | Database row id; `null` before insert. |
| `date` | string (ISO8601 datetime) | No | `2026-03-26T00:00:00+02:00` | Logical local day start. |
| `totalActiveTime` | number | No | `28800.0` | Seconds. |
| `totalIdleTime` | number | No | `0.0` | Seconds; current tracker leaves this at zero. |
| `appCount` | integer | No | `11` | Distinct apps used that day. |
| `browserCount` | integer | No | `2` | Distinct browsers used that day. |
| `domainCount` | integer | No | `17` | Distinct domains visited that day. |
| `sessionCount` | integer | No | `32` | Number of meaningful sessions in the day timeline. |
| `contextSwitches` | integer | No | `31` | Usually `sessionCount - 1`. |
| `focusScore` | number | No | `0.67` | Float from `0.0` to `1.0`. |
| `longestFocusStreak` | number | No | `5400.0` | Seconds. |
| `topAppBundleID` | string | Yes | `com.apple.dt.Xcode` | Top app for the day if available. |
| `topDomain` | string | Yes | `github.com` | Top domain if available. |
| `aiSummary` | string | Yes | `You spent most of the day in Development and Research...` | Cached AI-generated daily summary. |
| `aiSummaryGeneratedAt` | string (ISO8601 datetime) | Yes | `2026-03-26T19:02:10+02:00` | Timestamp of the last AI summary generation. |

## `UserProfile`

| Field name | Type | Nullable | Example value | Notes |
|------|------|----------|---------------|-------|
| `id` | integer | Yes | `1` | Database row id; `null` before insert. |
| `name` | string | No | `Ira` | User-facing first name or preferred name. |
| `role` | string | No | `founder` | Free-form string; DB default is `other`. |
| `goals` | string | No | `deep_focus` | Free-form string; DB default is `deep_focus`. |
| `workHoursStart` | integer | No | `9` | 24-hour clock hour. |
| `workHoursEnd` | integer | No | `18` | 24-hour clock hour. |
| `idealDayDescription` | string | No | `Long morning build blocks, lighter admin after lunch.` | Free-form description. |
| `biggestDistraction` | string | Yes | `Slack` | Optional distraction hint used in prompts. |
| `createdAt` | string (ISO8601 datetime) | No | `2026-03-25T08:15:00+02:00` | Creation time. |
| `updatedAt` | string (ISO8601 datetime) | No | `2026-03-26T07:45:00+02:00` | Last update time. |

## `UserMemory`

| Field name | Type | Nullable | Example value | Notes |
|------|------|----------|---------------|-------|
| `id` | integer | Yes | `7` | Database row id; `null` before insert. |
| `fact` | string | No | `They do their best coding in long uninterrupted morning blocks.` | One durable factual sentence. |
| `source` | string | No | `chat` | Current default source is `chat`. |
| `createdAt` | string (ISO8601 datetime) | No | `2026-03-26T10:22:54+02:00` | Creation time. |

## `GeneratedReport`

| Field name | Type | Nullable | Example value | Notes |
|------|------|----------|---------------|-------|
| `id` | integer | Yes | `14` | Database row id; `null` before insert. |
| `reportType` | string | No | `daily` | Current source uses `daily` and `weekly`. |
| `periodStart` | string (ISO8601 datetime) | No | `2026-03-26T00:00:00+02:00` | Inclusive period start. |
| `periodEnd` | string (ISO8601 datetime) | No | `2026-03-26T23:59:59+02:00` | Inclusive/effective period end used by the report. |
| `markdownContent` | string | No | `## Daily Report - Thursday, March 26...` | Markdown body. |
| `generatedByAI` | boolean | No | `false` | `true` after AI enhancement. |
| `createdAt` | string (ISO8601 datetime) | No | `2026-03-26T19:10:00+02:00` | Report creation timestamp. |

## `BlockConfidence` enum values

| JSON value | Meaning |
|------|---------|
| `high` | Strongly coherent block bounded by gaps on both sides. |
| `medium` | Default confidence when not clearly high or low. |
| `low` | Fragmented, low-coherence block with heavy switching. |

## `AppCategory` enum values

Use the exact Swift raw strings below.

| JSON value |
|------------|
| `Development` |
| `Communication` |
| `Research` |
| `Writing` |
| `AI Tools` |
| `Design` |
| `Browsing` |
| `Meetings` |
| `Entertainment` |
| `Email` |
| `Productivity` |
| `Social` |
| `System` |
| `Uncategorized` |
