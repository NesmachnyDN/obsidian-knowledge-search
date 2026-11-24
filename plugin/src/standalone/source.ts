import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { BOUNDS, StandaloneError, hash, isDigest, validPath } from './contracts';

export interface SourceProvider {
  readonly rootId: string;
  list(): Promise<string[]>;
  versionHints(paths: readonly string[]): Promise<string[]>;
  read(path: string): Promise<Uint8Array>;
}
// FileSystemAdapter.getBasePath() supplies the trusted authoritative root.
// Node descriptor reads are deliberately not Vault.cachedRead: the cache may be stale
// and that API does not permit a byte bound prior to allocation.
export class BoundedVaultReader implements SourceProvider {
  readonly rootId: string;
  private constructor(private readonly root: string, private readonly device: number,
    private readonly inode: number, private readonly enumeration: () => string[]) {
    this.rootId = hash(JSON.stringify([this.root, device, inode]));
  }
  static async open(root: string, enumerate: () => string[]): Promise<BoundedVaultReader> {
    if (!isAbsolute(root)) throw new StandaloneError('UNSUPPORTED_FILESYSTEM');
    const absolute = resolve(root);
    const info = await lstat(absolute);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new StandaloneError('UNSUPPORTED_FILESYSTEM');
    const canonical = await realpath(absolute);
    if (canonical !== absolute) throw new StandaloneError('UNSUPPORTED_FILESYSTEM');
    return new BoundedVaultReader(absolute, info.dev, info.ino, enumerate);
  }
  private async rootCheck(): Promise<void> {
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== this.device || info.ino !== this.inode)
      throw new StandaloneError('VAULT_IDENTITY_CHANGED');
  }
  async list(): Promise<string[]> {
    await this.rootCheck();
    const files = this.enumeration();
    if (!Array.isArray(files) || files.length > BOUNDS.sources) throw new StandaloneError('SOURCE_LIMIT');
    if (!files.every(validPath) || new Set(files).size !== files.length)
      throw new StandaloneError('SOURCE_REJECTED');
    return [...files].sort();
  }
  // Cheap authoritative metadata check for *all* enumerated notes on search.
  // The opaque hints are never evidence: a bounded full SHA-256 audit still runs
  // periodically, and returned evidence always gets a fresh byte-level rehash.
  async versionHints(paths: readonly string[]): Promise<string[]> {
    if (paths.length > BOUNDS.sources || !paths.every(validPath))
      throw new StandaloneError('SOURCE_REJECTED');
    await this.rootCheck();
    const hints: string[] = [];
    // Limit outstanding lstat operations; do not read document contents here.
    for (let i = 0; i < paths.length; i += 16) {
      const batch = paths.slice(i, i + 16);
      const values = await Promise.all(batch.map(async relative => {
        let path = this.root;
        const components = relative.split('/');
        for (const component of components.slice(0, -1)) {
          path = join(path, component);
          const directory = await lstat(path);
          if (!directory.isDirectory() || directory.isSymbolicLink())
            throw new StandaloneError('SOURCE_REJECTED');
        }
        path = join(path, components[components.length - 1]!);
        const info = await lstat(path, { bigint: true });
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n)
          throw new StandaloneError('SOURCE_REJECTED');
        return JSON.stringify([relative, info.dev.toString(), info.ino.toString(),
          info.size.toString(), info.mtimeNs.toString(), info.ctimeNs.toString()]);
      }));
      hints.push(...values);
    }
    await this.rootCheck();
    return hints;
  }
  async read(relative: string): Promise<Uint8Array> {
    if (!validPath(relative)) throw new StandaloneError('SOURCE_REJECTED');
    const parts = relative.split('/');
    // Linux descriptor-anchored walk forbids redirecting an ancestor via symlink.
    const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    let directory = await open(this.root, directoryFlags);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const rootInfo = await directory.stat();
      if (!rootInfo.isDirectory() || rootInfo.dev !== this.device || rootInfo.ino !== this.inode)
        throw new StandaloneError('VAULT_IDENTITY_CHANGED');
      for (const part of parts.slice(0, -1)) {
        const child = await open('/proc/self/fd/' + directory.fd + '/' + part, directoryFlags);
        await directory.close();
        directory = child;
      }
      handle = await open('/proc/self/fd/' + directory.fd + '/' + parts[parts.length - 1]!,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.size > BOUNDS.fileBytes || opened.size < 0)
        throw new StandaloneError('SOURCE_REJECTED');
      const bytes = Buffer.allocUnsafe(BOUNDS.fileBytes + 1);
      let count = 0;
      while (count < bytes.length) {
        const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count);
        if (!bytesRead) break;
        count += bytesRead;
      }
      if (count > BOUNDS.fileBytes) throw new StandaloneError('SOURCE_LIMIT');
      const after = await handle.stat();
      const target = join(this.root, ...parts);
      const pathAfter = await lstat(target);
      await this.rootCheck();
      if (after.size !== count || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
          || after.ino !== opened.ino || after.dev !== opened.dev
          || pathAfter.ino !== opened.ino || pathAfter.dev !== opened.dev
          || pathAfter.isSymbolicLink()) throw new StandaloneError('SOURCE_CHANGED');
      return bytes.subarray(0, count);
    } catch (cause) {
      if (cause instanceof StandaloneError) throw cause;
      // ENOTDIR/ELOOP from descriptor traversal is an explicit denied source,
      // never an untyped filesystem error or a fallback to pathname reading.
      throw new StandaloneError('SOURCE_REJECTED');
    } finally {
      await handle?.close();
      await directory.close();
    }
  }
}
// Linux first: plugin-managed *host-local* durable storage, not .obsidian.
// No independent service or install. Obsidian Sync normally tracks the Vault,
// not XDG_DATA_HOME, so original excerpts are not copied by Vault settings sync.
export function privateIndexPath(root: string, rootId: string, pluginId: string): string {
  if (!isDigest(rootId) || !/^[a-z0-9-]+$/.test(pluginId) || !isAbsolute(root))
    throw new StandaloneError('CACHE_PATH_INVALID');
  const xdg = process.env.XDG_DATA_HOME;
  const data = xdg && isAbsolute(xdg) ? resolve(xdg) : join(homedir(), '.local', 'share');
  const path = resolve(join(data, 'obsidian-knowledge-search', 'plugins', pluginId, rootId, 'index'));
  const vault = resolve(root);
  if (path === vault || path.startsWith(vault + sep))
    throw new StandaloneError('CACHE_PATH_INVALID');
  return path;
}
