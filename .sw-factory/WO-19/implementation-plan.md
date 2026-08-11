<!--lint disable no-undefined-references strong-marker-->

# Implementation Plan: WO-19

**Work Order:** WO-19 — [backend] Persist and manage explicit Chat MCP servers
**Created At (UTC):** 2026-08-11T09:10:25Z

## Summary

Chat MCP server configs already persist in `AppSettings.mcpServers` and reach the
agent loop through `connectMcpTools` on each turn. What is missing: an
availability state (a server can be disabled without being deleted), a way for
the caller to see which configured servers failed without blocking chat, and a
structural guarantee that servers discovered in external application configs
never enter the chat path. Add an `enabled` field to `McpServerConfig`, extract
the server-selection decision into a pure function, and have
`connectMcpTools` report per-server status.

## Code Reuse And Package Structure

Reused:

- `AppSettings.mcpServers` in `src/shared/types.ts` — the persisted shape. Not
  modified (that file is owned by another session this wave). Its shape
  `{ name, command, args?, env? }` is a subset of `McpServerConfig`, so adding
  `enabled?` to `McpServerConfig` keeps settings compatible: a stored entry
  without `enabled` defaults to enabled.
- `getSettings()` in `src/main/services/settings.ts` — already re-read on each
  chat turn at `aiService.ts:3481`, so edit/remove changes take effect on the
  next turn without any new wiring.
- `discoverMcpServers()` in `src/main/services/enrichmentDiscovery.ts` — returns
  `{ name, transport }` entries with no `command` field, so its output is
  structurally incompatible with `McpServerConfig` and cannot feed the chat path.
  The enrichment IPC handler (`settings.handlers.ts`) is the only caller and
  routes discovery results to `EnrichmentSourcesState`, not to
  `AppSettings.mcpServers`.

Modified:

- `src/main/agent/mcpTools.ts` — `enabled?` on `McpServerConfig`,
  `selectConnectableMcpServers()` pure decision, `serverStatuses` on
  `McpToolPool`, `connectMcpTools` uses both.

Created:

- `tests/chatMcpServerManagement.test.ts`.

## Components And Flow

`selectConnectableMcpServers(servers)` is a pure function that splits a list
into `connectable` (enabled servers, where `enabled` defaults to `true` when
absent) and `skipped` (disabled servers, each with a reason). `connectMcpTools`
calls it, attempts each connectable server, catches per-server failures, and
returns `serverStatuses` alongside the tools so the caller knows which servers
connected, which were disabled, and which failed.

The chat-turn flow is unchanged: `aiService.ts` reads `getSettings()` fresh,
passes `settings.mcpServers ?? []` to `connectMcpTools`, and the agent loop
proceeds with whatever tools resolved. A disabled or failed server contributes
no tools but does not break the turn.

## Steps

1. **Add the availability field and the selection function** — in
   `src/main/agent/mcpTools.ts`, add `enabled?: boolean` to `McpServerConfig`
   and export `selectConnectableMcpServers`.
2. **Report per-server status** — add `serverStatuses` to `McpToolPool` and have
   `connectMcpTools` populate it: `connected`, `skipped`, or `failed` for each
   configured server.
3. **Test the decision and the invariants** — `tests/chatMcpServerManagement.test.ts`:
   disabled servers are skipped, absent `enabled` defaults to on, discovery
   output cannot be used as a chat server config, and removed servers are absent
   from the settings read.

## Testing

`tests/chatMcpServerManagement.test.ts`

- `selectConnectableMcpServers` returns disabled servers in `skipped` with a
  reason and does not include them in `connectable`.
- Servers without `enabled` are treated as enabled (backward compatibility with
  existing stored configs).
- `discoverMcpServers` returns entries without a `command` field, so they
  cannot satisfy `McpServerConfig` — the structural separation between discovery
  and chat.
- The settings store round-trips `mcpServers`: a removed server is absent from
  the next `getSettings()` read.

Commands:

```bash
npm run typecheck && npm run lint
node scripts/run-tests.mjs chatMcpServerManagement mcpTools
```
