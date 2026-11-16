/** The supported endpoint identity is method + HTTP(S) origin + pathname. */
export function normalizeEndpoint(method:string,address:string,base?:string){
  const url=new URL(address,base);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||/[{}]/.test(address))throw new Error('unsupported_endpoint');
  return {key:`${method.toUpperCase()} ${url.origin}${url.pathname}`,method:method.toUpperCase(),endpoint:url.origin+url.pathname};
}
/** OpenAPI appends the operation path to the Server URL; it is not URL resolution. */
export function openApiEndpoint(method:string,server:string,path:string){
  const url=new URL(server);
  if(!path.startsWith('/')||path.startsWith('//')||/[{}?#]/.test(path)||url.search||url.hash||/[{}]/.test(server))throw new Error('unsupported_openapi_path');
  url.pathname=url.pathname.replace(/\/+$/,'')+path;
  return normalizeEndpoint(method,url.href);
}
