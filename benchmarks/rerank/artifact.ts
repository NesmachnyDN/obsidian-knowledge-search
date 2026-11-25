import { constants } from 'node:fs';
import { open, lstat, type FileHandle } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { hash } from '../../plugin/src/standalone/contracts';

const MAX_ARTIFACT = 2 * 1024 * 1024;
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Same descriptor-anchored, no-follow and bounded-read pattern as BoundedVaultReader.
 * JSONL artifacts are not Markdown and need a separate (larger) benchmark byte cap. */
export async function readOpenedArtifact(handle: FileHandle, anchoredPath: string): Promise<Buffer> {
  const before = await handle.stat({ bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_ARTIFACT))
    throw Error('CORPUS_FILE_INVALID');
  const bytes = Buffer.alloc(MAX_ARTIFACT + 1);
  let count = 0;
  while (count < bytes.length) {
    const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count);
    if (!bytesRead) break;
    count += bytesRead;
  }
  if (count > MAX_ARTIFACT) throw Error('CORPUS_FILE_LIMIT');
  const after = await handle.stat({ bigint: true });
  const current = await lstat(anchoredPath, { bigint: true });
  if (!current.isFile() || after.nlink !== 1n || current.nlink !== 1n ||
      before.size !== BigInt(count) || after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs ||
      current.ino !== before.ino || current.dev !== before.dev ||
      current.mtimeNs !== before.mtimeNs || current.ctimeNs !== before.ctimeNs)
    throw Error('CORPUS_FILE_CHANGED');
  return bytes.subarray(0, count);
}

export async function readArtifact(root: string, name: string, expectedDigest?: string): Promise<Buffer> {
  if (!/^[a-z]+\.jsonl?$/.test(name)) throw Error('CORPUS_FILE_INVALID');
  let directory: FileHandle | undefined;
  let handle: FileHandle | undefined;
  try {
    directory = await open('/', DIRECTORY);
    for (const part of resolve(root).split(sep).filter(Boolean)) {
      const child = await open('/proc/self/fd/' + directory.fd + '/' + part, DIRECTORY);
      const previous = directory;
      directory = child;
      await previous.close();
    }
    const anchoredPath = '/proc/self/fd/' + directory.fd + '/' + name;
    handle = await open(anchoredPath, FILE);
    const raw = await readOpenedArtifact(handle, anchoredPath);
    if (expectedDigest !== undefined && hash(raw) !== expectedDigest)
      throw Error('CORPUS_DIGEST_MISMATCH');
    return raw;
  } finally {
    try { await handle?.close(); } finally { await directory?.close(); }
  }
}
