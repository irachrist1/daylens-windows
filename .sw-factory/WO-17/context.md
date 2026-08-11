<!--lint disable strong-marker-->

# Work Order Entity Index: WO-17

**Initialized At (UTC):** 2026-08-11T09:12:00Z
**Current Status:** in_progress

## Work Order

- WO-17: [renderer] Deliver usable local MCP configuration in Settings (`0e9a7da8-35ed-4eb4-913c-f677dd03d267`)
  Read in full from the exported work-order record.
  URL: https://factory.8090.ai/project/45f2f431-ae93-407c-913b-8bce76ba3085/work-orders/17

## Requirements

- REQ-MCP-001: Control local MCP access — AC-MCP-001.2 only (the rest belongs to WO-37).
- REQ-MCP-003: Configure local MCP access in Daylens — AC-MCP-003.1 to AC-MCP-003.4.

## Blueprints

- MCP Access — the #McpSettingsController contract: display and change the local
  access setting, retrieve connection configuration over `IPC.MCP.GET_CONFIG`,
  and "represent unavailable server bundles as unavailable configuration, not as
  connection-ready data".

## Referenced Blueprints

- Local MCP Server — what makes a configuration usable: the packaged bundle at
  `dist/mcp-server/index.cjs`, or the loader plus source entry in a dev checkout.
  `getMcpServerConfig()` returns null when neither resolves, which is the
  unavailable case this work order has to show.
- Desktop Application (Electron) — the renderer reaches the main process only
  through the preload IPC surface, so the renderer cannot resolve these paths
  itself.

## Delivery

- Branch: wave/5-mcp
- Pull Request URL:
