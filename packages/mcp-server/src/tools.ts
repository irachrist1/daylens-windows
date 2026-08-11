// The MCP tool manifest, projected from the canonical read surface.
//
// The schemas and descriptions live in src/main/services/daylensReadSurface.ts so
// the MCP path and the in-app chat path describe one capability one way. This
// file only adapts the catalogue to the shape an MCP client expects, and adds the
// describeReadSurface tool that reports what this path cannot serve.
import {
  capabilitiesForPath,
  type ReadCapabilityPublished,
  type ReadCapabilitySchema,
} from '../../../src/main/services/daylensReadSurface'
import { DESCRIBE_READ_SURFACE_TOOL } from './dispatch'

// Anthropic tool-schema shape, which the MCP SDK's inputSchema also accepts.
// Spec: https://docs.anthropic.com/en/api/messages#tools
export interface AnthropicTool {
  name: string
  description: string
  input_schema: ReadCapabilitySchema
}

const DESCRIBE_READ_SURFACE: AnthropicTool = {
  name: DESCRIBE_READ_SURFACE_TOOL,
  description:
    'Describe the Daylens read surface this server exposes: every available capability with the tool name it is '
    + 'published under, and every capability that is unavailable here together with the reason and the alternative. '
    + 'Call this when a Daylens fact you expected has no matching tool, before telling the user it cannot be known.',
  input_schema: { type: 'object', properties: {}, required: [] },
}

export function mcpToolManifest(): AnthropicTool[] {
  const capabilities = capabilitiesForPath('mcp').map((capability) => ({
    name: (capability.paths.mcp as ReadCapabilityPublished).toolName,
    description: capability.description,
    input_schema: capability.inputSchema,
  }))
  return [...capabilities, DESCRIBE_READ_SURFACE]
}
