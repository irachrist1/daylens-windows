<!--lint disable strong-marker-->

# Work Order Entity Index: WO-19

**Initialized At (UTC):** 2026-08-11T09:10:25Z
**Current Status:** in_progress

## Work Order

- WO-19: [backend] Persist and manage explicit Chat MCP servers (`f6744502-06bb-4ea8-9dc2-125f391a066c`)
  Read in full from the exported work-order record.
  URL: https://factory.8090.ai/project/45f2f431-ae93-407c-913b-8bce76ba3085/work-orders/19

## Requirements

- REQ-MCP-004: Configure Chat MCP servers — AC-MCP-004.1 through AC-MCP-004.4.

## Blueprints

- MCP Access — persisted, user-managed `McpServerConfig` entries and their
  chat-turn eligibility.

## Referenced Blueprints

- Local MCP Server — the `{ command, args, env }` shape shared with Claude
  Desktop entries, which the chat MCP server config mirrors.
- Agent Tool Layer — `connectMcpTools` as the single entry point that turns
  configured servers into tool definitions for the agent loop.

## Delivery

- Branch: wave/5-mcp
- Pull Request URL:
