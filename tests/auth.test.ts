import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync,sign } from 'node:crypto';
import { JwtAuth,PinnedJwks } from '../src/auth.js';
import { ApiError } from '../src/contracts.js';
const pair=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...pair.publicKey.export({format:'jwk'}),kid:'key-one',use:'sig',alg:'RS256'};
const keys=new PinnedJwks({keys:[jwk]});
const now=()=>1_800_000_000_000;
const auth=new JwtAuth('https://issuer.invalid','https://graph.invalid/mcp',keys,[{issuer:'https://issuer.invalid',subject:'synthetic-subject',principal:'reader',tenant:'tenant-a'}],now);
const good={iss:'https://issuer.invalid',aud:'https://graph.invalid/mcp',sub:'synthetic-subject',exp:now()/1000+300,scope:'graph:read',tenant:'tenant-a'};
function token(overrides:Record<string,unknown>={},header:Record<string,unknown>={}){const h=Buffer.from(JSON.stringify({alg:'RS256',typ:'at+jwt',kid:'key-one',...header})).toString('base64url'),p=Buffer.from(JSON.stringify({...good,...overrides})).toString('base64url');return h+'.'+p+'.'+sign('RSA-SHA256',Buffer.from(h+'.'+p),pair.privateKey).toString('base64url');}
test('verified access token maps explicit issuer/subject to a server-defined tenant',async()=>{const result=await auth.authenticate({authorization:'Bearer '+token(),'x-tenant':'tenant-b'});assert.equal(result.tenant,'tenant-a');assert.deepEqual(result.scopes,['graph:read']);assert.ok(!JSON.stringify(result).includes(token()));});
for(const [name,claims,header]of [
 ['expired',{exp:now()/1000},{}],['issuer',{iss:'https://other.invalid'},{}],['audience',{aud:'https://other.invalid'},{}],['subject',{sub:''},{}],['future nbf',{nbf:now()/1000+1},{}],['scope',{scope:'graph:write'},{}],['unregistered',{sub:'other'},{}],['tenant',{tenant:'tenant-b'},{}],['long lived',{exp:now()/1000+601},{}],['none',{}, {alg:'none'}],['ID token',{}, {typ:'JWT'}],['unknown key',{}, {kid:'absent'}],['remote JWK injection',{}, {jku:'https://attacker.invalid'}]
] as const)test('JWT rejects '+name,async()=>{await assert.rejects(auth.authenticate({authorization:'Bearer '+token(claims,header)}),(e:unknown)=>e instanceof ApiError);});
test('signature corruption is rejected and key rotation fails closed',async()=>{const bad=token().split('.');bad[2]=Buffer.alloc(256).toString('base64url');await assert.rejects(auth.authenticate({authorization:'Bearer '+bad.join('.')}));const replacement=generateKeyPairSync('rsa',{modulusLength:2048});keys.replace({keys:[{...replacement.publicKey.export({format:'jwk'}),kid:'key-two',use:'sig',alg:'RS256'}]});await assert.rejects(auth.authenticate({authorization:'Bearer '+token()}));assert.throws(()=>keys.replace({keys:[jwk,jwk]}));keys.replace({keys:[jwk]});assert.equal((await auth.authenticate({authorization:'Bearer '+token()})).tenant,'tenant-a');});
