import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { id, type AuthContext } from '../contracts.js';
import { buildGraphRuntime, graphConfigSchema } from '../public-runtime.js';

// The operator chooses a single OS-local identity, never an MCP argument.
// This config accepts neither a token nor a client-selected path/tenant.
const stdioConfigSchema = graphConfigSchema.extend({
  localPrincipal: z.object({ principal: id, tenant: id }).strict(),
}).strict();

export function buildStdioRuntime(file: string, executable: string) {
  const cfg = stdioConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  const principal: AuthContext = {
    ...cfg.localPrincipal, subject: cfg.localPrincipal.principal,
    issuer: 'https://stdio.invalid', roles: ['reader'], scopes: ['graph:read'],
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
  const runtime = buildGraphRuntime(cfg, executable);
  // Fail closed on a missing/disabled binding before warming a worker.
  const workspace = runtime.workspaces[0]!;
  if (!runtime.service.policy.decide(principal, workspace.workspace, 'capabilities').allow) {
    throw new Error('local identity rejected');
  }
  return { ...runtime, principal };
}
