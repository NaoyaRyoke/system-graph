#!/usr/bin/env node
import { buildStdioRuntime } from './graph/stdio-runtime.js';
import { listenStdio } from './transports/stdio.js';

async function main(): Promise<void> {
  const config = process.argv[2] ?? process.env.SYSTEM_GRAPH_CONFIG;
  const executable = process.argv[3] ?? process.env.SYSTEM_GRAPH_ENGINE;
  if (!config || !executable || process.argv.length > 4) throw new Error('explicit configuration required');
  const runtime = buildStdioRuntime(config, executable);
  const abort = new AbortController();
  let transport: ReturnType<typeof listenStdio> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => stopping ??= (async () => {
    abort.abort();
    await transport?.close();
    // SDK transport pauses stdin; release the owned pipe even if the client keeps it open.
    process.stdin.destroy();
    await runtime.close();
    process.off('SIGINT', signalStop);
    process.off('SIGTERM', signalStop);
  })();
  const signalStop = () => { void stop().catch(fatal); };
  try {
    await runtime.warm();
    transport = listenStdio({ service: runtime.service, principal: runtime.principal, signal: abort.signal },
      () => { void stop().catch(fatal); });
    process.on('SIGINT', signalStop);
    process.on('SIGTERM', signalStop);
    process.stderr.write('READY: read-only graph stdio server\n');
  } catch {
    await stop();
    throw new Error('startup rejected');
  }
}
function fatal(): void {
  process.stderr.write('FAIL: startup rejected\n');
  process.exitCode = 1;
}
void main().catch(fatal);
