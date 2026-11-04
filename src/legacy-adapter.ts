import { legacyStatelessFallback,type McpServer } from '@modelcontextprotocol/server';
export const legacyAdapter=(factory:()=>McpServer)=>legacyStatelessFallback(factory);
