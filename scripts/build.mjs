import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist');
const result = await build({ entryPoints: ['plugin/src/main.ts'], outfile: 'dist/main.js', bundle: true,
  platform: 'node', target: 'es2022', format: 'cjs', external: ['obsidian'], metafile: true });
if (Object.keys(result.metafile.inputs).some(path => path.includes('node_modules'))) throw new Error('Unexpected bundled dependency');
const worker = await build({ entryPoints: ['plugin/src/standalone/worker-entry.ts'],
  outfile: 'dist/standalone-worker.js', bundle: true, platform: 'browser',
  target: 'es2022', format: 'iife', metafile: true });
if (Object.keys(worker.metafile.inputs).some(path => path.includes('node_modules')))
  throw new Error('Unexpected bundled worker dependency');
await copyFile('plugin/manifest.json', 'dist/manifest.json');
