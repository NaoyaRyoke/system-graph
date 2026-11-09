import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import type { ToolContext } from './handler.js';
import { capabilitiesTool } from './capabilities.js';
import { explainTool } from './explain.js';
import { impactTool } from './impact.js';
import { inventoryTool } from './inventory.js';
import { queryTool } from './query.js';
import { traceTool } from './trace.js';

export const graphTools = [capabilitiesTool, explainTool, impactTool, inventoryTool, queryTool, traceTool] as const;

export function registerGraphTools(server: McpServer, context: ToolContext): void {
  for (const tool of graphTools) {
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, async (args: unknown, request: ServerContext) => tool.handler({
      ...context,
      signal: AbortSignal.any([context.signal, request.mcpReq.signal]),
    }, args));
  }
}
