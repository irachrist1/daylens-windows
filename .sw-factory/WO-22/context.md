<!--lint disable strong-marker-->

# Work Order Entity Index: WO-22

**Initialized At (UTC):** 2026-08-11T09:45:00Z
**Current Status:** in_progress

## Work Order

- WO-22: [backend] Isolate and attribute untrusted Chat MCP output (`18c0ec6c-4d13-4a49-9232-b4a33ffbcd44`)
  Read in full from the exported work-order record.
  URL: https://factory.8090.ai/project/45f2f431-ae93-407c-913b-8bce76ba3085/work-orders/22

## Requirements

- REQ-MCP-006: Contain untrusted Chat MCP results — AC-MCP-006.1 through
  AC-MCP-006.4.

## Blueprints

- MCP Access — untrusted Chat MCP result handling, unique tool identity, and
  source attribution.

## Referenced Blueprints

- Agent Tool Layer — `wrapMcpToolsWithGuards` as the privacy boundary for MCP
  tool output.

## Delivery

- Branch: wave/5-mcp
- Pull Request URL:
