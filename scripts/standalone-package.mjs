/** Deterministic, offline Standalone directory package. No release publishing. */
import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, mkdir, open } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = join(repo, 'build');
const sourceDir = join(repo, 'dist');
export const assetNames = Object.freeze(['main.js', 'manifest.json', 'standalone-worker.js']);
export const defaultPackageDir = join(buildRoot, 'standalone-package');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const assert = (ok, why) => { if (!ok) throw new Error('PACKAGE_INVALID: ' + why); };
const info = async path => {
  try { return await lstat(path); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
};
const withinBuild = dir => {
  const rel = relative(buildRoot, resolve(dir));
  assert(rel !== '..' && !rel.startsWith('..' + sep) && !rel.startsWith(sep), 'outside build');
  return rel;
};
async function checkDirectories(dir, createBuild = false) {
  const rel = withinBuild(dir);
  if (createBuild) await mkdir(buildRoot, { recursive: true });
  const root = await info(buildRoot);
  assert(root?.isDirectory() && !root.isSymbolicLink(), 'linked/missing build root');
  let current = buildRoot;
  if (!rel) return;
  for (const component of rel.split(sep)) {
    current = join(current, component);
    const item = await info(current);
    assert(item?.isDirectory() && !item.isSymbolicLink(), 'linked/missing parent directory');
  }
}
async function records(dir) {
  const names = (await readdir(dir)).sort();
  assert(JSON.stringify(names) === JSON.stringify([...assetNames].sort()), 'missing or extra assets');
  const assets = {};
  for (const filename of assetNames) {
    const filepath = join(dir, filename);
    const st = await lstat(filepath);
    assert(st.isFile() && !st.isSymbolicLink() && st.nlink === 1, 'linked or nonregular file: ' + filename);
    assert(st.size > 0 && st.size <= 20 * 1024 * 1024, 'empty/oversize file: ' + filename);
    const bytes = await readFile(filepath);
    assets[filename] = { sha256: hash(bytes), bytes: bytes.length };
  }
  let manifest;
  try { manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')); }
  catch { throw new Error('PACKAGE_INVALID: malformed manifest'); }
  assert(manifest?.id === 'oks-synthetic-evidence' && manifest.isDesktopOnly === true, 'plugin ID or desktop flag');
  assert(typeof manifest.name === 'string' && manifest.name.length > 0 &&
    /^\d+\.\d+\.\d+$/.test(manifest.version) &&
    /^\d+\.\d+\.\d+$/.test(manifest.minAppVersion), 'manifest version/name');
  assert((await readFile(join(dir, 'main.js'), 'utf8')).includes('standalone-worker.js'),
    'main.js does not reference packaged worker');
  return { schemaVersion: 1, profile: 'standalone', pluginId: manifest.id,
    pluginVersion: manifest.version, assets };
}
const attestationPath = dir => join(dirname(dir), basename(dir) + '.sha256.json');
export async function verifyPackage(dir = defaultPackageDir) {
  await checkDirectories(dir);
  const actual = await records(dir);
  const sidecar = attestationPath(dir);
  const st = await lstat(sidecar);
  assert(st.isFile() && !st.isSymbolicLink() && st.nlink === 1, 'linked/nonregular attestation');
  let expected;
  try { expected = JSON.parse(await readFile(sidecar, 'utf8')); }
  catch { throw new Error('PACKAGE_INVALID: malformed attestation'); }
  assert(JSON.stringify(expected) === JSON.stringify(actual), 'asset bytes/hash/identity differ');
  return actual;
}
async function exclusive(path, bytes) {
  const file = await open(path, 'wx', 0o644);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
export async function createPackage(dir = defaultPackageDir) {
  withinBuild(dir);
  await checkDirectories(dirname(dir), true);
  const expected = await records(sourceDir);
  assert(expected.assets['manifest.json'].sha256 ===
    hash(await readFile(join(repo, 'plugin', 'manifest.json'))), 'manifest out of sync with source');
  const existing = await info(dir);
  if (existing) {
    const current = await verifyPackage(dir);
    assert(JSON.stringify(current) === JSON.stringify(expected), 'existing package differs: do not overwrite');
    return current;
  }
  assert(!await info(attestationPath(dir)), 'unexpected existing attestation');
  await mkdir(dir);
  for (const name of assetNames) await exclusive(join(dir, name), await readFile(join(sourceDir, name)));
  await exclusive(attestationPath(dir), JSON.stringify(expected, null, 2) + '\n');
  return verifyPackage(dir);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const op = process.argv[2] ?? 'pack';
    const dir = process.argv[3] ? resolve(process.argv[3]) : defaultPackageDir;
    const result = op === 'pack' ? await createPackage(dir) :
      op === 'verify' ? await verifyPackage(dir) : null;
    assert(result, 'expected pack or verify');
    process.stdout.write('STANDALONE_PACKAGE_' + (op === 'pack' ? 'READY' : 'VERIFIED') +
      ' ' + result.pluginId + '@' + result.pluginVersion + ' ' +
      assetNames.map(name => name + '=' + result.assets[name].sha256).join(' ') + '\n');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
