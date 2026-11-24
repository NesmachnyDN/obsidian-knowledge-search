import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, copyFile, link, mkdir, mkdtemp, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
