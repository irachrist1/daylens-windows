<!--lint disable strong-marker-->

# Work Order Entity Index: WO-20

**Initialized At (UTC):** 2026-08-11T09:30:00Z
**Current Status:** in_progress

## Work Order

- WO-20: [backend] Harden Chat MCP process isolation and lifecycle (`d1342cc3-29af-43da-8d9a-da6f7145526e`)
  Read in full from the exported work-order record.
  URL: https://factory.8090.ai/project/45f2f431-ae93-407c-913b-8bce76ba3085/work-orders/20

## Requirements

- REQ-MCP-005: Isolate Chat MCP servers during a chat turn — AC-MCP-005.1
  through AC-MCP-005.5.

## Blueprints

- MCP Access — the one-turn Chat MCP client pool, minimal child environment,
  and lifecycle contracts.

## Referenced Blueprints

- Agent Tool Layer — `connectMcpTools` as the single entry point.
- Local MCP Server — the `{ command, args, env }` shape and the minimal child
  environment.

## Delivery

- Branch: wave/5-mcp
- Pull Request URL:
