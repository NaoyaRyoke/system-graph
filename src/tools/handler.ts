import type { CallToolResult } from '@modelcontextprotocol/server';
import { safeError, type AuthContext, type Operation } from '../contracts.js';
import type { QueryService } from '../service.js';

export interface ToolContext {
  service: QueryService;
  principal: AuthContext;
  signal: AbortSignal;
}

// Public graph projection stays in QueryService; every transport uses this envelope.
export const handlerFor = (operation: Exclude<Operation, 'health'>) =>
  async (context: ToolContext, args: unknown): Promise<CallToolResult> => {
    try {
      const result = await context.service.execute(context.principal, operation, args, context.signal);
      return { content: [{ type: 'text', text: 'Read-only graph result.' }], structuredContent: result };
    } catch (error) {
      const e = safeError(error);
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: e.code, retryAfter: e.retryAfter } }) }] };
    }
  };
