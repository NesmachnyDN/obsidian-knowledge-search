import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const out=process.argv[2]??'build/acceptance-evidence/06b4';
await mkdir('.test-build',{recursive:true});await mkdir(out,{recursive:true});
await build({entryPoints:['benchmarks/graph/run.ts'],outfile:'.test-build/graph-benchmark.mjs',bundle:true,platform:'node',format:'esm',target:'node22'});
await build({entryPoints:['plugin/src/standalone/worker-entry.ts'],outfile:'.test-build/standalone-worker.js',bundle:true,platform:'browser',format:'iife',target:'es2022'});
let status=0;
for(const count of [128,512]){
  const r=spawnSync(process.execPath,['.test-build/graph-benchmark.mjs',String(count),out+'/results-'+count+'.json'],{stdio:'inherit',timeout:240000});
  if(r.error)throw r.error;
  status=Math.max(status,r.status??1);
}
process.exitCode=status;
