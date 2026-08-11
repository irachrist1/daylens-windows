<!--lint disable no-undefined-references strong-marker-->

# Implementation Plan: WO-20

**Work Order:** WO-20 — [backend] Harden Chat MCP process isolation and lifecycle
**Created At (UTC):** 2026-08-11T09:30:00Z

## Summary

Most of the lifecycle is already in place: `minimalChildEnv` strips the
environment to launch essentials, `selectConnectableMcpServers` (WO-19) filters
to explicitly configured servers, `chatAgent.ts` calls `mcp.close()` in a
`finally` block, and per-server errors are caught. The gap is AC-MCP-005.3:
when the connection timeout fires, the `StdioMCPTransport` subprocess it spawned
is never killed — the `Promise.race` rejects but the child process leaks. Fix
this by creating the transport before the race, closing it on timeout/failure,
and swallowing the eventual rejection of the pending `createMCPClient` promise.

## Code Reuse And Package Structure

Reused:

- `minimalChildEnv` in `src/main/lib/childEnv.ts` — already strips the
  environment to `INHERITED_ENV_KEYS` plus explicit extras. Tested in
  `tests/agentTools.test.ts`.
- `selectConnectableMcpServers` in `src/main/agent/mcpTools.ts` (WO-19) —
  already filters to enabled servers.
- `chatAgent.ts` `finally { await mcp.close() }` — already closes all clients
  at turn end.
- `StdioMCPTransport.close()` — kills the subprocess and aborts the internal
  `AbortController`.

Modified:

- `src/main/agent/mcpTools.ts` — extract `raceConnectWithCleanup`, restructure
  `connectMcpTools` to create the transport before the race and close it on
  failure.

Created:

- `tests/chatMcpLifecycle.test.ts`.

## Components And Flow

`raceConnectWithCleanup(connect, timeoutMs, cleanup)` is a pure async helper:
it races `connect()` against a timeout, and on timeout or failure, calls
`cleanup()` and swallows the pending promise's eventual rejection. On success,
it returns the result and the caller owns the resource. This is the testable
unit; `connectMcpTools` uses it with `transport.close()` as the cleanup.

The per-turn flow is unchanged from the caller's perspective: `chatAgent.ts`
calls `connectMcpTools`, uses `mcp.tools`, and calls `mcp.close()` in `finally`.
The change is inside `connectMcpTools`: the transport is created first, and on
timeout the subprocess is killed instead of leaking.

## Steps

1. **Extract the timeout+cleanup helper** — `raceConnectWithCleanup` in
   `src/main/agent/mcpTools.ts`.
2. **Restructure `connectMcpTools`** — create the transport before the race,
   use `raceConnectWithCleanup` with `transport.close()` as cleanup.
3. **Test the helper** — `tests/chatMcpLifecycle.test.ts`: success returns the
   result without calling cleanup; timeout calls cleanup and rejects; failure
   calls cleanup and rethrows; the pending promise's rejection is handled.

## Testing

`tests/chatMcpLifecycle.test.ts`

- `raceConnectWithCleanup` returns the result when the operation succeeds before
  the timeout, and does not call cleanup.
- `raceConnectWithCleanup` calls cleanup and rejects with "connect timeout"
  when the operation exceeds the timeout.
- `raceConnectWithCleanup` calls cleanup and rethrows when the operation fails
  before the timeout.
- The pending operation's eventual rejection is swallowed (no unhandled
  rejection) when cleanup closes the resource out from under it.

Commands:

```bash
npm run typecheck && npm run lint
node scripts/run-tests.mjs chatMcpLifecycle mcpTools agentTools
```
