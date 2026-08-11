// One entry point from an MCP tool name to a canonical read capability.
//
// The MCP path publishes only what src/main/services/daylensReadSurface.ts says
// it publishes, and a capability that exists but is unavailable here fails with
// the recorded reason instead of "unknown tool" — a client that asks for a real
// capability deserves to be told why this path cannot serve it.
import type Database from 'better-sqlite3'
import type { TrackingControlsState } from '@shared/trackingControls'
import { executeTool, type ToolName } from '../../../src/main/services/aiTools'
import { executeWrappedTool, type WrappedToolName } from '../../../src/main/services/wrappedTools'
import {
  capabilityById,
  capabilityByToolName,
  isPublished,
  readSurfaceReport,
  type ReadSurfaceReport,
} from '../../../src/main/services/daylensReadSurface'
import { executeComposedRead, isComposedCapabilityId } from './composedReads'

/** Self-description of this path, published as a tool so a client can see the
 *  surface and its stated gaps without reading Daylens source. */
export const DESCRIBE_READ_SURFACE_TOOL = 'describeReadSurface'

export function describeMcpReadSurface(): ReadSurfaceReport {
  return readSurfaceReport('mcp')
}

export class UnavailableCapabilityError extends Error {
  constructor(public readonly capabilityId: string, reason: string) {
    super(`${capabilityId} is not available through the Daylens MCP server. ${reason}`)
    this.name = 'UnavailableCapabilityError'
  }
}

export async function callDaylensReadTool(
  toolName: string,
  params: Record<string, unknown>,
  db: Database.Database,
  controls: TrackingControlsState,
): Promise<unknown> {
  if (toolName === DESCRIBE_READ_SURFACE_TOOL) return describeMcpReadSurface()

  const capability = capabilityByToolName('mcp', toolName)
  if (!capability) {
    // A capability the catalogue knows but this path does not serve: answer with
    // the reason, which is also what describeReadSurface reports.
    const known = capabilityById(toolName)
    if (known) {
      const status = known.paths.mcp
      if (!isPublished(status)) throw new UnavailableCapabilityError(known.id, status.unavailable)
    }
    throw new Error(`Unknown tool: ${toolName}`)
  }

  switch (capability.executor) {
    case 'activity':
      return executeTool(capability.id as ToolName, params, db, controls)
    case 'wrapped':
      // The subprocess holds a read-only handle, so a wrapped tool may not
      // collect a missing external signal; it serves what the app already stored.
      return executeWrappedTool(capability.id as WrappedToolName, params, db, controls, { allowCollect: false })
    case 'composed':
      if (!isComposedCapabilityId(capability.id)) {
        throw new UnavailableCapabilityError(capability.id, 'No adapter is registered for this capability.')
      }
      return executeComposedRead(capability.id, params, db, controls)
  }
}
