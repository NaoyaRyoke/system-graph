import { McpServer } from '@modelcontextprotocol/server';
import { registerGraphTools } from '../tools/index.js';
import type { ToolContext } from '../tools/handler.js';

// Keep beta server identity and discovery/cache behavior compatible.
export const serverMetadata = { name: 'synthetic-system-graph', version: '0.2.0' } as const;
export function createGraphServer(context: ToolContext): McpServer {
  const server = new McpServer(serverMetadata, {
    capabilities: { tools: {} },
    cacheHints: {
      'tools/list': { ttlMs: 0, cacheScope: 'private' },
      'server/discover': { ttlMs: 0, cacheScope: 'private' },
    },
  });
  registerGraphTools(server, context);
  return server;
}
