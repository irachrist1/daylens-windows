<!--lint disable strong-marker-->

# Work Order Entity Index: WO-15

**Initialized At (UTC):** 2026-08-11T08:38:20Z
**Current Status:** in_progress

## Work Order

- WO-15: [backend] Establish the canonical Daylens MCP read surface (`a185dfe1-da3d-4998-bdd2-cd7d1902f187`)
  Read in full from the exported work-order record
  (`~/Downloads/daylens-work-orders-2026-08-11-092326.csv`, Description column).

## Requirements

- REQ-MCP-007: Maintain one Daylens MCP read surface — AC-MCP-007.1, AC-MCP-007.2, AC-MCP-007.3.
  Read from the work-order record and `~/Downloads/Daylens_Combined_Requirements.md`.

## Blueprints

- MCP Access (`~/Downloads/Daylens_Combined_Blueprints.md`, line 2924)
  Feature blueprint. Components #DaylensMcpServer, #DaylensToolExecutor,
  #McpSettingsController, #ChatMcpToolPool, #ChatMcpClient. ADR-002 is the one
  this work order implements.

## Referenced Blueprints

Blueprints reached through `@…` mentions and links while reading linked blueprints.

- Local MCP Server (container blueprint, line 449) — the stdio server's own
  contracts, including the launch-time-snapshot gap WO-37 closes.
- Agent Tool Layer (capability blueprint, line 972) — #ActivityToolExecutor,
  #WrappedToolExecutor, #DaylensChatTools, and the explicit statement that "Chat
  and MCP do not expose one proven identical tool set".
- Timeline (line 1967) and Apps (line 1426) — the other two surfaces AC-MCP-007.2
  names; read to confirm they consume the same corrected activity facts the
  executors read, so aligning MCP with the executors aligns it with them.

## Local sources of truth read

- `docs/specs/agent-runtime-and-context.md` — user-configured MCP servers as a
  consented tool source, untrusted results.
- `docs/specs/capture-and-evidence.md` — "No renderer, AI tool, MCP tool, sync
  encoder, or product surface may query a raw evidence table directly", enforced
  by `tests/repositoryBoundary.test.ts`.
- `docs/specs/privacy-retention-and-sync.md` — MCP access is a separate
  permission with a visible state.

## Delivery

- Branch: wave/5-mcp
- Pull Request URL:
