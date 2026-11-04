import { z } from 'zod';
export const API_VERSION='1.0', ENGINE_CONTRACT='1.2.2-hardening.1', MAX_RESPONSE_BYTES=262144;
export const operations=['health','capabilities','query','impact','trace','explain','inventory'] as const;
export type Operation=typeof operations[number];
export type ErrorCode='invalid_request'|'permission_denied'|'unauthenticated'|'rate_limited'|'busy'|'engine_crash'|'engine_timeout'|'invalid_engine_response'|'incompatible_api'|'unsupported_capability'|'graph_unavailable'|'response_too_large'|'internal_error'|'cancelled'|'not_found'|'resource_limit';
export class ApiError extends Error{constructor(public readonly code:ErrorCode,public readonly retryable=false,public readonly retryAfter=0){super(code);}}
export const safeError=(v:unknown)=>v instanceof ApiError?v:new ApiError('internal_error');
export const id=z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const opaque=z.string().regex(/^[A-Za-z0-9:_-]{1,180}$/);
const scope={workspace:id,environments:z.array(id).min(1).max(16).optional(),repositories:z.array(id).min(1).max(16).optional()};
export const queryInput=z.object({...scope,query:z.string().trim().min(1).refine(v=>Buffer.byteLength(v)<=256),limit:z.number().int().min(1).max(50).default(10)}).strict();
export const inputs={query:queryInput,impact:z.object({...scope,target:opaque,direction:z.enum(['upstream','downstream','both']).default('upstream'),maxDepth:z.number().int().min(1).max(12).default(8),limit:z.number().int().min(1).max(50).default(20)}).strict(),trace:z.object({...scope,source:opaque,destination:opaque,maxDepth:z.number().int().min(1).max(12).default(8)}).strict(),explain:z.object({...scope,target:opaque,kind:z.enum(['node','edge','result']).default('node')}).strict(),inventory:z.object({...scope,limit:z.number().int().min(1).max(50).default(20),offset:z.number().int().min(0).max(10000).default(0)}).strict(),health:z.object(scope).strict(),capabilities:z.object(scope).strict()};
export const principalSchema=z.object({principal:id,subject:z.string().min(1).max(128),issuer:z.url(),tenant:id,roles:z.array(id).max(16),scopes:z.array(z.string().max(64)).max(32),expiresAt:z.number().finite()}).strict();
export type AuthContext=z.infer<typeof principalSchema>;
export interface AuthProvider{authenticate(headers:Readonly<Record<string,string|string[]|undefined>>,signal?:AbortSignal):Promise<AuthContext>}
export interface WorkspaceRegistration{tenant:string;workspace:string;engineWorkspace:string;database:string;repositories:Readonly<Record<string,string>>;repoRoots:readonly string[];allowedEnvironments:readonly string[];status:'active'|'disabled'}
export interface Permission{principal:string;tenant:string;workspace:string;environments:readonly string[];repositories:readonly string[];operations:readonly Operation[]}
export interface EnginePort{negotiate():Promise<void>;call(operation:Operation,params?:unknown,signal?:AbortSignal):Promise<unknown>;close():Promise<void>}
export interface AuditEvent{requestId:string;principal:string;tenant:string;workspace:string;operation:string;environments:readonly string[];allowed:boolean;durationMs:number;resultCount:number;outcome:string}
export interface AuditHook{record(v:AuditEvent):void}
export interface MetricsHook{observe(operation:string,value:number,outcome:string):void}
export interface RateLimitHook{admit(key:string):{allow:boolean;retryAfter:number}}
export const capabilitiesSchema=z.object({api_version:z.literal(API_VERSION),engine_contract:z.literal(ENGINE_CONTRACT),operations:z.array(z.string()),graph_schema:z.string().min(1),environment_pre_filter:z.literal(true),explicit_false:z.literal(true),management:z.literal(false)}).passthrough();
export const nativeNode=z.object({id:opaque,label:z.string().max(4096),kind:z.string().max(64),repo_id:z.string().nullable(),properties:z.record(z.string(),z.object({value:z.unknown()}).passthrough()).default({})}).passthrough();
export const nativeEdge=z.object({id:opaque,source:opaque,target:opaque,kind:z.string()}).passthrough();
export const reportSchema=z.object({hits:z.array(z.object({node:nativeNode,score:z.number().finite()}).passthrough()).max(50),total_matches:z.number().int().nonnegative(),limit:z.number().int().max(50),coverage:z.object({input_nodes:z.number().nonnegative(),eligible_nodes:z.number().nonnegative()}).passthrough(),truncated:z.boolean().optional()}).passthrough();
