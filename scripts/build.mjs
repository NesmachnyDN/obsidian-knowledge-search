import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist');
const result = await build({ entryPoints: ['plugin/src/main.ts'], outfile: 'dist/main.js', bundle: true,
  platform: 'node', target: 'es2022', format: 'cjs', external: ['obsidian'], metafile: true });
if (Object.keys(result.metafile.inputs).some(path => path.includes('node_modules'))) throw new Error('Unexpected bundled dependency');
await copyFile('plugin/manifest.json', 'dist/manifest.json');
