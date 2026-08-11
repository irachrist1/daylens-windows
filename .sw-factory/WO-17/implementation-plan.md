<!--lint disable no-undefined-references strong-marker-->

# Implementation Plan: WO-17

**Work Order:** WO-17 — [renderer] Deliver usable local MCP configuration in Settings
**Created At (UTC):** 2026-08-11T09:12:00Z

## Summary

The MCP settings section renders the connection snippet only when a configuration
resolved, and renders nothing at all when it did not, so a person whose install
cannot run the server sees an enabled toggle and an empty panel. Give the section
an explicit connection state — checking, ready, unavailable, or failed — decide
that state in one pure function, and never show a copy control for configuration
that is not ready.

## Code Reuse And Package Structure

Reused:

- `IPC.MCP.GET_CONFIG` and `ipc.mcp.getConfig()` — the existing controller
  boundary. No new channel: `IPC` lives in `src/shared/types.ts`, which another
  session owns this wave.
- `getMcpServerConfig()` / `isMcpServerRunning()` in
  `src/main/services/mcpServer.ts` — the configuration provider and the process
  state the section needs to report.
- `SettingsRow`, `Toggle`, `inlineButtonStyle`, and the section's existing markup
  in `src/renderer/views/Settings.tsx`.
- `recordSettingsLoadError` — the section-level load-failure channel Settings
  already uses, so an MCP fetch failure is surfaced the way every other section's
  failure is.

Created:

- `src/shared/mcpConnection.ts` — `describeMcpConnection()`, the pure state
  decision: input is what the renderer knows (enabled, fetch state, config,
  error), output is what to show and whether copying is allowed.
- `tests/mcpConnectionState.test.ts`.

Modified:

- `src/renderer/views/Settings.tsx` — the `mcp` section only.
- `src/main/services/mcpServer.ts` — `running` on the returned config, so the
  section can report the live state rather than infer it from the toggle.
- `tests/mcpServerSafety.test.ts` — one added case for the new field.

## Components And Flow

#McpSettingsController is the Settings section plus the main-process provider it
calls. The renderer holds no path knowledge; it holds a state:

```ts
type McpConnectionState =
  | { kind: 'off' }
  | { kind: 'checking' }
  | { kind: 'ready'; config: McpServerConfig; running: boolean }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'failed'; reason: string }
```

`describeMcpConnection()` maps `{ enabled, fetch, config, error }` onto that
state and onto `canCopy`, which is true only for `ready`. The renderer branches
once on `state.kind`, so an unavailable install cannot fall through to the
snippet markup: the copy button exists in the `ready` branch alone.

Flow on a toggle change: `persist({ mcpServerEnabled })` writes settings, the main
process starts or stops the subprocess in the existing settings handler, the
renderer re-runs the same loader it uses on section entry, and the state moves to
`ready` (with `running` from the provider) or to `unavailable` with the reason.
No restart, and no separate code path for "just toggled" versus "opened the
section".

## Steps

1. **Report the live process state** — add `running: isMcpServerRunning()` to the
   `McpServerConfig` metadata in `src/main/services/mcpServer.ts`, beside the
   existing `isPackaged` and `dbPath` metadata.
2. **Decide the state in one place** — `src/shared/mcpConnection.ts`.
3. **Load through one path** — a single `loadMcpConfig()` in Settings used by both
   the section effect and the post-toggle refresh, with a catch that records the
   failure instead of dropping it.
4. **Render the four states** — replace `enabled && mcpConfig && (…)` with a
   branch on the decided state: checking, ready (snippet plus copy plus the
   running line), unavailable (explanation, no snippet, no copy), failed (the
   error, no snippet, no copy).
5. **Test the decision and the field** — `tests/mcpConnectionState.test.ts` and one
   case in `tests/mcpServerSafety.test.ts`.

## Testing

`tests/mcpConnectionState.test.ts`

- a null configuration with the toggle on yields `unavailable`, never `ready`,
  and `canCopy` is false;
- a fetch failure yields `failed` carrying the message, and `canCopy` is false;
- an in-flight fetch yields `checking`, and `canCopy` is false;
- a resolved configuration yields `ready` with the config and the running flag,
  and `canCopy` is true;
- the toggle off yields `off` regardless of what the last fetch returned, so a
  stale configuration cannot be presented after access is revoked.

`tests/mcpServerSafety.test.ts` — the provider reports `running` alongside
`isPackaged` and the userData database path.

Commands:

```bash
npm run typecheck && npm run lint
node scripts/run-tests.mjs mcpConnectionState mcpServerSafety
```

Manual: the section is exercised in the running app during the lane's
user-facing verification pass, with the MCP server files present and then with
`getMcpServerConfig()` forced to null, to see both panels.
