import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const args=process.argv.slice(2);
if(args.length!==1||!['--capture','--fixture'].includes(args[0])) throw Error('MODE_INVALID');
await mkdir('.test-build',{recursive:true});
await build({entryPoints:['benchmarks/rerank/run.ts'],outfile:'.test-build/rerank-benchmark.mjs',
  bundle:true,platform:'node',format:'esm',target:'node22'});
await build({entryPoints:['plugin/src/standalone/worker-entry.ts'],outfile:'.test-build/standalone-worker.js',
  bundle:true,platform:'browser',format:'iife',target:'es2022'});
const result=spawnSync(process.execPath,['.test-build/rerank-benchmark.mjs',...args],{stdio:'inherit',timeout:60000});
process.exitCode=result.status??1;
