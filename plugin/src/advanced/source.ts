/** One TFile, bounded and reverified via Linux descriptor-anchored Vault path. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { IngestError, validRelative, sha } from './protocol';

export const MAX_DOCUMENT_BYTES = 65536;
type Root = { path: string; id: string; dev: number; ino: number };
export async function trustedVaultRoot(path: string): Promise<Root> {
  if (process.platform !== 'linux' || !isAbsolute(path) || resolve(path) !== path)
    throw new IngestError('SOURCE_REJECTED');
  const resolved = await realpath(path);
  if (resolved !== path) throw new IngestError('SOURCE_REJECTED');
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

/**
 * Linux /proc/self/fd/<fd>/<component> acts as an openat-style descriptor-
 * relative lookup. Open every directory with O_DIRECTORY|O_NOFOLLOW; no path
 * component can become a symlink escape between check and open. The final
 * source is opened via the verified parent FD, never by an unanchored path.
 * The backend separately uses Python's ScopedReader.openat(dir_fd=...) API.
 */
async function openScoped(root: Root, path: string): Promise<FileHandle> {
  const components=path.split('/');
  let parent=await open(root.path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try {
    const rootStat=await parent.stat({bigint:true});
    if (!rootStat.isDirectory() || rootStat.dev!==BigInt(root.dev)
      || rootStat.ino!==BigInt(root.ino)) throw new IngestError('SOURCE_STALE');
    for(const part of components.slice(0,-1)){
      const next=await open('/proc/self/fd/'+parent.fd+'/'+part,
        constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      await parent.close();
      parent=next;
      const stat=await parent.stat({bigint:true});
      if(!stat.isDirectory() || stat.dev!==BigInt(root.dev))
        throw new IngestError('SOURCE_REJECTED');
    }
    return await open('/proc/self/fd/'+parent.fd+'/'+components[components.length-1]!,
      constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  } finally { await parent.close(); }
}

export async function readSource(root: Root, path: string): Promise<{ sha256: string; bytes: Uint8Array }> {
  if (!validRelative(path) || !/\.(md|pdf|docx)$/i.test(path)) throw new IngestError('SOURCE_REJECTED');
  const rootNow = await trustedVaultRoot(root.path);
  if (rootNow.id !== root.id) throw new IngestError('SOURCE_STALE');
  const handle = await openScoped(root,path);
  try {
    const first = await handle.stat({bigint:true});
    const stamp = (s: typeof first) => [s.dev,s.ino,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');
    if (!first.isFile() || first.nlink!==1n
        || first.dev!==BigInt(root.dev) || first.size>BigInt(MAX_DOCUMENT_BYTES) || first.size<0n)
      throw new IngestError('SOURCE_REJECTED');
    const contents = Buffer.alloc(MAX_DOCUMENT_BYTES+1);
    let total=0;
    while (total < contents.length) {
      const { bytesRead } = await handle.read(contents,total,contents.length-total,total);
      if (!bytesRead) break;
      total+=bytesRead;
    }
    if (total > MAX_DOCUMENT_BYTES) throw new IngestError('SOURCE_REJECTED');
    const final = await handle.stat({bigint:true});
    if (stamp(first)!==stamp(final)||BigInt(total)!==final.size)
      throw new IngestError('SOURCE_STALE');
    // The *current* root-relative path must resolve to this same object. A
    // renamed/deleted/replaced source must not yield stale evidence.
    const confirm=await openScoped(root,path);
    try {
      const after=await confirm.stat({bigint:true});
      if(stamp(first)!==stamp(after)|| (await trustedVaultRoot(root.path)).id!==root.id)
        throw new IngestError('SOURCE_STALE');
    } finally { await confirm.close(); }
    const bytes=contents.subarray(0,total);
    return { sha256:createHash('sha256').update(bytes).digest('hex'),bytes };
  } finally { await handle.close(); }
}
export type TrustedVaultRoot = Root;
