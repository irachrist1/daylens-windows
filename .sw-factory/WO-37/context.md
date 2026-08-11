<!--lint disable strong-marker-->

# Work Order Entity Index: WO-37

**Initialized At (UTC):** 2026-08-11T10:00:00Z
**Current Status:** in_progress

## Work Order

- WO-37: [backend] Enforce revocable MCP authorization and live privacy evaluation (`befd142c-c65a-4a0a-9a2e-6985d8e23eeb`)
  Read in full from the exported work-order record.
  URL: https://factory.8090.ai/project/45f2f431-ae93-407c-913b-8bce76ba3085/work-orders/37

## Requirements

- REQ-MCP-001: Control local MCP access — AC-MCP-001.1, AC-MCP-001.3,
  AC-MCP-001.4.
- REQ-MCP-002: Protect activity data exposed through local MCP —
  AC-MCP-002.1 through AC-MCP-002.4.

## Blueprints

- MCP Access — request-enforced local authorization boundary, live privacy
  evaluation, and local result protections.

## Referenced Blueprints

- Local MCP Server — the subprocess launch and env passing.
- Agent Tool Layer — the read-only tool catalogue.

## Delivery

- Branch: wave/5-mcp
- Pull Request URL:
