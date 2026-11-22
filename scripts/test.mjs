import { build } from 'esbuild';
import { mkdir, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
await mkdir('.test-build', { recursive: true });
const files = (await readdir('tests')).filter(file => file.endsWith('.test.ts'));
await build({ entryPoints: files.map(file => `tests/${file}`), outdir: '.test-build', bundle: true,
  platform: 'node', format: 'cjs', target: 'node22' });
await build({ entryPoints: ['plugin/src/supervisor.ts'], outfile: '.test-build/reload-supervisor.cjs',
  bundle: true, platform: 'node', format: 'cjs', target: 'node22' });
await build({ entryPoints: ['plugin/src/standalone/worker-entry.ts'],
  outfile: '.test-build/standalone-worker.js', bundle: true,
  platform: 'browser', format: 'iife', target: 'es2022' });
const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files.map(file => `.test-build/${file.replace(/\.ts$/, '.js')}`)],
  { stdio: 'inherit', timeout: 60000 });
process.exitCode = run.status ?? 1;
