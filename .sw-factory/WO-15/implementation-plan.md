<!--lint disable no-undefined-references strong-marker-->

# Implementation Plan: WO-15

**Work Order:** WO-15 — [backend] Establish the canonical Daylens MCP read surface
**Created At (UTC):** 2026-08-11T08:38:20Z

## Summary

Declare the permitted Daylens read capabilities once, in one catalogue, and make
both the local MCP manifest and the compatibility tests derive from it. Every
capability records, per access path, either the tool name it is published under
or the reason it is unavailable there, so a capability can never go missing
silently. The MCP path gains the three capabilities it was missing that can be
adapted from already-shared readers (moment evidence, the corrected page-visit
ledger, by-meaning search), and publishes a `describeReadSurface` tool so a
client can see the surface and its gaps.

## Code Reuse And Package Structure

Reused rather than rebuilt. Nothing here defines a new Daylens fact; every
capability body is an existing shared reader:

- `src/main/services/aiTools.ts` — `executeTool`, `ToolName`,
  `execSearchSessionsWithMeaning`. The activity executor and its exit boundary
  (`filterTrackingExcludedEvidence` then `sanitizeToolResult`) stay the only
  place activity reads are dispatched.
- `src/main/services/wrappedTools.ts` — `executeWrappedTool`, `WrappedToolName`,
  `WRAPPED_TOOL_NAMES`.
- `src/main/lib/momentEvidence.ts` — `getMomentEvidence`, the same body the chat
  `get_moment` tool calls.
- `src/main/services/activityFacts.ts` — `getCorrectedPageFactsForRange`,
  `browserPageCoverageNotes`. The page aggregation (totals, visit counts, first
  and last seen) already happens here, so both surfaces filter one aggregate
  rather than each summing visits.
- `src/shared/aiSanitize.ts`, `src/shared/evidencePrivacy.ts` — the two-boundary
  exit path, applied by the composed adapters exactly as the executors apply it.
- `tests/support/testDatabase.ts`, `tests/support/dayFixture.ts`,
  `tests/support/captureDay.ts` — the existing production-database fixture path
  for the cross-surface parity test.

Created:

- `src/main/services/daylensReadSurface.ts` — the catalogue. Declarative only:
  ids, model-facing descriptions, one input schema per capability, executor
  binding, and per-path availability. No database imports, so both the main
  process and the MCP subprocess can read it.
- `packages/mcp-server/src/composedReads.ts` — the adapters for capabilities
  whose body is a shared reader rather than an executor dispatch.
- `packages/mcp-server/src/dispatch.ts` — one entry point from an MCP tool name
  to a capability call, including the honest error for a capability that exists
  but is unavailable on this path.
- `tests/daylensReadSurface.test.ts`, `tests/mcpReadSurfaceParity.test.ts`.

Modified:

- `packages/mcp-server/src/tools.ts` — the manifest becomes a projection of the
  catalogue instead of a hand-kept second list.
- `packages/mcp-server/src/index.ts` — list and call through the manifest and
  the dispatcher.

Not touched, recorded as cross-lane dependencies in `review-log.md`:
`src/main/agent/daylensTools.ts`, `src/main/agent/contextTools.ts`.

## Components And Flow

#DaylensToolExecutor keeps its role from the blueprint: it supplies the canonical
read surface. This work order adds the missing declaration of that surface, so
"canonical" is checkable rather than asserted.

```
daylensReadSurface.ts  (declaration: capability -> executor + per-path status)
        |                                   |
        v                                   v
packages/mcp-server/tools.ts        tests/daylensReadSurface.test.ts
  (ListTools manifest)                (drift guard against both surfaces)
        |
        v
packages/mcp-server/dispatch.ts
        |
   +----+-------------------+---------------------------+
   v                        v                           v
executeTool           executeWrappedTool          composedReads
(activity)            (allowCollect: false)       (shared readers)
```

`DaylensReadCapability`:

```ts
interface DaylensReadCapability {
  id: string
  executor: 'activity' | 'wrapped' | 'composed'
  description: string
  inputSchema: ReadCapabilitySchema
  paths: Record<'mcp' | 'chat', { toolName: string } | { unavailable: string }>
}
```

`capabilitiesForPath(path)` returns the published set; `unavailableForPath(path)`
returns `{ id, reason }` for the rest. A capability unavailable on both paths is
not a capability, and the drift test rejects it.

Per-path status as it lands (21 capabilities):

| capability | mcp | chat |
| --- | --- | --- |
| searchSessions | `searchSessions` | `search_history` |
| getDaySummary | `getDaySummary` | `get_day_overview` |
| getAppUsage | `getAppUsage` | `get_app_usage` |
| getWeekSummary | `getWeekSummary` | `get_week_summary` |
| getAttributionContext | `getAttributionContext` | `get_attribution` |
| listClients | `listClients` | `list_clients` |
| searchArtifacts | `searchArtifacts` | unavailable |
| searchFileMentions | `searchFileMentions` | unavailable |
| getBlockAtTime | `getBlockAtTime` | unavailable |
| getGitActivity | `getGitActivity` | `get_git_activity` |
| getCalendarEvents | `getCalendarEvents` | `get_calendar_events` |
| getLongestFocusStretch | `getLongestFocusStretch` | `get_longest_focus_stretch` |
| getWindowTitleContext | `getWindowTitleContext` | unavailable |
| getDayComparison | `getDayComparison` | unavailable |
| getDistractionProfile | `getDistractionProfile` | unavailable |
| getMostSurprisingFact | `getMostSurprisingFact` | unavailable |
| getMoment | `getMoment` (new) | `get_moment` |
| listPageVisits | `listPageVisits` (new) | `list_page_visits` |
| searchSessionsByMeaning | folded into `searchSessions` | folded into `search_history` |
| getTimeChunks | unavailable | `get_time_chunks` |
| readMeetingNotes | unavailable | `read_meeting_notes` |

`searchSessions` on the MCP path calls `execSearchSessionsWithMeaning`, the same
body chat's `search_history` calls, so exact and by-meaning retrieval are one
capability on both paths rather than two different searches. The by-meaning half
is best-effort inside that function: it returns exact results alone when the
on-device index or embedder is unavailable, which is what a read-only handle
gives it.

Two capabilities are unavailable on the MCP path, both recorded with a reason a
client can read:

- `getTimeChunks` — the increment builder lives inside
  `src/main/agent/daylensTools.ts`, another lane's file. Duplicating it would
  fork a derived activity view, which the blueprint forbids, so the capability
  is declared unavailable and the reason names `getMoment` as the per-increment
  path. Moving the builder into a shared read service is the cross-lane ask.
- `readMeetingNotes` — meeting-note bodies are high-sensitivity content behind
  the in-app Granola access policy; this wave does not publish them across the
  external MCP boundary.

## Steps

1. **Declare the catalogue** — `src/main/services/daylensReadSurface.ts`: the
   capability type, the 21 entries with the schemas moved out of the MCP
   manifest, and `capabilitiesForPath` / `unavailableForPath` /
   `readSurfaceReport`.
2. **Project the MCP manifest** — `packages/mcp-server/src/tools.ts` keeps its
   `AnthropicTool` shape and its exported names, built from
   `capabilitiesForPath('mcp')` plus the `describeReadSurface` meta tool.
3. **Adapt the composed capabilities** — `packages/mcp-server/src/composedReads.ts`:
   `getMoment` over `getMomentEvidence`, `listPageVisits` over
   `getCorrectedPageFactsForRange` + `browserPageCoverageNotes`, `searchSessions`
   over `execSearchSessionsWithMeaning`. Each applies the same two exit
   boundaries as the executors.
4. **One dispatch** — `packages/mcp-server/src/dispatch.ts` maps an MCP tool name
   to its capability and executor; an unknown name that IS a known capability
   fails with the recorded unavailability reason instead of "unknown tool".
   `index.ts` lists and calls through it.
5. **Guard the drift** — `tests/daylensReadSurface.test.ts` over both executor
   name unions and both surfaces' real tool sets.
6. **Prove the parity** — `tests/mcpReadSurfaceParity.test.ts` on a fixture day:
   the MCP result and the chat result for the same question are the same object.

## Testing

`tests/daylensReadSurface.test.ts`

- every `ToolName` and every `WrappedToolName` is declared exactly once, and
  every declared executor-bound capability names a real executor tool (fails when
  an executor gains or loses a tool without a compatibility review);
- every tool in `buildDaylensTools(db)` and `buildContextTools(db)` is declared
  chat-available, and every chat-available capability names a tool that exists in
  that set (fails in both drift directions);
- the MCP manifest equals `capabilitiesForPath('mcp')` plus `describeReadSurface`;
- every unavailable entry carries a non-empty reason, and no capability is
  unavailable on both paths;
- `describeReadSurface` output names each unavailable capability and its reason.

`tests/mcpReadSurfaceParity.test.ts` — one fixture day driven through
`driveCaptureDay` into a production test database, then per capability:

- `getAppUsage`, `getMoment`, `listPageVisits`: the MCP dispatch result deep-equals
  the chat tool result;
- `getDaySummary`: the MCP result deep-equals the chat `get_day_overview` result
  with the documented capture-state superset removed;
- `getTimeChunks` through the MCP dispatcher fails with its recorded reason
  rather than an unknown-tool error.

Commands:

```bash
npm run typecheck && npm run lint
node scripts/run-tests.mjs daylensReadSurface mcpReadSurfaceParity mcpServerSafety mcpDatabaseStub repositoryBoundary
```

Manual: the server is exercised from a real MCP client at the end of the lane
(recorded in `review-log.md` under User-Facing Verification), because a passing
in-process test does not prove a stdio handshake.
