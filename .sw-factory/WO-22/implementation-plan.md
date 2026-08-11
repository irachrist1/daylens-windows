<!--lint disable no-undefined-references strong-marker-->

# Implementation Plan: WO-22

**Work Order:** WO-22 — [backend] Isolate and attribute untrusted Chat MCP output
**Created At (UTC):** 2026-08-11T09:45:00Z

## Summary

MCP tool results already cross the tracking-exclusion filter and secret
sanitizer via `guardMcpToolResult`, and tools are already namespaced with the
server name. Two gaps remain: the namespacing can silently collide when
normalization (`-` → `_`) or 64-char truncation maps two different server/tool
pairs to the same key, and the source identity is not carried in the tool
description the model sees. Extract the namespacing into a collision-detecting
pure function, and prefix each wrapped tool's description with its source
server so the model can attribute results.

## Code Reuse And Package Structure

Reused:

- `guardMcpToolResult` / `wrapMcpToolsWithGuards` in `src/main/agent/mcpTools.ts`
  — the untrusted-output boundary. Every MCP tool result crosses both the
  tracking-exclusion filter and the secret sanitizer before reaching the model.
  Already tested in `tests/mcpTools.test.ts`.
- The agent's own tool permission flows — MCP tools are data sources (they
  return results, they do not execute Daylens actions), so an MCP result cannot
  bypass the agent's own tool safeguards. The agent's tools (in `daylensTools.ts`
  and `contextTools.ts`) have their own permission, preview, and confirmation
  flows that are independent of MCP tool output.

Modified:

- `src/main/agent/mcpTools.ts` — extract `namespaceMcpToolName`, use it in
  `connectMcpTools`, prefix wrapped tool descriptions with the source server.

Created:

- `tests/chatMcpAttribution.test.ts`.

## Components And Flow

`namespaceMcpToolName(serverName, toolName, used)` is a pure function that
produces a unique tool key. It normalizes the `mcp_${serverName}_${toolName}`
string, truncates to 64 chars, and if the result collides with an already-used
key, appends a numeric suffix. The `used` set is passed in so the function is
stateless and testable.

`connectMcpTools` uses `namespaceMcpToolName` with a `Set<string>` to track
used keys across all servers. Each wrapped tool's `description` is prefixed
with `[MCP:{serverName}]` so the model sees the source identity in the tool
definition.

## Steps

1. **Extract the namespacing function** — `namespaceMcpToolName` in
   `src/main/agent/mcpTools.ts`, with collision detection.
2. **Prefix tool descriptions with source** — in `wrapMcpToolsWithGuards` or
   in `connectMcpTools`, add `[MCP:{serverName}]` to each tool's description.
3. **Test namespacing and attribution** —
   `tests/chatMcpAttribution.test.ts`.

## Testing

`tests/chatMcpAttribution.test.ts`

- `namespaceMcpToolName` produces different keys for the same tool name from
  different servers.
- `namespaceMcpToolName` detects collisions from normalization (`my-server`
  and `my_server` both normalize to `my_server`) and disambiguates.
- `namespaceMcpToolName` detects collisions from 64-char truncation and
  disambiguates.
- `wrapMcpToolsWithGuards` still applies the guard to every tool with an
  `execute` (regression check).

Commands:

```bash
npm run typecheck && npm run lint
node scripts/run-tests.mjs chatMcpAttribution mcpTools
```
