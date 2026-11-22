import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, normalize, parse, relative, sep } from 'node:path';
import { FIXTURE_DIGEST, FIXTURE_PATH, LIMITS } from './protocol';

export function sha256(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex');
}
export type FixtureAccess = {
  root: string;
  // Resolve the single known TFile through the Vault API; never invoke an unbounded host read.
  verifyNote: () => void;
};

async function checkedPath(root: string, path: string): Promise<string> {
  if (process.platform !== 'linux' || !isAbsolute(root) || root.endsWith(sep) || normalize(root) !== root
      || path !== FIXTURE_PATH || !constants.O_NOFOLLOW) throw new Error('FIXTURE_SCOPE');
  const target = join(root, path);
  if (relative(root, target) !== FIXTURE_PATH) throw new Error('FIXTURE_SCOPE');
  let current = parse(target).root;
  const identities: string[] = [];
  const parts = target.slice(current.length).split(sep);
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    const item = await lstat(current, { bigint: true });
    if (item.isSymbolicLink() || (index === parts.length - 1 ? !item.isFile() : !item.isDirectory())) {
      throw new Error('FIXTURE_SCOPE');
    }
    identities.push(`${item.dev}:${item.ino}`);
    if (index === parts.length - 1) {
      if (item.size > BigInt(LIMITS.source)) throw new Error('FIXTURE_LIMIT');
      identities.push(`${item.size}:${item.mtimeNs}:${item.ctimeNs}`);
    }
  }
  if (await realpath(target) !== target) throw new Error('FIXTURE_SCOPE');
  return identities.join('/');
}

// Anchor each directory lookup to an already opened descriptor. Linux /proc is
// required; no fallback to a path-based unbounded read on unsupported hosts.
async function openAnchored(target: string): Promise<FileHandle> {
  let directory = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const parts = target.slice(1).split('/');
    for (const part of parts.slice(0, -1)) {
      const next = await open(`/proc/self/fd/${directory.fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await directory.close();
      directory = next;
    }
    return await open(`/proc/self/fd/${directory.fd}/${parts.at(-1)!}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } finally { await directory.close(); }
}

export async function readFixture(access: FixtureAccess, path = FIXTURE_PATH): Promise<string> {
  try {
    access.verifyNote();
    const before = await checkedPath(access.root, path);
    // All content reads are explicitly bounded; Vault.readBinary cannot enforce a byte limit.
    const handle = await openAnchored(join(access.root, path));
    let text: string;
    try {
      const info = await handle.stat({ bigint: true });
      const expected = `${info.dev}:${info.ino}/${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
      if (!before.endsWith(`/` + expected) || !info.isFile() || info.size > BigInt(LIMITS.source)) throw new Error();
      const bytes = Buffer.alloc(LIMITS.source + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > LIMITS.source || sha256(bytes.subarray(0, length)) !== FIXTURE_DIGEST) throw new Error();
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
    } finally { await handle.close(); }
    if (await checkedPath(access.root, path) !== before) throw new Error();
    access.verifyNote();
    return text;
  } catch { throw new Error('FIXTURE_REJECTED'); }
}
