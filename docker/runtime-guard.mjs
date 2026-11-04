// Packaging mitigation for environment/catalog and resolver-search preconditions.
import {readFileSync}from'node:fs';
export function verifyRuntime(environment=process.env,resolv=readFileSync('/etc/resolv.conf','utf8')){
 for(const key of ['LANGUAGE','LOCALDOMAIN','RES_OPTIONS','LD_PRELOAD','LD_LIBRARY_PATH','GCONV_PATH'])if(environment[key])throw Error('unsafe runtime environment');
 for(const line of resolv.split('\n')){const fields=line.replace(/#.*/,'').trim().split(/\s+/);if(['search','domain'].includes(fields[0])&&fields.slice(1).some(v=>Buffer.byteLength(v)>180))throw Error('unsafe resolver configuration');}
 return true;
}
