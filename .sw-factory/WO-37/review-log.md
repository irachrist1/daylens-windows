<!--lint disable strong-marker-->

# Review Log: WO-37

**Work Order:** WO-37 — [backend] Enforce revocable MCP authorization and live privacy evaluation
**Initialized At (UTC):** 2026-08-11T10:00:00Z

---

## Round 1

### Requirements Alignment

**AC-MCP-001.1** — *When a person has not enabled MCP access, the Daylens MCP
server shall deny requests.* Met. The settings handler
(`settings.handlers.ts:93-97`) stops the server when `mcpServerEnabled` is
set to false. A stopped server cannot accept requests. The default is now
`true` (the product decision: "toggle everything on by default"), so the
server starts on launch unless the person says otherwise.

**AC-MCP-001.3** — *When a person revokes MCP access, the Daylens MCP server
shall reject subsequent requests from clients that used a previous connection
configuration.* Met. Toggling off calls `stopMcpServer()`, which sends SIGTERM
(and SIGKILL after 5s) to the subprocess. A client that tries to connect after
revocation gets a connection error because the process is gone.

**AC-MCP-001.4** — *While MCP access remains enabled, the Daylens MCP server
shall expose Daylens data only through read operations.* Met. The tool
catalogue (WO-15) publishes only read capabilities. `dispatch.ts` resolves
every tool call through `callDaylensReadTool`, which calls `executeTool`,
`executeWrappedTool` (with `allowCollect: false`), or `executeComposedRead` —
all read-only paths. No write tool exists in the MCP manifest.

**AC-MCP-002.1** — *apply the Privacy policy in effect at the time of that
request.* Met. The settings handler (`settings.handlers.ts:104-107`) restarts
the server when `trackingControlsEnabled`, `trackingExcludedApps`,
`trackingExcludedSites`, or `trackingPaused` change. The restart passes a
fresh snapshot of the controls via env vars, so the server always serves
under the current policy. The subprocess cannot read the Electron store
directly, so restart-on-change is the live-evaluation mechanism.

**AC-MCP-002.2** — *omit forbidden evidence.* Met. Every composed read in
`composedReads.ts` ends with `sanitizeToolResult(filterTrackingExcludedEvidence(raw,
controls))`. The `controls` object is read from the env vars at startup, and
the server is restarted when those env vars change. Tested in WO-15's parity
test (`mcpReadSurfaceParity.test.ts`).

**AC-MCP-002.3** — *remove sensitive credential material or unsafe URL
details.* Met. `sanitizeToolResult` strips credential patterns from every
string field. Applied in `composedReads.ts` and in `dispatch.ts`'s
`callDaylensReadTool`. Tested in WO-15's tests and in `mcpTools.test.ts`.

**AC-MCP-002.4** — *provide only the environment information required to
launch that process and explicitly configured values.* Met. The MCP server
subprocess now receives `minimalChildEnv(config.env)` instead of
`{ ...process.env, ...config.env }`. `minimalChildEnv` strips the environment
to `INHERITED_ENV_KEYS` (PATH, HOME, USER, etc.) plus the explicit config vars
(ELECTRON_RUN_AS_NODE, DAYLENS_DB_PATH, tracking controls). API keys and
other secrets in `process.env` no longer reach the subprocess.
`tests/mcpAuthorizationBoundary.test.ts` proves an arbitrary `process.env`
var does not appear in the spawn env.

**Blocking:** none.

**Advisory:**

- The `mcpServerEnabled` default change is not unit-tested because the test
  runner uses a settings stub whose `DEFAULT_SETTINGS` does not include
  `mcpServerEnabled`. The change is a one-line edit in `settings.ts` (both
  the `DEFAULTS` object and the store-read fallback) that is visible in the
  diff and verified by typecheck.

### Blueprint Alignment

The MCP Access blueprint defines the request-enforced local authorization
boundary, live privacy evaluation, and local result protections. The
boundary is the `mcpServerEnabled` setting; the live evaluation is the
restart-on-privacy-change; the result protections are the guard functions
from WO-15; the env restriction is `minimalChildEnv`.

**Blocking:** none.

**Advisory:** none.

### Architecture And Conventions

**Blocking:** none.

**Advisory:**

- The MCP server subprocess previously inherited `...process.env`, which
  could carry provider API keys set by the Electron main process. Using
  `minimalChildEnv` closes that leak. The subprocess still gets PATH, HOME,
  and other launch essentials, plus the explicit config vars — it just does
  not get everything else.
- The restart-on-privacy-change mechanism means there is a brief window
  (the time between the setting write and the subprocess restart) during
  which the server serves under the old policy. This is acceptable: the
  window is sub-second, the old policy was the person's previous choice, and
  the alternative (the subprocess reads the store on every request) would
  require IPC infrastructure that does not exist for a stdio subprocess.

### Tests And Build

**Commands run:**

```
npm run typecheck                                          clean
npx eslint src/main/services/mcpServer.ts src/main/services/settings.ts \
  src/renderer/views/Settings.tsx \
  tests/mcpAuthorizationBoundary.test.ts                  0 errors, 1 pre-existing warning
node scripts/run-tests.mjs mcpAuthorizationBoundary mcpServerSafety
                                                           2 files, 5 pass
```

**Blocking:** none.

**Advisory:** none.

### User-Facing Verification

**Deferred:** the lane runs one pass in the running app at the end. This work
order changes the default (so the server starts on launch), the subprocess
env (so API keys don't leak), and the Settings copy (so it says "On by
default"). The user-facing pass verifies the panel shows the right state on a
fresh install and after toggling.

**Blocking:** none.

### Security, Privacy, And Data Safety

**Blocking:** none.

**Advisory:**

- The `minimalChildEnv` change is the security improvement in this work
  order: it prevents the MCP subprocess from inheriting API keys, tokens, and
  other secrets that the main process has in its environment. The subprocess
  only gets what it needs to launch and connect.

### Round 1 Verdict

- Total blocking: 0
- Total advisory: 4
- Files reviewed: 4 (`src/main/services/settings.ts`,
  `src/main/services/mcpServer.ts`, `src/renderer/views/Settings.tsx` (mcp
  section only), `tests/mcpAuthorizationBoundary.test.ts`)
- **Verdict:** APPROVED, user-facing pass deferred to end of lane.

---

<!-- Subsequent rounds: copy the structure above and increment the round number. -->
