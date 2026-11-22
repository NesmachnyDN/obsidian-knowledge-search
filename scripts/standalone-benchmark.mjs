import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
await mkdir('.test-build',{recursive:true});
await build({entryPoints:['benchmarks/standalone/run.ts'], outfile:'.test-build/standalone-benchmark.mjs', bundle:true, platform:'node', format:'esm', target:'node22'});
await build({entryPoints:['plugin/src/standalone/worker-entry.ts'],
  outfile:'.test-build/standalone-worker.js',bundle:true,platform:'browser',format:'iife',target:'es2022'});
const result=spawnSync(process.execPath,['.test-build/standalone-benchmark.mjs'],{stdio:'inherit',timeout:60000});
process.exitCode=result.status??1;
