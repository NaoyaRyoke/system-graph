import { createPublicKey, verify, type KeyObject, type JsonWebKey } from 'node:crypto';
import { z } from 'zod';
import { ApiError, principalSchema, type AuthContext, type AuthProvider } from './contracts.js';

export interface IdentityBinding { issuer:string; subject:string; principal:string; tenant:string }
export interface VerificationKey { kid:string; key:KeyObject }
export interface KeySource { get(kid:string):KeyObject|undefined }
/** Keys are provisioned by the operator, never from an untrusted token URL. */
export class PinnedJwks implements KeySource {
 private keys:ReadonlyMap<string,KeyObject> = new Map();
 constructor(jwks:unknown){this.replace(jwks);}
 replace(value:unknown){
  const parsed=z.object({keys:z.array(z.object({kid:z.string().min(1).max(128),kty:z.literal('RSA'),n:z.string(),e:z.string(),use:z.literal('sig').optional(),alg:z.literal('RS256').optional()}).strict()).min(1).max(16)}).strict().parse(value);
  const next=new Map<string,KeyObject>();
  for(const jwk of parsed.keys){if(next.has(jwk.kid))throw new ApiError('invalid_request');const key=createPublicKey({key:jwk as JsonWebKey,format:'jwk'});if((key.asymmetricKeyDetails?.modulusLength??0)<2048)throw new ApiError('invalid_request');next.set(jwk.kid,key);}
  this.keys=next;
 }
 get(kid:string){return this.keys.get(kid);}
}
const claims=z.object({iss:z.string(),aud:z.union([z.string(),z.array(z.string()).min(1).max(8)]),sub:z.string().min(1).max(128),exp:z.number().int(),nbf:z.number().int().optional(),iat:z.number().int().optional(),scope:z.string().max(1024),tenant:z.string().optional()}).passthrough();
export class JwtAuth implements AuthProvider {
 constructor(private readonly issuer:string,private readonly audience:string,private readonly keys:KeySource,private readonly bindings:readonly IdentityBinding[],private readonly now=()=>Date.now()){
  if(new URL(issuer).protocol!=='https:'||new URL(audience).protocol!=='https:')throw new ApiError('invalid_request');
  const ids=bindings.map(b=>JSON.stringify([b.issuer,b.subject]));if(new Set(ids).size!==ids.length)throw new ApiError('invalid_request');
 }
 async authenticate(headers:Readonly<Record<string,string|string[]|undefined>>):Promise<AuthContext>{
  try{
   const value=headers.authorization;if(typeof value!=='string'||!value.startsWith('Bearer ')||value.length>8192)throw 0;
   const parts=value.slice(7).split('.');if(parts.length!==3||parts.some(p=>!/^[A-Za-z0-9_-]+$/.test(p)))throw 0;
   const [h,p,s]=parts as [string,string,string];
   const header=z.object({alg:z.literal('RS256'),typ:z.literal('at+jwt'),kid:z.string().min(1).max(128)}).strict().parse(JSON.parse(Buffer.from(h,'base64url').toString('utf8')));
   const key=this.keys.get(header.kid);if(!key||!verify('RSA-SHA256',Buffer.from(h+'.'+p),key,Buffer.from(s,'base64url')))throw 0;
   const c=claims.parse(JSON.parse(Buffer.from(p,'base64url').toString('utf8'))),now=Math.floor(this.now()/1000);
   if(c.iss!==this.issuer||!(Array.isArray(c.aud)?c.aud:[c.aud]).includes(this.audience)||c.exp<=now||c.exp>now+600||(c.nbf!==undefined&&c.nbf>now)||(c.iat!==undefined&&c.iat>now))throw 0;
   if(!c.scope.split(/\s+/).includes('graph:read'))throw new ApiError('permission_denied');
   const binding=this.bindings.find(b=>b.issuer===c.iss&&b.subject===c.sub);
   if(!binding||(c.tenant!==undefined&&c.tenant!==binding.tenant))throw new ApiError('permission_denied');
   return principalSchema.parse({principal:binding.principal,tenant:binding.tenant,subject:c.sub,issuer:c.iss,roles:['reader'],scopes:['graph:read'],expiresAt:c.exp*1000});
  }catch(e){if(e instanceof ApiError&&e.code==='permission_denied')throw e;throw new ApiError('unauthenticated');}
 }
}
