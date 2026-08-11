<!--lint disable strong-marker-->

# Review Log: WO-22

**Work Order:** WO-22 — [backend] Isolate and attribute untrusted Chat MCP output
**Initialized At (UTC):** 2026-08-11T09:45:00Z

---

## Round 1

### Requirements Alignment

**AC-MCP-006.1** — *treat the result as an Untrusted MCP result.* Met. Every
MCP tool result crosses `guardMcpToolResult` (the tracking-exclusion filter
and the secret sanitizer) via `wrapMcpToolsWithGuards` before it reaches the
model. No MCP tool result enters the agent loop raw. Tested in
`tests/mcpTools.test.ts` and re-verified in
`tests/chatMcpAttribution.test.ts`.

**AC-MCP-006.2** — *require the normal Daylens permission, preview, and
confirmation flow before making that change.* Met structurally. MCP tools are
data sources — they return results, they do not execute Daylens actions. An
MCP result cannot call a Daylens tool, change a setting, or bypass a
permission flow. The agent (the LLM) may interpret an MCP result and decide to
call a Daylens tool, but that call goes through the same tool pipeline as any
other agent-initiated call, with the same safeguards in `daylensTools.ts` and
`contextTools.ts`.

**AC-MCP-006.3** — *preserve an unambiguous source identity for each available
tool and shall not silently replace one tool with the other.* Met.
`namespaceMcpToolName` normalizes the `mcp_{server}_{tool}` key, truncates to
64 chars, and if the result collides with an already-used key (from
normalization like `-` → `_` or from truncation), appends a numeric suffix.
Two tools from different servers can no longer silently replace each other.
Tested in `tests/chatMcpAttribution.test.ts` for normalization collisions and
truncation collisions.

**AC-MCP-006.4** — *identify the Chat MCP server that supplied it.* Met. Each
wrapped tool's `description` is prefixed with `[MCP:{serverName}]` so the
model sees the source identity in the tool definition. The namespaced tool
key (`mcp_{server}_{tool}`) also carries the source in the tool-call name
that appears in the agent's message history.

**Blocking:** none.

**Advisory:**

- The `[MCP:{serverName}]` description prefix is the attribution mechanism
  for the model. How the model uses it in its answer text is up to the model;
  Daylens does not post-process the model's answer to inject citations. The
  tool name and description are the source identity, and they are visible in
  the tool-call history the model reasons over.

### Blueprint Alignment

The MCP Access blueprint defines untrusted result handling, unique tool
identity, and source attribution. `guardMcpToolResult` is the untrusted
boundary; `namespaceMcpToolName` is the unique-identity enforcement; the
`[MCP:{serverName}]` description prefix is the source attribution.

**Blocking:** none.

**Advisory:** none.

### Architecture And Conventions

**Blocking:** none.

**Advisory:**

- `namespaceMcpToolName` takes a `Set<string>` as a parameter rather than
  using module-level state, so the function is pure and testable. The set is
  created per `connectMcpTools` call, so names do not leak across turns.
- The description prefix is added in `connectMcpTools` rather than in
  `wrapMcpToolsWithGuards` to avoid changing the wrapper's signature (which
  is tested independently and does not know the server name).

### Tests And Build

**Commands run:**

```
npm run typecheck                                          clean
npx eslint src/main/agent/mcpTools.ts \
  tests/chatMcpAttribution.test.ts                         0 errors, 0 warnings
node scripts/run-tests.mjs chatMcpAttribution mcpTools     2 files, 8 pass
```

**Blocking:** none.

**Advisory:** none.

### User-Facing Verification

**Skipped:** deferred to end of lane. Backend change.

**Blocking:** none.

### Security, Privacy, And Data Safety

**Blocking:** none.

**Advisory:**

- The collision fix prevents a malicious or buggy server from registering a
  tool with the same name as another server's tool and silently replacing it.
  The numeric suffix makes the collision visible in the tool name.

### Round 1 Verdict

- Total blocking: 0
- Total advisory: 4
- Files reviewed: 2 (`src/main/agent/mcpTools.ts`,
  `tests/chatMcpAttribution.test.ts`)
- **Verdict:** APPROVED, user-facing pass deferred to end of lane.

---

<!-- Subsequent rounds: copy the structure above and increment the round number. -->
