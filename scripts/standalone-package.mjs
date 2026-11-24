/** Deterministic, offline Standalone directory package. No release publishing. */
import { createHash } from 'node:crypto';
import { readdir, lstat, mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
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
// Linux-only: resolve every component relative to an already opened directory.
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const anchored = (directory, name = '') => '/proc/self/fd/' + directory.fd + (name ? '/' + name : '');
async function withDirectory(path, action) {
  let directory = await open('/', directoryFlags);
  try {
    for (const name of resolve(path).split(sep).filter(Boolean)) {
      const child = await open(anchored(directory, name), directoryFlags);
      const previous = directory;
      directory = child;
      await previous.close();
    }
    return await action(directory);
  } finally { await directory.close(); }
}
async function sameDirectory(directory, path) {
  const expected = await directory.stat();
  await withDirectory(path, async current => {
    const actual = await current.stat();
    assert(expected.dev === actual.dev && expected.ino === actual.ino, 'directory changed');
  });
}
async function packageOperation(action) {
  try { return await action(); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith('PACKAGE_INVALID:')) throw error;
    throw new Error('PACKAGE_INVALID: unsafe or unavailable package path', { cause: error });
  }
}
// Descriptor-bound and size-limited verification avoids pathname TOCTOU.
async function secureRead(path, maximum = 20 * 1024 * 1024) {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw new Error('PACKAGE_INVALID: missing or unsafe file'); }
  try {
    const st = await handle.stat();
    assert(st.isFile() && st.nlink === 1, 'linked or nonregular file');
    assert(st.size > 0 && st.size <= maximum, 'empty/oversize file');
    const bytes = Buffer.alloc(st.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    assert(offset === st.size && after.size === st.size && after.dev === st.dev
      && after.ino === st.ino && after.mtimeMs === st.mtimeMs && after.ctimeMs === st.ctimeMs,
    'file changed during verification');
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}
async function records(directory) {
  const names = (await readdir(anchored(directory))).sort();
  assert(JSON.stringify(names) === JSON.stringify([...assetNames].sort()), 'missing or extra assets');
  const assets = {};
  const contents = {};
  for (const filename of assetNames) {
    const bytes = await secureRead(anchored(directory, filename));
    contents[filename] = bytes;
    assets[filename] = { sha256: hash(bytes), bytes: bytes.length };
  }
  let manifest;
  try { manifest = JSON.parse(contents['manifest.json'].toString('utf8')); }
  catch { throw new Error('PACKAGE_INVALID: malformed manifest'); }
  assert(manifest?.id === 'oks-synthetic-evidence' && manifest.isDesktopOnly === true, 'plugin ID or desktop flag');
  assert(typeof manifest.name === 'string' && manifest.name.length > 0 &&
    /^\d+\.\d+\.\d+$/.test(manifest.version) &&
    /^\d+\.\d+\.\d+$/.test(manifest.minAppVersion), 'manifest version/name');
  assert(contents['main.js'].includes(Buffer.from('standalone-worker.js')),
    'main.js does not reference packaged worker');
  return { contents, metadata: { schemaVersion: 1, profile: 'standalone', pluginId: manifest.id,
    pluginVersion: manifest.version, assets } };
}
const sidecarName = name => name + '.sha256.json';
async function verifyOpened(parent, directory, name) {
  const { metadata: actual } = await records(directory);
  let expected;
  try { expected = JSON.parse((await secureRead(anchored(parent, sidecarName(name)), 16 * 1024)).toString('utf8')); }
  catch { throw new Error('PACKAGE_INVALID: malformed attestation'); }
  assert(JSON.stringify(expected) === JSON.stringify(actual), 'asset bytes/hash/identity differ');
  return actual;
}
function packagePath(dir) {
  const path = resolve(dir);
  assert(withinBuild(path), 'package cannot be build root');
  return path;
}
async function withPackage(parent, name, action) {
  const directory = await open(anchored(parent, name), directoryFlags);
  try { return await action(directory); } finally { await directory.close(); }
}
export async function verifyPackage(dir = defaultPackageDir) {
  const path = packagePath(dir);
  return packageOperation(() => withDirectory(dirname(path), parent =>
    withPackage(parent, basename(path), async directory => {
      const result = await verifyOpened(parent, directory, basename(path));
      await sameDirectory(directory, path);
      return result;
    })));
}
async function exclusive(path, bytes) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
export async function createPackage(dir = defaultPackageDir) {
  const path = packagePath(dir), name = basename(path);
  return packageOperation(async () => {
    await withDirectory(repo, async root => {
      try { await mkdir(anchored(root, 'build'), { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    });
    const { contents, metadata: expected } = await withDirectory(sourceDir, async directory => {
      const result = await records(directory);
      await sameDirectory(directory, sourceDir);
      return result;
    });
    const manifest = await withDirectory(join(repo, 'plugin'), directory =>
      secureRead(anchored(directory, 'manifest.json'), 16 * 1024));
    assert(expected.assets['manifest.json'].sha256 === hash(manifest), 'manifest out of sync with source');
    return withDirectory(dirname(path), async parent => {
      const existing = await info(anchored(parent, name));
      if (existing) {
        return withPackage(parent, name, async directory => {
          const current = await verifyOpened(parent, directory, name);
          assert(JSON.stringify(current) === JSON.stringify(expected), 'existing package differs: do not overwrite');
          await sameDirectory(directory, path);
          return current;
        });
      }
      assert(!await info(anchored(parent, sidecarName(name))), 'unexpected existing attestation');
      await mkdir(anchored(parent, name), { mode: 0o700 });
      return withPackage(parent, name, async directory => {
        const st = await directory.stat();
        assert((st.mode & 0o077) === 0, 'package directory must be private');
        await sameDirectory(directory, path);
        for (const asset of assetNames) {
          // The verified, bounded buffers are the only source of package bytes.
          await exclusive(anchored(directory, asset), contents[asset]);
        }
        await directory.sync();
        await sameDirectory(directory, path);
        // An interrupted package has no attestation and is rejected on retry.
        // Never remove or overwrite an existing pathname during recovery.
        await exclusive(anchored(parent, sidecarName(name)), JSON.stringify(expected, null, 2) + '\n');
        await parent.sync();
        const result = await verifyOpened(parent, directory, name);
        await sameDirectory(directory, path);
        return result;
      });
    });
  });
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
