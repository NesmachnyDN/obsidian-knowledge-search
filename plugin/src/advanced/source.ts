/** One explicitly selected TFile, bounded and reverified against the authoritative Vault. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { IngestError, validRelative, sha } from './protocol';

export const MAX_DOCUMENT_BYTES = 65536;
type Root = { path: string; id: string; dev: number; ino: number };
export async function trustedVaultRoot(path: string): Promise<Root> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new IngestError('SOURCE_REJECTED');
  const resolved = await realpath(path);
  if (resolved !== path) throw new IngestError('SOURCE_REJECTED');
  // Python ScopedReader independently forbids all symlink ancestors.
  let current = '/';
  for (const part of path.slice(1).split('/')) {
    if (!part) throw new IngestError('SOURCE_REJECTED');
    current = join(current,part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new IngestError('SOURCE_REJECTED');
  }
  const stat = await lstat(path);
  if (!Number.isSafeInteger(stat.dev) || !Number.isSafeInteger(stat.ino))
    throw new IngestError('SOURCE_REJECTED');
  return {path,id:sha(JSON.stringify([path, stat.dev, stat.ino])),dev:stat.dev,ino:stat.ino};
}
export async function readSource(root: Root, path: string): Promise<{ sha256: string; bytes: Uint8Array }> {
  if (!validRelative(path) || !/\.(md|pdf|docx)$/i.test(path)) throw new IngestError('SOURCE_REJECTED');
  const rootNow = await trustedVaultRoot(root.path);
  if (rootNow.id !== root.id) throw new IngestError('SOURCE_STALE');
  const components = path.split('/');
  let parent = root.path;
  for (const component of components.slice(0,-1)) {
    parent = join(parent,component);
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== root.dev)
      throw new IngestError('SOURCE_REJECTED');
  }
  const full = join(parent,components[components.length-1]!);
  if (!full.startsWith(root.path + sep)) throw new IngestError('SOURCE_REJECTED');
  const before = await lstat(full,{bigint:true});
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size > BigInt(MAX_DOCUMENT_BYTES) || before.size < 0n)
    throw new IngestError('SOURCE_REJECTED');
  const handle = await open(full,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const first = await handle.stat({bigint:true});
    const stamp = (s: typeof first) => [s.dev,s.ino,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');
    if (!first.isFile() || stamp(first) !== stamp(before)) throw new IngestError('SOURCE_STALE');
    const contents = Buffer.alloc(MAX_DOCUMENT_BYTES+1);
    let total=0;
    while (total < contents.length) {
      const { bytesRead } = await handle.read(contents,total,contents.length-total,total);
      if (!bytesRead) break;
      total+=bytesRead;
    }
    if (total > MAX_DOCUMENT_BYTES) throw new IngestError('SOURCE_REJECTED');
    const final = await handle.stat({bigint:true});
    const pathAfter = await lstat(full,{bigint:true});
    if (stamp(first) !== stamp(final) || stamp(first) !== stamp(pathAfter)
        || (await trustedVaultRoot(root.path)).id !== root.id || BigInt(total) !== final.size)
      throw new IngestError('SOURCE_STALE');
    const bytes=contents.subarray(0,total);
    return { sha256:createHash('sha256').update(bytes).digest('hex'),bytes };
  } finally { await handle.close(); }
}
export type TrustedVaultRoot = Root;
