import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, link, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { strictFile } from '../plugin/src/advanced/storage';
import { BoundedVaultReader } from '../plugin/src/standalone/source';
import { WorkerMarkdownParser, type WorkerPort } from '../plugin/src/standalone/worker';

const workerStub: (code: string) => WorkerPort = () => ({
  send() {}, stop() {}, onMessage() {}, onError() {},
});

test('CodeQL #1: derived index read pins the inode and refuses symlinks, hardlinks, public or oversized files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oks-sec-index-'));
  try {
    const actual = join(dir, 'private.json');
    await writeFile(actual, '{"ok":true}', { mode: 0o600 });
    assert.equal((await strictFile(actual, 20)).toString(), '{"ok":true}');
    await assert.rejects(strictFile(actual, 3));
    const linked = join(dir, 'linked.json');
    await symlink(actual, linked);
    await assert.rejects(strictFile(linked, 20));
    await rm(linked);
    await link(actual, linked);
    await assert.rejects(strictFile(actual, 20));
    await rm(linked);
    await chmod(actual, 0o644);
    await assert.rejects(strictFile(actual, 20));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CodeQL #2: Markdown source opens through trusted directory descriptors, not a link ancestor', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'oks-sec-vault-'));
  const outside = await mkdtemp(join(tmpdir(), 'oks-sec-outside-'));
  try {
    await mkdir(join(vault, 'nested'));
    await writeFile(join(vault, 'nested', 'ok.md'), '# safe');
    await writeFile(join(outside, 'secret.md'), 'private sentinel');
    const reader = await BoundedVaultReader.open(vault, () => ['nested/ok.md']);
    assert.equal(Buffer.from(await reader.read('nested/ok.md')).toString(), '# safe');
    await symlink(outside, join(vault, 'redirect'));
    await assert.rejects(reader.read('redirect/secret.md'));
  } finally {
    await rm(vault, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('CodeQL #3: parser worker asset rejects symlinks, hardlinks, empty and oversized assets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oks-sec-worker-'));
  try {
    const asset = join(dir, 'worker.js');
    await writeFile(asset, '/* synthetic */');
    const parser = new WorkerMarkdownParser(asset, workerStub);
    await parser.close();
    const linked = join(dir, 'linked.js');
    await symlink(asset, linked);
    assert.throws(() => new WorkerMarkdownParser(linked, workerStub));
    await rm(linked);
    await link(asset, linked);
    assert.throws(() => new WorkerMarkdownParser(asset, workerStub));
    await rm(linked);
    await writeFile(asset, '');
    assert.throws(() => new WorkerMarkdownParser(asset, workerStub));
    await writeFile(asset, Buffer.alloc(128 * 1024 + 1, 65));
    assert.throws(() => new WorkerMarkdownParser(asset, workerStub));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CodeQL #6: dedicated worker ignores foreign-origin and foreign-source messages', async () => {
  const script = await readFile(join(process.cwd(), '.test-build', 'standalone-worker.js'), 'utf8');
  const sent: unknown[] = [];
  const scope: {
    location: { origin: string };
    onmessage: ((message: { origin: string; source: unknown; data: unknown }) => void) | null;
    postMessage: (value: unknown) => void;
  } = {
    location: { origin: 'app://synthetic-obsidian' },
    onmessage: null,
    postMessage(value) { sent.push(value); },
  };
  runInNewContext(script, { self: scope, Uint8Array, TextEncoder, TextDecoder });
  assert.ok(scope.onmessage);
  scope.onmessage!({ origin: 'https://attacker.invalid', source: null, data: { id: 1 } });
  scope.onmessage!({ origin: '', source: {}, data: { id: 2 } });
  assert.equal(sent.length, 0);
  scope.onmessage!({ origin: '', source: null, data: { id: 3 } });
  assert.equal(sent.length, 1, 'creator-origin messages still reach the protocol validator');
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0])), { id: 3, error: 'PARSER_PROTOCOL_ERROR' });
});
