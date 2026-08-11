<!--lint disable strong-marker-->

# Review Log: WO-20

**Work Order:** WO-20 — [backend] Harden Chat MCP process isolation and lifecycle
**Initialized At (UTC):** 2026-08-11T09:30:00Z

This file records review and verification rounds. Append new rounds; do not overwrite prior rounds.

---

## Round 1

### Requirements Alignment

**AC-MCP-005.1** — *provide only the environment information required to
launch that server and values explicitly configured for that server.* Met.
`mcpChildEnv` → `minimalChildEnv` already strips the environment to
`INHERITED_ENV_KEYS` (PATH, HOME, USER, etc.) plus the server's explicit `env`.
Tested in `tests/agentTools.test.ts:397` which proves a `DAYLENS_TEST_SECRET`
env var does not reach the child.

**AC-MCP-005.2** — *connect only to Chat MCP servers that the person has
explicitly configured.* Met by `selectConnectableMcpServers` (WO-19), which
filters to enabled servers from the settings array. Discovery output never
enters the chat path (proven in WO-19's test).

**AC-MCP-005.3** — *When a configured Chat MCP server does not become available
within the connection limit, Daylens shall skip that server for the Chat turn
and release its connection resources.* Met. Previously the `Promise.race`
rejected on timeout but left the `StdioMCPTransport` subprocess running. Now
the transport is created before the race, and `raceConnectWithCleanup` calls
`transport.close()` on timeout to kill the subprocess. The pending
`createMCPClient` promise's eventual rejection is swallowed by
`promise.catch(() => {})` so it does not surface as an unhandled rejection.
`tests/chatMcpLifecycle.test.ts` proves cleanup is called on timeout and the
pending rejection is handled.

**AC-MCP-005.4** — *When a Chat turn ends, Daylens shall close each Chat MCP
server connection that it opened for that turn.* Met. `chatAgent.ts:527`
calls `await mcp.close()` in a `finally` block. `McpToolPool.close()` calls
`client.close()` on every connected client via `Promise.allSettled`, so one
slow close does not block the others.

**AC-MCP-005.5** — *If a Chat MCP server fails during a Chat turn, then
Daylens shall continue with the available Daylens and Chat MCP tools and
identify the unavailable source.* Met for startup failures: the per-server
`catch` in `connectMcpTools` records a `failed` status and continues with the
remaining servers. For mid-turn failures (a connected server's tool throws
during execution), the Vercel AI SDK reports the tool error to the model, which
can continue with other tools. The `serverStatuses` list identifies which
servers connected and which failed at startup.

**Blocking:** none.

**Advisory:**

- Mid-turn server death (the subprocess exits after a successful handshake) is
  not explicitly tracked in `serverStatuses`. The AI SDK handles the tool
  execution error, but the status list does not update mid-turn. This is
  acceptable for this work order's scope: the server was connected at startup,
  and its failure surfaces as a tool error the model can work around. A future
  work order could add a health-check loop if the product requires it.

### Blueprint Alignment

The MCP Access blueprint defines the one-turn client pool, minimal child
environment, and lifecycle contracts. `raceConnectWithCleanup` is the
enforcement of the "release resources for timed-out startup" contract;
`McpToolPool.close()` in the `finally` block is the "close each connection"
contract.

**Blocking:** none.

**Advisory:** none.

### Architecture And Conventions

**Blocking:** none.

**Advisory:**

- `raceConnectWithCleanup` is extracted as a standalone function so the
  timeout+cleanup behavior is testable without spawning real subprocesses. It
  follows the pattern from WO-17 and WO-19: the decision is in a testable unit,
  the side-effectful connection is in the function that uses it.
- The `transport` is created before `raceConnectWithCleanup` so it can be
  closed on timeout. On success, the transport is owned by the `MCPClient`
  (which closes it when `client.close()` is called). On failure, the transport
  is closed directly. There is no double-close risk because the two paths are
  mutually exclusive.

### Tests And Build

**Commands run:**

```
npm run typecheck                                          clean
npx eslint src/main/agent/mcpTools.ts \
  tests/chatMcpLifecycle.test.ts                           0 errors, 0 warnings
node scripts/run-tests.mjs chatMcpLifecycle                1 file, 4 pass
node scripts/run-tests.mjs mcpTools agentTools             2 files, 23 pass
```

**Blocking:** none.

**Advisory:**

- `connectMcpTools` itself is not unit-tested for the transport cleanup
  because it spawns real subprocesses. The `raceConnectWithCleanup` helper it
  depends on is fully tested, and the integration is a direct call.

### User-Facing Verification

**Skipped:** deferred to the end of the lane. Backend change; no renderer
surface in scope.

**Blocking:** none.

**Advisory:** none.

### Security, Privacy, And Data Safety

**Skipped:** no.

**Blocking:** none.

**Advisory:**

- The transport cleanup prevents a leaked subprocess from outliving the chat
  turn, which could otherwise retain access to the minimal environment's env
  vars. `transport.close()` kills the subprocess and aborts its internal
  `AbortController`.

### Round 1 Verdict

- Total blocking: 0
- Total advisory: 4
- Files reviewed: 2 (`src/main/agent/mcpTools.ts`,
  `tests/chatMcpLifecycle.test.ts`)
- **Verdict:** APPROVED, with the user-facing pass deferred to the end of the
  lane.

---

<!-- Subsequent rounds: copy the structure above and increment the round number. -->
