const sensitive=/(?:[a-z]:[\\/]|(?:^|\s)[/\\]|\b(?:token|password|secret|authorization|api[_-]?key)\s*[:=]|\b[A-Za-z_][A-Za-z0-9_]{2,}\s*=|\bBearer\s|ghp_[A-Za-z0-9]+|tskey-[A-Za-z0-9-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.|-----BEGIN|[\r\n\x00-\x1f]|\b[a-z][a-z0-9+.-]*:\/\/)/i;
export function displayText(value:string,max=256){return sensitive.test(value)?'[redacted]':value.slice(0,max);}
export function relativeSource(value:unknown){return typeof value==='string'&&!sensitive.test(value)&&/^[a-z0-9_.\/-]{1,256}$/i.test(value)&&!value.startsWith('/')&&!value.split('/').some(p=>p==='..'||p==='.'||p==='')?value:null;}
export function factValue(key:string,value:unknown):string|number|boolean|null|undefined{
 if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value;
 if(typeof value!=='string')return undefined;
 if(key==='environment'&&/^[a-z][a-z0-9-]{0,31}$/.test(value))return value;
 if(key==='access_mode'&&['read','write','read-only','write-only','read-write','read_write'].includes(value))return value;
 return undefined;
}
