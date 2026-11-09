import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import { createGraphServer } from '../server/index.js';
import type { ToolContext } from '../tools/handler.js';

export function listenStdio(context: ToolContext, onclose: () => void) {
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 16384 });
  const handle = serveStdio(() => createGraphServer(context), {
    transport, legacy: 'serve',
    onerror: () => { process.stderr.write('WARN: MCP transport error\n'); },
  });
  const closed = transport.onclose;
  transport.onclose = () => { closed?.(); onclose(); };
  return handle;
}
