<!--lint disable no-undefined-references strong-marker-->

# Implementation Plan: WO-37

**Work Order:** WO-37 — [backend] Enforce revocable MCP authorization and live privacy evaluation
**Created At (UTC):** 2026-08-11T10:00:00Z

## Summary

Most of the authorization and privacy machinery is already in place: the
settings handler starts/stops the server on toggle, restarts it with a fresh
privacy snapshot when tracking controls change, and the tool catalogue is
read-only with results sanitized. Two gaps remain: the MCP server subprocess
inherits the full `process.env` (which can carry API keys) instead of the
minimal child environment, and the default for `mcpServerEnabled` is `false`
when the product decision is "on by default." Fix both, and update the
Settings copy to match.

## Code Reuse And Package Structure

Reused:

- `minimalChildEnv` in `src/main/lib/childEnv.ts` — strips the environment to
  `INHERITED_ENV_KEYS` plus explicit extras. Already used for Chat MCP server
  subprocesses; now applied to the Daylens MCP server subprocess too.
- The settings handler in `src/main/ipc/settings.handlers.ts` — already
  starts/stops the server on `mcpServerEnabled` change (lines 93-97) and
  restarts it on tracking-control changes (lines 104-107). No change needed.
- `sanitizeToolResult` / `filterTrackingExcludedEvidence` — already applied to
  every MCP result in `dispatch.ts` / `composedReads.ts` (WO-15).

Modified:

- `src/main/services/settings.ts` — `mcpServerEnabled` default `false` →
  `true` in `DEFAULTS` and the store read.
- `src/main/services/mcpServer.ts` — `spawn` env from `{ ...process.env,
  ...config.env }` to `minimalChildEnv(config.env)`.
- `src/renderer/views/Settings.tsx` — MCP section copy: "Off by default" →
  "On by default".

Created:

- `tests/mcpAuthorizationBoundary.test.ts`.

## Components And Flow

The authorization boundary is the `mcpServerEnabled` setting: when off, the
server process is killed and requests cannot reach it; when on, the server
runs with a snapshot of the current privacy controls. The settings handler
restarts the server when privacy controls change, so the snapshot stays
current. The subprocess now receives only `minimalChildEnv(config.env)`, so
API keys and other secrets in `process.env` do not leak to the subprocess.

## Steps

1. **Default to enabled** — `settings.ts`: change `mcpServerEnabled` default
   to `true` in `DEFAULTS` and the store read fallback.
2. **Minimal env for the subprocess** — `mcpServer.ts`: import `minimalChildEnv`
   and use it for the `spawn` env.
3. **Update Settings copy** — `Settings.tsx`: "Off by default" → "On by
   default" in the section description and the dev-build note.
4. **Test the env boundary** — `tests/mcpAuthorizationBoundary.test.ts`: the
   config env does not include arbitrary `process.env` vars; the default is
   on.

## Testing

`tests/mcpAuthorizationBoundary.test.ts`

- `getMcpServerConfig()` returns env that includes `ELECTRON_RUN_AS_NODE` and
  `DAYLENS_DB_PATH` but does not include an arbitrary `process.env` var that
  is not in `INHERITED_ENV_KEYS`.
- The tracking control env vars are present in the config env.

Commands:

```bash
npm run typecheck && npm run lint
node scripts/run-tests.mjs mcpAuthorizationBoundary mcpServerSafety
```
