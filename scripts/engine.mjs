import { resolve } from 'node:path';
export const executable=process.env.ENGINE_BINARY??resolve('target/debug/hybrid-engine-host'+(process.platform==='win32'?'.exe':''));
export const generator=process.env.SAMPLE_GENERATOR??resolve('target/debug/sample_graph'+(process.platform==='win32'?'.exe':''));
