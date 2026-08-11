<!--lint disable strong-marker-->

# Review Log: WO-15

**Work Order:** WO-15 — [backend] Establish the canonical Daylens MCP read surface
**Initialized At (UTC):** 2026-08-11T08:38:20Z

This file records review and verification rounds. Append new rounds; do not overwrite prior rounds.

---

## Round 1

### Requirements Alignment

**AC-MCP-007.1** — *When Daylens exposes its own activity facts through MCP, it
shall use the Canonical read tool surface for the applicable permitted query.*
Met. `packages/mcp-server/src/tools.ts` no longer holds a tool list; it projects
`capabilitiesForPath('mcp')`. `dispatch.ts` resolves every call through
`capabilityByToolName('mcp', …)`, so a tool the catalogue does not declare cannot
be published or called. `tests/daylensReadSurface.test.ts` asserts the manifest is
exactly the projection plus `describeReadSurface`.

**AC-MCP-007.2** — *When an External MCP client requests a Daylens activity fact
that Timeline, Apps, or Daylens chat can provide, the Daylens MCP server shall use
the same permitted Daylens facts and calculation semantics.*
Met, and proved rather than asserted. `tests/mcpReadSurfaceParity.test.ts` runs
both paths over one seeded database and requires the results to be the same
object for app usage, page visits, moment evidence, and search, and the same
object minus chat's documented capture-state superset for the day summary. The
Timeline and Apps half of the criterion is inherited: all of these bodies read
through the corrected activity-fact queries those views read, which
`tests/repositoryBoundary.test.ts` continues to enforce.

**AC-MCP-007.3** — *When Daylens changes a capability in the Canonical read tool
surface, it shall make that change available consistently to all supported Daylens
MCP access paths or identify the path where the capability is unavailable.*
Met. Every capability carries a per-path status that is either a published tool
name or a reason. The tests fail when a reason is missing, when a path claims a
tool that does not exist, and when a surface publishes a tool the catalogue does
not declare — the last one is the case that used to pass silently. A client sees
the same information at runtime through `describeReadSurface`, and asking for an
unavailable capability by name returns its reason instead of "unknown tool".

**Blocking:** none.

**Advisory:**

- The MCP path gained three capabilities (`getMoment`, `listPageVisits`,
  by-meaning results inside `searchSessions`) that the chat path already had.
  That is the work order's "adapt the shared surface for supported Daylens MCP
  access paths", and the owner directed that quality of answer, not access
  minimalism, is the bar. It does widen what a copied client configuration can
  read, which is exactly why WO-37's request-time authorization matters.

### Blueprint Alignment

ADR-002 ("Use one canonical Daylens read surface") is implemented as written,
including its stated consequence: a capability that cannot be exposed through a
path is now explicitly represented as unavailable rather than silently omitted.

**Blocking:** none.

**Advisory — blueprint statements that are now stale or were already false:**

1. *Local MCP Server, Integration Contracts:* "MCP `ListTools` returns the
   `anthropicTools` and `wrappedTools` definitions." No longer true, by design.
   `ListTools` returns the projection of the canonical catalogue plus
   `describeReadSurface`. The two exported arrays are gone.
2. *Local MCP Server, Integration Contracts:* "MCP `CallTool` routes standard
   names to `executeTool` and Wrapped names to `executeWrappedTool`." Still true
   for those capabilities, and now incomplete: composed capabilities route to a
   shared reader behind the same two exit boundaries.
3. *Agent Tool Layer, Integration Contracts:* "Chat and MCP do not expose one
   proven identical tool set." This was accurate at audit time. It is now proven
   for the overlapping set and explicitly enumerated for the rest.
4. *MCP Access, Feature Summary:* "The current implementation uses the same
   Daylens tool executors for its local server and starts Chat MCP servers with a
   minimal child environment." The first half was true. The second half is true
   only for chat servers: the local MCP subprocess is spawned in
   `src/main/services/mcpServer.ts` with `{ ...process.env, ...config.env }`,
   which contradicts the blueprint's own key contract that "Both local MCP and
   Chat MCP child processes use the `minimalChildEnv` allowlist". Out of scope
   here; carried into WO-37, whose AC-MCP-002.4 owns it.

### Architecture And Conventions

**Blocking:** none.

**Advisory:**

- The catalogue lives in `src/main/services/` rather than `src/shared/` because
  its executor coupling (`ToolName`, `WrappedToolName`) is a main-process concept
  and the renderer has no use for it. It imports types only, so it stays loadable
  in the MCP subprocess, which was the constraint that decided the location.
- `EXECUTOR_TOOL_IDS` is a `satisfies Record<ToolName | WrappedToolName, true>`
  record rather than a second list for its own sake: it makes adding an executor
  tool a compile error until the tool is named, and the runtime test then requires
  a capability declaration for it. Compile-time and runtime halves of one guard.

**Cross-lane dependencies raised, not acted on:**

1. `src/main/agent/daylensTools.ts` — `timeChunks` and `captureStateForDay` are
   private to the chat tool module, so the increment view cannot be served over
   MCP without duplicating a derived activity view. The fix belongs upstream:
   move both into a shared read service (they are read helpers, not tool bodies),
   after which `getTimeChunks` becomes a one-line MCP adapter and its
   unavailability entry is deleted. Until then the capability is declared
   unavailable with `getMoment` named as the per-increment alternative.
2. `src/main/agent/daylensTools.ts` — `list_page_visits` filters the corrected
   page ledger inline. The MCP path now applies the same filter over the same
   `getCorrectedPageFactsForRange` aggregate, and
   `tests/mcpReadSurfaceParity.test.ts` fails the moment the two disagree. The
   tidier end state is for the chat tool to call the shared filter; that edit is
   the agent-runtime lane's to make.
3. `src/main/agent/daylensTools.ts` and `src/main/agent/contextTools.ts` — four
   capabilities are MCP-only (`searchArtifacts`, `searchFileMentions`,
   `getWindowTitleContext`, `getDayComparison`, `getDistractionProfile`,
   `getMostSurprisingFact`). Each is recorded with a reason. Whether chat should
   gain any of them is a product call for the agent-runtime lane, not a defect
   this work order should fix from the outside.

### Tests And Build

**Commands run:**

```
npm run typecheck                                   clean
npm run lint                                        0 errors, 128 pre-existing warnings
node scripts/run-tests.mjs daylensReadSurface mcpReadSurfaceParity mcpServerSafety \
  mcpDatabaseStub repositoryBoundary agentToolTotalsParity agentTools
                                                    7 files, 40 pass, 0 fail
node scripts/run-tests.mjs mcpStdioClient           2 pass
```

**Blocking:** none.

**Advisory:**

- The first draft of the stdio test asserted `getDaySummary().totalSeconds > 0`
  on a directly seeded day and failed: the day summary reads a materialized
  timeline day, which raw session rows alone do not produce. The assertion moved
  to `getAppUsage`, which carries real numbers from the same fixture. Worth
  knowing before anyone writes another MCP test against hand-seeded rows.

### User-Facing Verification

**Skipped:** no.

**Evidence:** `tests/mcpStdioClient.test.ts` launches the real subprocess the way
the Settings snippet tells a client to launch it (`ELECTRON_RUN_AS_NODE=1`, the
loader, the server entry, `DAYLENS_DB_PATH` pointing at a temporary database) and
drives it with the Model Context Protocol SDK's own `Client` over
`StdioClientTransport`. Verified across the wire: the initialize handshake,
`listTools` containing the canonical surface, `getDaySummary`, `getAppUsage`
returning the seeded 7,200 seconds, `listPageVisits` returning the seeded page,
`describeReadSurface` naming `getTimeChunks` as unavailable with its reason, and
`getTimeChunks` itself returning an MCP error result carrying that reason. This
is a real client rather than an in-process call, so a broken loader path, an
unresolvable import in the subprocess, or a manifest that fails MCP schema
validation would fail it.

Verification against a third-party client (Claude Desktop or Claude Code) is
deferred to the end of the lane, after WO-37 changes the server's startup
contract; running it twice would prove the earlier version, not the shipped one.

**Blocking:** none.

**Advisory:** none.

### Security, Privacy, And Data Safety

**Skipped:** no.

**Blocking:** none.

**Advisory:**

- Every composed adapter ends with
  `sanitizeToolResult(filterTrackingExcludedEvidence(raw, controls))`, the same
  exit boundary `executeTool` and `executeWrappedTool` apply. There is no path in
  `dispatch.ts` that returns a reader's output unfiltered.
- The three capabilities added to the MCP path disclose no new category of
  evidence: moment evidence, the page ledger, and by-meaning search were already
  disclosed to a model through chat, and all three pass the same filters.
- `readMeetingNotes` is deliberately not published over MCP. Meeting bodies are
  high-sensitivity content behind an in-app policy switch, and an external client
  has no way to present that switch.
- No key, token, path, or personal row enters the code or the fixtures. Both new
  test fixtures seed synthetic rows and use `os.tmpdir()`.

### Round 1 Verdict

- Total blocking: 0
- Total advisory: 11
- Files reviewed: 8 (`src/main/services/daylensReadSurface.ts`,
  `packages/mcp-server/src/{tools,dispatch,composedReads,index}.ts`,
  `tests/{daylensReadSurface,mcpReadSurfaceParity,mcpStdioClient}.test.ts`)
- **Verdict:** APPROVED

---

<!-- Subsequent rounds: copy the structure above and increment the round number. -->
