import { build } from 'esbuild';
import { mkdir, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
await mkdir('.test-build', { recursive: true });
const files = (await readdir('tests')).filter(file => file.endsWith('.test.ts'));
await build({ entryPoints: files.map(file => `tests/${file}`), outdir: '.test-build', bundle: true,
  platform: 'node', format: 'cjs', target: 'node22' });
await build({ entryPoints: ['plugin/src/supervisor.ts'], outfile: '.test-build/reload-supervisor.cjs',
  bundle: true, platform: 'node', format: 'cjs', target: 'node22' });
// Host-adapter lifecycle tests inject Obsidian only at this external boundary.
// This is explicitly a Node test adapter, not real desktop smoke evidence.
await build({ entryPoints: ['plugin/src/main.ts'], outfile: '.test-build/plugin-main.cjs',
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['obsidian'] });
await build({ entryPoints: ['plugin/src/standalone/worker-entry.ts'],
  outfile: '.test-build/standalone-worker.js', bundle: true,
  platform: 'browser', format: 'iife', target: 'es2022' });
// The aggregate suite grows independently of per-test and product deadlines.
// Keep a finite process boundary with headroom for sequential CI execution.
const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files.map(file => `.test-build/${file.replace(/\.ts$/, '.js')}`)],
  { stdio: 'inherit', timeout: 180000 });
if (run.error || run.signal) {
  console.error('Full Node regression process did not complete:', run.error?.code ?? run.signal);
  process.exitCode = 1;
} else {
  process.exitCode = run.status ?? 1;
}
