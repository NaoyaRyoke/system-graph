import { z } from 'zod';
const scalar=z.union([z.string(),z.number().finite(),z.boolean(),z.null()]);
export const nodeView=z.object({id:z.string().max(180),kind:z.string().max(64),label:z.string().max(256),facts:z.record(z.string(),scalar)}).strict();
export const edgeView=z.object({id:z.string().max(180),source:z.string().max(180),target:z.string().max(180),kind:z.string().max(64)}).strict();
const reason=z.string().max(128).nullable();
export const responseSchemas={
 health:z.object({status:z.literal('alive')}).strict(),
 capabilities:z.object({apiVersion:z.literal('1.0'),operations:z.array(z.enum(['query','impact','trace','explain','inventory'])),management:z.literal(false),limits:z.object({nodes:z.number(),edges:z.number(),provenance:z.number(),bytes:z.number(),depth:z.number()}).strict()}).strict(),
 query:z.object({hits:z.array(nodeView.extend({score:z.number().finite()})).max(50),totalMatches:z.number().int().nonnegative(),coverage:z.object({inputNodes:z.number().int().nonnegative(),eligibleNodes:z.number().int().nonnegative(),semantics:z.literal('native-ranked-lexical.v1')}).strict(),truncated:z.boolean(),reason}).strict(),
 impact:z.object({target:nodeView,items:z.array(nodeView.extend({classification:z.string().max(64),depth:z.number().int().min(0).max(12)})).max(50),risk:z.enum(['LOW','MEDIUM','HIGH','CRITICAL','UNKNOWN']),truncated:z.boolean(),reason,coverageIncomplete:z.literal(true)}).strict(),
 trace:z.object({segments:z.array(z.object({from:nodeView,to:nodeView,edge:edgeView}).strict()).max(12),truncated:z.boolean(),reason,coverageGaps:z.array(z.string().max(256)).max(32)}).strict(),
 explain:z.object({target:z.string().max(180),kind:z.enum(['node','edge','result']),provenance:z.array(z.object({property:z.string().max(128),value:scalar,sourceFile:z.string().max(512).nullable(),sourcePointer:z.string().max(512),extractor:z.string().max(128),origin:z.string().max(64)}).strict()).max(16),evidence:z.array(z.object({id:z.string().max(180),extractor:z.string().max(128),origin:z.string().max(64),confidence:z.number().finite().min(0).max(1)}).strict()).max(16),truncated:z.boolean(),reason}).strict(),
 inventory:z.object({nodes:z.array(nodeView).max(50),repositories:z.array(z.string().max(180)).max(50),services:z.array(nodeView).max(50),resources:z.array(nodeView).max(50),environments:z.array(z.string().max(128)).max(16),facetsScope:z.literal('current_page'),edges:z.array(edgeView).max(100),totalNodes:z.number().int().nonnegative(),totalEdges:z.number().int().nonnegative(),truncated:z.boolean(),reason,nextOffset:z.number().int().nonnegative().nullable()}).strict(),
};
export type ResponseMap={ [K in keyof typeof responseSchemas]:z.infer<typeof responseSchemas[K]> };
export type QueryResponse=ResponseMap['query'];
export type ImpactResponse=ResponseMap['impact'];
export type TraceResponse=ResponseMap['trace'];
export type ExplainResponse=ResponseMap['explain'];
export type InventoryResponse=ResponseMap['inventory'];
