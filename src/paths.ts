import { lstatSync,realpathSync,statSync } from 'node:fs';
import { isAbsolute,relative,resolve,sep,parse } from 'node:path';
import { ApiError } from './contracts.js';
/** Operator-only registry path. Reject links/junctions at every component. */
export function registeredFile(root:string,candidate:string){
 if(!isAbsolute(root)||!isAbsolute(candidate)||candidate.includes('\0')||candidate.split(/[\\/]/).includes('..'))throw new ApiError('invalid_request');
 const base=realpathSync(root),target=resolve(candidate),rel=relative(base,target);
 if(isAbsolute(rel)||!rel||rel==='..'||rel.startsWith('..'+sep))throw new ApiError('invalid_request');
 let cursor=parse(target).root;
 for(const segment of target.slice(cursor.length).split(sep)){cursor=resolve(cursor,segment);if(lstatSync(cursor).isSymbolicLink())throw new ApiError('invalid_request');}
 const canonical=realpathSync(target),finalRel=relative(base,canonical);
 if(isAbsolute(finalRel)||finalRel.startsWith('..'+sep)||finalRel==='..'||!statSync(canonical).isFile())throw new ApiError('invalid_request');
 return canonical;
}
