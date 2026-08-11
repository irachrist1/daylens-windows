<!--lint disable strong-marker-->

# Review Log: WO-19

**Work Order:** WO-19 — [backend] Persist and manage explicit Chat MCP servers
**Initialized At (UTC):** 2026-08-11T09:10:25Z

This file records review and verification rounds. Append new rounds; do not overwrite prior rounds.

---

## Round 1

### Requirements Alignment

**AC-MCP-004.1** — *When a person adds a Chat MCP server in Settings, Daylens
shall store the server configuration for use in later Chat turns.* Met. The
persistence path already existed: `AppSettings.mcpServers` is stored in
electron-store and read by `getSettings()` on each chat turn. The change adds
the `enabled` field to `McpServerConfig` so a stored entry can carry an
availability state without losing its command/args/env.

**AC-MCP-004.2** — *When a person edits or removes a Chat MCP server, Daylens
shall use the changed configuration or stop using the removed server in
subsequent Chat turns.* Met. `aiService.ts:3481` calls `getSettings()` fresh
on each turn, so edits and removals take effect on the next turn with no
wiring added. `tests/chatMcpServerManagement.test.ts` proves a removed server
is absent from the next `getSettings()` read.

**AC-MCP-004.3** — *When Daylens discovers an MCP server configuration outside
Daylens, it shall not add or start that server for chat unless the person
explicitly adds it in Daylens.* Met, and structurally enforced.
`discoverMcpServers()` returns `{ name, transport }` entries with no `command`
field. `McpServerConfig` requires `command`. A discovered server therefore
cannot be passed to `connectMcpTools` without the person explicitly providing a
command. The enrichment IPC handler is the only caller of `discoverMcpServers`
and routes its output to `EnrichmentSourcesState`, never to
`AppSettings.mcpServers`. The test proves the discovered entry has no
`command` property.

**AC-MCP-004.4** — *If a configured Chat MCP server is unsupported or cannot be
started, then Daylens shall identify that server as unavailable without
preventing the person from using the rest of chat.* Met. `connectMcpTools`
already caught per-server errors and continued; the change adds
`serverStatuses` to `McpToolPool` so the caller can see which servers
connected, which were disabled (`skipped`), and which failed. A disabled or
failed server contributes no tools but does not break the turn.

**Blocking:** none.

**Advisory:**

- `serverStatuses` is populated but not yet surfaced to the renderer, because
  the renderer UI for chat MCP management is out of scope (WO-19 explicitly
  excludes it). The information is available to the caller; a future work order
  that builds the UI reads it from `McpToolPool`.

### Blueprint Alignment

The MCP Access blueprint defines persisted, user-managed `McpServerConfig`
entries and their chat-turn eligibility. The `enabled` field is the
eligibility switch; `selectConnectableMcpServers` is the pure decision that
enforces it; `connectMcpTools` is the single entry point that turns eligible
servers into tool definitions.

**Blocking:** none.

**Advisory:** none.

### Architecture And Conventions

**Blocking:** none.

**Advisory:**

- `selectConnectableMcpServers` is extracted as a pure function so the
  disabled/enabled decision is testable without spawning subprocesses. This
  follows the pattern of `describeMcpConnection` in WO-17: the decision is in
  a testable unit, the side-effectful connection is in the function that uses
  it.
- `enabled?: boolean` on `McpServerConfig` is optional and defaults to
  enabled when absent. This is backward compatible with existing stored
  configs in `AppSettings.mcpServers` (which is in `src/shared/types.ts`, a
  file this session does not own). A stored entry without `enabled` is
  treated as enabled by `selectConnectableMcpServers`.

### Tests And Build

**Commands run:**

```
npm run typecheck                                          clean
npx eslint src/main/agent/mcpTools.ts \
  tests/chatMcpServerManagement.test.ts                     0 errors, 0 warnings
node scripts/run-tests.mjs chatMcpServerManagement mcpTools
                                                           2 files, 7 pass, 0 fail
```

**Blocking:** none.

**Advisory:**

- `connectMcpTools` itself is not unit-tested for the new `serverStatuses`
  field because it spawns real subprocesses. The selection logic it depends
  on is fully tested, and the per-server error handling was already in place
  before this change.

### User-Facing Verification

**Skipped:** deferred to the end of the lane, as in WO-17. This is a backend
change; the renderer surface for chat MCP management is out of scope.

**Blocking:** none.

**Advisory:** none.

### Security, Privacy, And Data Safety

**Skipped:** no.

**Blocking:** none.

**Advisory:**

- The `enabled` field does not change the privacy boundary: `guardMcpToolResult`
  and `wrapMcpToolsWithGuards` still run on every MCP tool result regardless of
  which servers are connected. A disabled server is never started, so its
  tools never enter the loop.

### Round 1 Verdict

- Total blocking: 0
- Total advisory: 5
- Files reviewed: 2 (`src/main/agent/mcpTools.ts`,
  `tests/chatMcpServerManagement.test.ts`)
- **Verdict:** APPROVED, with the user-facing pass deferred to the end of the
  lane.

---

<!-- Subsequent rounds: copy the structure above and increment the round number. -->
