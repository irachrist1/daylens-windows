<!--lint disable strong-marker-->

# Review Log: WO-17

**Work Order:** WO-17 — [renderer] Deliver usable local MCP configuration in Settings
**Initialized At (UTC):** 2026-08-11T09:12:00Z

This file records review and verification rounds. Append new rounds; do not overwrite prior rounds.

---

## Round 1

### Requirements Alignment

**AC-MCP-001.2** — *When a person enables MCP access, Daylens shall provide the
information needed to connect an External MCP client.* Met, and it was already
met when a configuration resolved. What changed is the other half: enabling access
on an install that cannot run the server now produces a stated reason instead of
an empty panel.

**AC-MCP-003.1** — *show the current MCP access setting.* Met. The toggle is bound
to `settings.mcpServerEnabled`, and each of the four states below it names the
resulting access state in words.

**AC-MCP-003.2** — *when enabled, show a connection configuration that reflects
the current installation and local Daylens data location.* Met. The snippet is
built from `IPC.MCP.GET_CONFIG`, whose provider resolves the packaged bundle or
the dev loader and always reports the userData database path;
`tests/mcpServerSafety.test.ts` holds that path to userData and never the app
root.

**AC-MCP-003.3** — *if Daylens cannot prepare a usable connection, explain that
and do not present unusable configuration as ready to copy.* Met, and this is the
gap the work order named. Three previously indistinguishable outcomes are now
separate states: `checking` while the lookup is in flight, `unavailable` when the
provider returns null, `failed` when the IPC call itself throws. The copy control
exists only inside the `ready` branch, so there is no rendering path that offers
to copy configuration that is not ready.
`tests/mcpConnectionState.test.ts` asserts `canCopyMcpConfig` is false for every
non-ready state.

**AC-MCP-003.4** — *when a person changes the setting, show the resulting access
state without requiring a restart.* Met. Toggling runs the same loader the section
entry runs, so the state re-derives immediately, and the ready panel reports
whether the managed subprocess is actually up rather than assuming the toggle
implies it.

**Blocking:** none.

**Advisory:**

- The `off` state's copy says only that the server is not running. It cannot yet
  say that a previously copied configuration stops working, because that is not
  true until WO-37 makes enablement a request-time decision. WO-37 updates this
  sentence when it becomes true; writing it early would have been a lie in the
  product.

### Blueprint Alignment

The #McpSettingsController requirement to "represent unavailable server bundles as
unavailable configuration, not as connection-ready data" is now literal: the
unavailable case has its own branch and its own words.

**Blocking:** none.

**Advisory:**

- The blueprint gives #McpSettingsController responsibility for "Creates, edits,
  removes, and displays user-configured `McpServerConfig` entries for chat" as
  well. That is deliberately absent here: the work order puts chat MCP management
  UI out of scope, and WO-19 delivers only the backend for it. No Settings surface
  exists for chat MCP servers after this lane, which is a real gap against the
  blueprint and is recorded in the pull request rather than hidden.

### Architecture And Conventions

**Blocking:** none.

**Advisory:**

- `describeMcpConnection` lives in `src/shared/` rather than inside the 4,200-line
  Settings component so the decision is testable without a renderer test harness,
  which this repository does not have. It follows the existing pattern of small
  shared contract modules (`platformPaths`, `trackingControls`, `captureConsent`).
- No new IPC channel was added. `IPC` is declared in `src/shared/types.ts`, which
  another session owns this wave, so the live process state rides on the existing
  `GET_CONFIG` payload as metadata beside `isPackaged` and `dbPath`. If that file
  frees up, a dedicated status channel would be tidier; the current shape is not
  a workaround that costs correctness.

### Tests And Build

**Commands run:**

```
npm run typecheck                                          clean
npx eslint src/renderer/views/Settings.tsx src/shared/mcpConnection.ts \
  src/main/services/mcpServer.ts tests/mcpConnectionState.test.ts
                                                           0 errors, 1 pre-existing warning
node scripts/run-tests.mjs mcpConnectionState mcpServerSafety
                                                           2 files, 9 pass, 0 fail
```

The one warning is `react-hooks/exhaustive-deps` on an `initialSettings`
dependency at Settings.tsx:2402, which predates this change and belongs to a
different effect.

**Blocking:** none.

**Advisory:**

- The four render branches themselves are not unit-tested, because the repository
  has no renderer test harness and adding one is not this work order's job. The
  decision they branch on is fully tested, and the branches are a direct
  `switch`-like mapping from it.

### User-Facing Verification

**Skipped:** deferred, not skipped.

**Evidence:** none at this commit. This is the one dimension this work order
cannot close on its own: the deliverable is a panel a person reads, and WO-37
changes the same panel's default and copy a few commits later. The lane runs one
pass in the running app afterwards, covering both the resolvable and the
unavailable configuration, and the result is recorded in WO-37's review log and
in the pull request. Recorded here so the gap is visible rather than implied.

**Blocking:** none.

**Advisory:** none.

### Security, Privacy, And Data Safety

**Skipped:** no.

**Blocking:** none.

**Advisory:**

- The panel displays a real local database path and, in a dev build, real
  checkout paths. That is unchanged behavior and is correct: the person needs
  those paths to configure their client, and they never leave the machine. No
  path, key, or personal value enters the repository — the new test fixture uses
  obviously synthetic values.
- The `failed` state prints the IPC error message. That message comes from
  Daylens' own main process, not from user data.

### Round 1 Verdict

- Total blocking: 0
- Total advisory: 7
- Files reviewed: 5 (`src/shared/mcpConnection.ts`,
  `src/renderer/views/Settings.tsx` (mcp section only),
  `src/main/services/mcpServer.ts`, `tests/mcpConnectionState.test.ts`,
  `tests/mcpServerSafety.test.ts`)
- **Verdict:** APPROVED, with the user-facing pass deferred to the end of the lane
  and tracked in WO-37's review log.

---

<!-- Subsequent rounds: copy the structure above and increment the round number. -->
