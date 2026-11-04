import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { API_VERSION, ApiError, capabilitiesSchema, type EnginePort, type Operation } from './contracts.js';

export interface EngineOptions {
  readonly executable: string; readonly args: readonly string[];
  readonly timeoutMs?: number; readonly maxResponseBytes?: number; readonly expectedGraphSchema?: string; readonly requiredOperations?: readonly Operation[];
}
const envelope = z.object({ api_version: z.literal(API_VERSION), id: z.string(), ok: z.boolean(), result: z.unknown().optional(), error: z.object({ code: z.string(), retryable: z.boolean() }).optional() }).strict();
const engineErrors = new Set(['invalid_request', 'incompatible_api', 'unsupported_capability', 'graph_unavailable', 'engine_failure', 'not_found', 'resource_limit']);
export class RustClient implements EnginePort {
  private process: ChildProcessWithoutNullStreams | undefined;
  private exit: Promise<void> | undefined;
  private pending: { id: string; resolve: (v: unknown) => void; reject: (e: ApiError) => void; timer: NodeJS.Timeout; signal: AbortSignal | undefined; abort: (()=>void) | undefined } | undefined;
  private buffer = Buffer.alloc(0);
  private failed = false;
  private ready = false;
  constructor(private readonly options: EngineOptions) {}
  get available(): boolean { return !this.failed; }
  get pid(): number | undefined { return this.process?.pid; }
  private fail(error: ApiError): void {
    this.failed = true;
    if (this.pending) { clearTimeout(this.pending.timer); if(this.pending.abort)this.pending.signal?.removeEventListener("abort",this.pending.abort); this.pending.reject(error); this.pending = undefined; }
    this.process?.kill();
  }
  private spawn(): void {
    if (this.process || this.failed) throw new ApiError('engine_crash');
    const env:NodeJS.ProcessEnv={};
    for(const key of ['SystemRoot','WINDIR','PATH','TEMP','TMP'])if(process.env[key]!==undefined)env[key]=process.env[key];
    this.process = spawn(this.options.executable, [...this.options.args], { shell: false, windowsHide: true, stdio: 'pipe', env });
    const child = this.process;
    this.exit = new Promise(resolve => { child.once('close', () => { this.fail(new ApiError('engine_crash', true)); resolve(); }); });
    child.on('error', () => this.fail(new ApiError('engine_crash', true)));
    // Drain diagnostics without reflecting arbitrary source, query or secret text into logs.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => this.fail(new ApiError('engine_crash', true)));
    child.stdout.on('data', (chunk: Buffer) => {
      const max = this.options.maxResponseBytes ?? 1_048_576;
      if (this.buffer.length + chunk.length > max) { this.fail(new ApiError('response_too_large')); return; }
      this.buffer = Buffer.concat([this.buffer, chunk]);
      const end = this.buffer.indexOf(10);
      if (end < 0) return;
      const bytes = this.buffer.subarray(0, end); this.buffer = this.buffer.subarray(end + 1);
      if (!this.pending || this.buffer.length) { this.fail(new ApiError('invalid_engine_response')); return; }
      const pending = this.pending;
      try {
        const raw: unknown = JSON.parse(bytes.toString('utf8'));
        if (typeof raw === 'object' && raw !== null && 'api_version' in raw && raw.api_version !== API_VERSION) throw new ApiError('incompatible_api');
        const v = envelope.parse(raw);
        if (v.id !== pending.id || (v.ok && (!('result' in v) || v.error)) || (!v.ok && (!v.error || 'result' in v))) throw new ApiError('invalid_engine_response');
        clearTimeout(pending.timer); if(pending.abort)pending.signal?.removeEventListener("abort",pending.abort); this.pending = undefined;
        if (!v.ok) {
          const code = v.error?.code;
          pending.reject(new ApiError(code === 'engine_failure' ? 'internal_error' : engineErrors.has(code ?? '') ? code as 'invalid_request' : 'invalid_engine_response'));
        } else pending.resolve(v.result);
      } catch (error) { this.fail(error instanceof ApiError ? error : new ApiError('invalid_engine_response')); }
    });
  }
  async call(operation: Operation, params: unknown = {}, signal?:AbortSignal): Promise<unknown> {
    if(signal?.aborted)throw new ApiError('cancelled');
    if (this.failed) throw new ApiError('engine_crash', true);
    if (!this.process) this.spawn();
    if (this.pending) throw new ApiError('busy', true);
    const id = randomUUID();
    const bytes = JSON.stringify({ api_version: API_VERSION, id, operation, params }) + '\n';
    if (Buffer.byteLength(bytes) > 65_536) throw new ApiError('invalid_request');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new ApiError('engine_timeout', true)), this.options.timeoutMs ?? 5000);
      const abort=signal?()=>this.fail(new ApiError("cancelled")):undefined;
      this.pending = { id, resolve, reject, timer, signal, abort };
      if(abort)signal?.addEventListener("abort",abort,{once:true});
      this.process?.stdin.write(bytes);
    });
  }
  private negotiation:Promise<void>|undefined;
  async negotiate():Promise<void>{this.negotiation??=this.negotiateOnce();await this.negotiation;}
  private async negotiateOnce(): Promise<void> {
    if (this.ready) return;
    try{z.object({status:z.literal('alive')}).passthrough().parse(await this.call('health'));}catch(e){throw e instanceof ApiError?e:new ApiError('invalid_engine_response');}
    let caps;
    try { caps = capabilitiesSchema.parse(await this.call('capabilities')); }
    catch (e) { if (e instanceof ApiError) throw e; throw new ApiError('incompatible_api'); }
    if (!(this.options.requiredOperations??['query']).every(op=>caps.operations.includes(op)))throw new ApiError('unsupported_capability');
    if(this.options.expectedGraphSchema && caps.graph_schema!==this.options.expectedGraphSchema)throw new ApiError('incompatible_api');
    this.ready = true;
  }
  async close(): Promise<void> {
    if (this.pending) this.fail(new ApiError('engine_crash'));
    this.process?.stdin.end();
    if (!this.process) return;
    const deadline = setTimeout(() => this.process?.kill(), 1000);
    await this.exit; clearTimeout(deadline);
  }
}
