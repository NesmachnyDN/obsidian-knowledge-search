import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { appendFile, copyFile, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createPackage, verifyPackage, assetNames } from '../scripts/standalone-package.mjs';

const root = await mkdtemp('build/oks05a-package-test-');
let index = 0;
const validDir = join(root, 'valid');
const sidecar = dir => join(root, dir.split('/').at(-1) + '.sha256.json');
after(async () => { await rm(root, { recursive: true, force: true }); });

test('release is deterministic, minimal, self-verified and idempotent', async () => {
    const first = await createPackage(validDir);
    const second = await createPackage(validDir);
    assert.deepEqual(first, second);
    assert.deepEqual((await readdir(validDir)).sort(), [...assetNames].sort());
    assert.deepEqual(await verifyPackage(validDir), first);
    const otherDir = join(root, 'independent-rebuild');
    assert.deepEqual(await createPackage(otherDir), first);
    assert.deepEqual(await verifyPackage(otherDir), first);
    assert.equal(first.pluginId, 'oks-synthetic-evidence');
  });
  async function altered(mutate) {
    const name = 'altered-' + ++index, dir = join(root, name);
    await mkdir(dir);
    for (const asset of assetNames) await copyFile(join(validDir, asset), join(dir, asset));
    await copyFile(sidecar(validDir), sidecar(dir));
    await mutate(dir);
    await assert.rejects(verifyPackage(dir), /PACKAGE_INVALID|ENOENT/);
  }
  test('missing worker is rejected', () => altered(dir => rm(join(dir, 'standalone-worker.js'))));
  test('unlisted extra asset is rejected', () => altered(dir => writeFile(join(dir, 'test-secret.md'), 'synthetic only')));
  test('changed main.js is rejected by attestation', () => altered(dir => appendFile(join(dir, 'main.js'), '\n// mutation\n')));
  test('incorrect manifest is rejected', () => altered(dir => writeFile(join(dir, 'manifest.json'), '{"id":"foreign"}')));
  test('symlink worker is rejected, even when target is valid', () => altered(async dir => {
    await unlink(join(dir, 'standalone-worker.js'));
    await symlink(join(validDir, 'standalone-worker.js'), join(dir, 'standalone-worker.js'));
  }));
  test('hardlinked worker is rejected', () => altered(async dir => {
    await unlink(join(dir, 'standalone-worker.js'));
    await link(join(validDir, 'standalone-worker.js'), join(dir, 'standalone-worker.js'));
  }));
  test('tampered attestation is rejected', () => altered(dir => writeFile(sidecar(dir), '{}')));
  test('existing foreign package is never overwritten', async () => {
    const dir = join(root, 'foreign');
    await mkdir(dir);
    await writeFile(join(dir, 'keep.txt'), 'foreign');
    await assert.rejects(createPackage(dir), /PACKAGE_INVALID/);
    assert.deepEqual(await readdir(dir), ['keep.txt']);
  });
  test('path outside ignored build directory is rejected', async () => {
    // An existing project-relative path outside build exercises the same boundary
    // without presenting a never-created /tmp file as a real temporary-file sink.
    const outside = join(process.cwd(), 'outside-build-package');
    await assert.rejects(createPackage(outside), /PACKAGE_INVALID/);
    await assert.rejects(readdir(outside), { code: 'ENOENT' });
  });

test('CodeQL #7: packaged assets and attestation have owner-only permissions', async () => {
  for (const name of assetNames) {
    const metadata = await stat(join(validDir, name));
    assert.equal(metadata.mode & 0o077, 0, name + ' permissions');
  }
  assert.equal((await stat(sidecar(validDir))).mode & 0o077, 0, 'attestation permissions');
});

test('CodeQL #5: symlinked attestation fails closed without following its target', () =>
  altered(async dir => {
    await unlink(sidecar(dir));
    await symlink(sidecar(validDir), sidecar(dir));
  }));

test('CodeQL #5: hardlinked attestation fails closed', () =>
  altered(async dir => {
    await unlink(sidecar(dir));
    await link(sidecar(validDir), sidecar(dir));
  }));

// Intercept the real filesystem boundary at a deterministic await, not a timer.
// Restore it before cleanup; only disposable build outputs are manipulated.
async function interceptOpen(t, intercept, action) {
  const original = fs.open;
  const mock = t.mock.method(fs, 'open', async (path, ...args) =>
    intercept(String(path), () => original(path, ...args)));
  syncBuiltinESMExports();
  try { return await action(); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
}
const dist = resolve('dist');
test('B1: substitution after source verification copies only the verified snapshot', async t => {
  const source = join(dist, 'main.js'), saved = join(root, 'saved-main.js');
  const sentinel = resolve(root, 'outside-main.js');
  const target = join(root, 'snapshot-package');
  const original = await readFile(source);
  await writeFile(sentinel, 'SYNTHETIC FOREIGN CONTENT');
  let swapped = false;
  try {
    await interceptOpen(t, async (path, next) => {
      if (!swapped && path.endsWith('/manifest.json') &&
          await realpath(dirname(path)) === resolve('plugin')) {
        await rename(source, saved);
        await symlink(sentinel, source);
        swapped = true;
      }
      return next();
    }, () => createPackage(target));
    assert.ok(swapped);
    assert.deepEqual(await readFile(join(target, 'main.js')), original);
    assert.notDeepEqual(await readFile(join(target, 'main.js')), await readFile(sentinel));
    await verifyPackage(target);
  } finally {
    if (swapped) { await unlink(source); await rename(saved, source); }
  }
});
test('B1: source directory substitution never opens a foreign asset', async t => {
  const saved = resolve(root, 'saved-dist'), foreign = resolve(root, 'foreign-dist');
  await mkdir(foreign);
  for (const name of assetNames) await writeFile(join(foreign, name), 'SYNTHETIC FOREIGN');
  let swapped = false, foreignOpens = 0;
  try {
    await interceptOpen(t, async (path, next) => {
      if (path.endsWith('/main.js') && !swapped && await realpath(dirname(path)) === dist) {
        await rename(dist, saved);
        await symlink(foreign, dist);
        swapped = true;
      }
      if (assetNames.some(name => path.endsWith('/' + name)) &&
          await realpath(dirname(path)) === foreign) foreignOpens++;
      return next();
    }, () => assert.rejects(createPackage(join(root, 'redirected-source')), /PACKAGE_INVALID/));
    assert.ok(swapped);
    assert.equal(foreignOpens, 0);
    assert.ok(!(await readdir(root)).includes('redirected-source'));
  } finally {
    if (swapped) { await unlink(dist); await rename(saved, dist); }
  }
});
test('B1: destination ancestor substitution cannot write into the foreign tree', async t => {
  const parent = resolve(root, 'destination-parent'), saved = resolve(root, 'saved-parent');
  const foreign = resolve(root, 'foreign-parent'), name = 'package';
  await mkdir(parent); await mkdir(foreign); await mkdir(join(foreign, name));
  await writeFile(join(foreign, name, 'keep.txt'), 'foreign');
  let swapped = false;
  try {
    await interceptOpen(t, async (path, next) => {
      if (!swapped && path.endsWith('/main.js') &&
          await realpath(dirname(path)) === join(parent, name)) {
        await rename(parent, saved);
        await symlink(foreign, parent);
        swapped = true;
      }
      return next();
    }, () => assert.rejects(createPackage(join(parent, name)), /PACKAGE_INVALID/));
    assert.ok(swapped);
    assert.deepEqual(await readdir(join(foreign, name)), ['keep.txt']);
    assert.equal(await readFile(join(foreign, name, 'keep.txt'), 'utf8'), 'foreign');
    assert.deepEqual(await readdir(foreign), [name]);
    assert.ok(!(await readdir(saved)).includes(name + '.sha256.json'));
  } finally {
    if (swapped) { await unlink(parent); await rename(saved, parent); }
  }
});
test('B1: interrupted package is rejected without deleting or overwriting files', async t => {
  const target = resolve(root, 'interrupted');
  let injected = false;
  await interceptOpen(t, async (path, next) => {
    if (!injected && path.endsWith('/manifest.json') && await realpath(dirname(path)) === target) {
      injected = true;
      await writeFile(join(target, 'foreign.txt'), 'preserve');
      throw new Error('synthetic I/O failure');
    }
    return next();
  }, () => assert.rejects(createPackage(target), /PACKAGE_INVALID/));
  assert.ok(injected);
  assert.ok(!(await readdir(root)).includes('interrupted.sha256.json'));
  const initial = await readFile(join(target, 'main.js'));
  await assert.rejects(createPackage(target), /PACKAGE_INVALID/);
  assert.deepEqual(await readFile(join(target, 'main.js')), initial);
  assert.equal(await readFile(join(target, 'foreign.txt'), 'utf8'), 'preserve');
});
