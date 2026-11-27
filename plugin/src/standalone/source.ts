import { constants, type BigIntStats } from 'node:fs';
import { homedir } from 'node:os';
import { lstat, open, opendir, readlink, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { BOUNDS, StandaloneError, hash, isDigest, validPath } from './contracts';
import {captureHardSearchScope,validHardScopePath,type HardSearchScope,type RevocableHardSearchScope} from './hard-search-scope';

export interface SourceProvider {
  readonly rootId: string;
  /** Optional immutable hard scope captured by the source owner. */
  readonly hardSearchScope?: HardSearchScope;
  list(): Promise<string[]>;
  versionHints(paths: readonly string[]): Promise<string[]>;
  read(path: string): Promise<Uint8Array>;
  /** Optional stronger descriptor-bound read; consumers requiring it fail closed if absent. */
  readVerifiedOriginal?(path:string):Promise<VerifiedOriginalRead>;
}
export type OriginalVersionProof = Readonly<{
  rootId: string; sourceId: string; sha256: string; versionId: string;
}>;
/**
 * Descriptor evidence for the lifecycle ledger.  This is deliberately a
 * separate shape: existing callers continue to receive OriginalVersionProof.
 * stableIdentity is evidence that two observed descriptors are the same
 * filesystem object, never evidence of an allowed lifecycle transition.
 */
export type DescriptorLifecycleProof = Readonly<{
  version: OriginalVersionProof; stableIdentity: string;
}>;
export type VerifiedOriginalRead = Readonly<{bytes:Uint8Array;proof:DescriptorLifecycleProof}>;
/** Shared validation of descriptor-bound bytes before policy interpretation. */
export function verifiedOriginalDigest(observed:VerifiedOriginalRead,rootId:string,sourceId:string,expectedSha256?:string):string {
  const {bytes,proof}=observed,v=proof?.version;
  if(!(bytes instanceof Uint8Array)||bytes.byteLength>BOUNDS.fileBytes||!v||v.rootId!==rootId||v.sourceId!==sourceId
    ||(expectedSha256!==undefined&&v.sha256!==expectedSha256)||!isDigest(v.versionId)||!isDigest(proof.stableIdentity)||hash(bytes)!==v.sha256)
    throw new StandaloneError('SOURCE_CHANGED');
  return hash(JSON.stringify([v.rootId,v.sourceId,v.sha256,v.versionId,proof.stableIdentity]));
}
/**
 * A bounded, fail-closed observation for future lifecycle baseline work.
 * This is intentionally not SourceProvider.list(): Basic indexing keeps its
 * native enumeration contract and does not claim this stronger observation.
 */
export type CompleteMarkdownInventory = Readonly<{
  rootId: string;
  sources: readonly DescriptorLifecycleProof[];
}>;

function regularOriginal(info: BigIntStats): boolean {
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1n;
}
function versionFields(info: BigIntStats): string[] {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.birthtimeNs].map(value => value.toString());
}
function sameVersion(a: BigIntStats, b: BigIntStats): boolean {
  return regularOriginal(b) && a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.birthtimeNs === b.birthtimeNs;
}
type InventoryObservation = { files: Map<string, string[]>; directories: Map<string, string[]> };

function sameDirectory(a: BigIntStats, b: BigIntStats): boolean {
  return b.isDirectory() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino
    && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.birthtimeNs === b.birthtimeNs;
}
function originalVersionId(rootId: string, path: string, sha256: string, fields: string[]): string {
  return hash(JSON.stringify(['oks-original-version-v1', rootId, path, sha256, fields]));
}
function sameLifecycleProof(a: DescriptorLifecycleProof, b: DescriptorLifecycleProof): boolean {
  return a.stableIdentity === b.stableIdentity && a.version.rootId === b.version.rootId
    && a.version.sourceId === b.version.sourceId && a.version.sha256 === b.version.sha256
    && a.version.versionId === b.version.versionId;
}
// FileSystemAdapter.getBasePath() supplies the trusted authoritative root.
// Node descriptor reads are deliberately not Vault.cachedRead: the cache may be stale
// and that API does not permit a byte bound prior to allocation.
export class BoundedVaultReader implements SourceProvider {
  readonly rootId: string;
  private constructor(private readonly root: string, private readonly device: number,
    private readonly inode: number, private readonly enumeration: () => string[],
    private readonly searchScope?: HardSearchScope,
    private readonly liveScope?: RevocableHardSearchScope) {
    this.rootId = hash(JSON.stringify([this.root, device, inode]));
  }
  static async open(root: string, enumerate: () => string[], scopeConfig?:unknown): Promise<BoundedVaultReader> {
    const scope=scopeConfig===undefined?undefined:captureHardSearchScope(scopeConfig);
    return this.openScoped(root,enumerate,scope);
  }
  /** Host-only factory: the caller retains ownership of the captured lease. */
  static async openWithScope(root:string,enumerate:()=>string[],scope:RevocableHardSearchScope):Promise<BoundedVaultReader>{
    if(!scope.current())throw new StandaloneError('SEARCH_SCOPE_INVALID');
    try{
      return await this.openScoped(root,enumerate,scope,scope);
    }finally{
      if(!scope.current())throw new StandaloneError('SEARCH_SCOPE_INVALID');
    }
  }
  private static async openScoped(root:string,enumerate:()=>string[],scope?:HardSearchScope,liveScope?:RevocableHardSearchScope):Promise<BoundedVaultReader>{
    if (!isAbsolute(root)) throw new StandaloneError('UNSUPPORTED_FILESYSTEM');
    const absolute = resolve(root);
    try {
      const info = await lstat(absolute);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new StandaloneError('UNSUPPORTED_FILESYSTEM');
      const canonical = await realpath(absolute);
      if (canonical !== absolute) throw new StandaloneError('UNSUPPORTED_FILESYSTEM');
      return new BoundedVaultReader(absolute, info.dev, info.ino, enumerate, scope, liveScope);
    } catch { throw new StandaloneError('UNSUPPORTED_FILESYSTEM'); }
  }
  get hardSearchScope(): HardSearchScope|undefined { return this.searchScope; }
  /** Recheck at settlement, including rejection, so revoked authority takes precedence. */
  private checkScope():void{
    if(this.liveScope&&!this.liveScope.current())throw new StandaloneError('SEARCH_SCOPE_INVALID');
  }
  private allowsScope(path:string):boolean{
    this.checkScope();
    const allowed=this.liveScope?this.liveScope.allows(path):!this.searchScope?.hasExclusions||this.searchScope.allows(path);
    this.checkScope();
    return allowed;
  }
  private requireScope(path:string):void{
    if(!this.allowsScope(path))throw new StandaloneError('SEARCH_SCOPE_RESTRICTED');
  }
  /** Synchronous adapter-path fence; descriptor reads still authenticate root identity. */
  matchesRootPath(root:string):boolean{return isAbsolute(root)&&resolve(root)===this.root;}
  private async rootCheck(): Promise<void> {
    try {
      const info = await lstat(this.root);
      if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== this.device || info.ino !== this.inode
          || await realpath(this.root) !== this.root)
        throw new StandaloneError('VAULT_IDENTITY_CHANGED');
    } catch { throw new StandaloneError('VAULT_IDENTITY_CHANGED'); }
  }
  async list(): Promise<string[]> {
    try{
      this.checkScope();
      await this.rootCheck();
      this.checkScope();
      const files = this.enumeration();
      this.checkScope();
      if (!Array.isArray(files) || files.length > BOUNDS.sources) throw new StandaloneError('SOURCE_LIMIT');
      if (!files.every(validPath) || new Set(files).size !== files.length)
        throw new StandaloneError('SOURCE_REJECTED');
      if((this.liveScope||this.searchScope?.hasExclusions)&&![...files].every(validHardScopePath))throw new StandaloneError('SOURCE_REJECTED');
      const allowed=files.filter(path=>this.allowsScope(path)).sort();
      return allowed;
    }finally{this.checkScope();}
  }
  /**
   * Observe the canonical supported Markdown domain (visible paths only).
   * Dot-prefixed subtrees and regular non-Markdown attachments are explicitly
   * outside this domain. An unsafe or unsupported visible path denies the
   * observation. This is not a filesystem snapshot or admission authority.
   */
  async completeMarkdownInventory(signal?: AbortSignal): Promise<CompleteMarkdownInventory> {
    // Never reinterpret a restricted search domain as the historical full-vault lifecycle proof.
    this.checkScope();
    if(this.liveScope||this.searchScope?.hasExclusions)throw new StandaloneError('SEARCH_SCOPE_RESTRICTED');
    const check = (): void => {
      if (signal?.aborted) throw new StandaloneError('INVENTORY_CANCELLED');
    };
    const native = (): string[] => {
      check();
      let paths: string[];
      try { paths = this.enumeration(); } catch { throw new StandaloneError('SOURCE_REJECTED'); }
      if (!Array.isArray(paths) || paths.length > BOUNDS.sources)
        throw new StandaloneError('SOURCE_LIMIT');
      if (!paths.every(validPath) || new Set(paths).size !== paths.length)
        throw new StandaloneError('SOURCE_REJECTED');
      return [...paths].sort();
    };
    const equalPaths = (a: readonly string[], b: readonly string[]): boolean =>
      a.length === b.length && a.every((path, index) => path === b[index]);
    const equalMap = (a: Map<string,string[]>, b: Map<string,string[]>): boolean =>
      a.size === b.size && [...a].every(([path, fields]) => {
        const other = b.get(path);
        return other !== undefined && equalPaths(fields, other);
      });
    const first = await this.walkSupportedMarkdown(check);
    const paths = [...first.files.keys()].sort();
    if (!equalPaths(paths, native())) throw new StandaloneError('SOURCE_CHANGED');
    const proofs: DescriptorLifecycleProof[] = [];
    for (const path of paths) {
      check();
      const proof = await this.readLifecycleProof(path);
      // Bind the protected read to the same metadata observed in the walk.
      if (proof.version.versionId !== originalVersionId(this.rootId, path, proof.version.sha256, first.files.get(path)!)) throw new StandaloneError('SOURCE_CHANGED');
      proofs.push(proof);
    }
    const recheck = async (): Promise<void> => {
      if (!equalPaths(paths, native())) throw new StandaloneError('SOURCE_CHANGED');
      const observed = await this.walkSupportedMarkdown(check);
      if (!equalMap(first.files, observed.files) || !equalMap(first.directories, observed.directories))
        throw new StandaloneError('SOURCE_CHANGED');
    };
    await recheck();
    for (let i = 0; i < paths.length; i++) {
      check();
      if (!sameLifecycleProof(proofs[i]!, await this.readLifecycleProof(paths[i]!)))
        throw new StandaloneError('SOURCE_CHANGED');
    }
    await recheck();
    await this.rootCheck();
    check();
    return Object.freeze({ rootId: this.rootId, sources: Object.freeze(proofs) });
  }

  private async walkSupportedMarkdown(check: () => void): Promise<InventoryObservation> {
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    const files = new Map<string,string[]>(), directories = new Map<string,string[]>();
    const identities = new Set<string>();
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let total = 0;
    const walk = async (directory: Awaited<ReturnType<typeof open>>, prefix: string, depth: number): Promise<void> => {
      check();
      if (depth > BOUNDS.inventoryDepth) throw new StandaloneError('SOURCE_LIMIT');
      const before = await directory.stat({ bigint: true });
      const identity = JSON.stringify([before.dev.toString(), before.ino.toString()]);
      if (!before.isDirectory() || before.isSymbolicLink() || before.dev !== BigInt(this.device)
          || identities.has(identity)) throw new StandaloneError('SOURCE_REJECTED');
      identities.add(identity);
      const descriptor = '/proc/self/fd/' + directory.fd;
      // Stream entries with bounded buffering rather than allocating a complete
      // readdir result before checking its length. Reject undecodable names.
      // Node supports raw Buffer names at runtime; current @types/node omits
      // that encoding for opendir. The runtime result is checked below.
      const entries = await opendir(descriptor, { encoding: 'buffer' as BufferEncoding, bufferSize: 16 });
      let count = 0;
      try {
        for (;;) {
          check();
          const entry = await entries.read();
          if (!entry) break;
          if (++count > BOUNDS.inventoryDirectoryEntries || ++total > BOUNDS.inventoryEntries)
            throw new StandaloneError('SOURCE_LIMIT');
          const raw: unknown = entry.name;
          if (!Buffer.isBuffer(raw)) throw new StandaloneError('SOURCE_REJECTED');
          const name = decoder.decode(raw);
          if (!name || name.includes('/') || name.includes('\\0'))
            throw new StandaloneError('SOURCE_REJECTED');
          // Canonical validPath excludes hidden paths. Do not follow or read
          // their contents, including Obsidian configuration and Git metadata.
          if (name.startsWith('.')) continue;
          const relative = prefix + name;
          const descriptorPath = descriptor + '/' + name;
          const info = await lstat(descriptorPath, { bigint: true });
          if (info.isDirectory() && !info.isSymbolicLink()) {
            if (!validPath(relative + '/x.md')) throw new StandaloneError('SOURCE_REJECTED');
            const child = await open(descriptorPath, flags);
            try {
              if (!sameDirectory(info, await child.stat({ bigint: true })))
                throw new StandaloneError('SOURCE_CHANGED');
              await walk(child, relative + '/', depth + 1);
            } finally { await child.close(); }
          } else {
            // A symlink or special file might conceal another subtree. Never
            // accept it as an ignored attachment.
            if (!info.isFile() || info.isSymbolicLink()) throw new StandaloneError('SOURCE_REJECTED');
            if (!relative.toLowerCase().endsWith('.md')) continue;
            if (!validPath(relative) || !regularOriginal(info) || files.has(relative))
              throw new StandaloneError('SOURCE_REJECTED');
            if (info.size < 0n || info.size > BigInt(BOUNDS.fileBytes) || files.size >= BOUNDS.sources)
              throw new StandaloneError('SOURCE_LIMIT');
            files.set(relative, versionFields(info));
          }
        }
      } finally { await entries.close(); }
      const after = await directory.stat({ bigint: true });
      const expectedPath = prefix ? join(this.root, prefix.slice(0, -1)) : this.root;
      if (!sameDirectory(before, after) || await readlink(descriptor) !== expectedPath)
        throw new StandaloneError('SOURCE_CHANGED');
      directories.set(prefix, versionFields(after));
    };
    let root: Awaited<ReturnType<typeof open>> | undefined;
    try {
      check(); await this.rootCheck(); root = await open(this.root, flags);
      const info = await root.stat({ bigint: true });
      if (info.dev !== BigInt(this.device) || info.ino !== BigInt(this.inode))
        throw new StandaloneError('VAULT_IDENTITY_CHANGED');
      await walk(root, '', 0); await this.rootCheck(); check();
      return {files, directories};
    } catch (cause) {
      if (cause instanceof StandaloneError) throw cause;
      throw new StandaloneError('SOURCE_REJECTED');
    } finally { await root?.close(); }
  }
  // Cheap authoritative metadata check for *all* enumerated notes on search.
  // The opaque hints are never evidence: a bounded full SHA-256 audit still runs
  // periodically, and returned evidence always gets a fresh byte-level rehash.
  async versionHints(paths: readonly string[]): Promise<string[]> {
    try{
      this.checkScope();
      if (paths.length > BOUNDS.sources || !paths.every(validPath))
        throw new StandaloneError('SOURCE_REJECTED');
      for(const path of paths)this.requireScope(path);
      await this.rootCheck();
      const hints: string[] = [];
      // Limit outstanding lstat operations; do not read document contents here.
      for (let i = 0; i < paths.length; i += 16) {
        this.checkScope();
        const batch = paths.slice(i, i + 16);
        const values = await Promise.all(batch.map(async relative => {
          this.requireScope(relative);
          let path = this.root;
          const components = relative.split('/');
          for (const component of components.slice(0, -1)) {
            path = join(path, component);
            this.checkScope();
            const directory = await lstat(path);
            if (!directory.isDirectory() || directory.isSymbolicLink())
              throw new StandaloneError('SOURCE_REJECTED');
          }
          path = join(path, components[components.length - 1]!);
          this.requireScope(relative);
          const info = await lstat(path, { bigint: true });
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n)
            throw new StandaloneError('SOURCE_REJECTED');
          return JSON.stringify([relative, info.dev.toString(), info.ino.toString(),
            info.size.toString(), info.mtimeNs.toString(), info.ctimeNs.toString()]);
        }));
        hints.push(...values);
      }
      this.checkScope();
      await this.rootCheck();
      return hints;
    }finally{this.checkScope();}
  }
  async read(relative: string): Promise<Uint8Array> {
    try{
      const observed=await this.readOriginal(relative);
      this.requireScope(relative);
      return observed.bytes;
    }finally{this.checkScope();}
  }
  // This is an observed original version, not lifecycle admission or authority.
  async readVersionProof(relative: string): Promise<OriginalVersionProof> {
    try{
      const observed=await this.readOriginal(relative);
      this.requireScope(relative);
      return this.versionProof(relative,observed);
    }finally{this.checkScope();}
  }
  /** One protected descriptor read supplies both version and stable identity. */
  async readLifecycleProof(relative: string): Promise<DescriptorLifecycleProof> {
    try{
      const observed=await this.readVerifiedOriginal(relative);
      this.requireScope(relative);
      return observed.proof;
    }finally{this.checkScope();}
  }
  /** Read content and descriptor proof from the same protected observation, without ledger admission. */
  async readVerifiedOriginal(relative:string):Promise<VerifiedOriginalRead> {
    try{
      const observed = await this.readOriginal(relative);
      this.requireScope(relative);
      const birthtime = observed.info.birthtimeNs;
      // Linux filesystems which cannot supply a real creation time must not
      // manufacture an identity from mutable timestamps.
      if (birthtime <= 0n) throw new StandaloneError('LIFECYCLE_IDENTITY_UNSUPPORTED');
      const version = this.versionProof(relative, observed);
      const proof=Object.freeze({ version, stableIdentity: hash(JSON.stringify([
        'oks-lifecycle-descriptor-identity-v1', this.rootId,
        observed.info.dev.toString(), observed.info.ino.toString(), birthtime.toString(),
      ])) });
      return Object.freeze({bytes:observed.bytes,proof});
    }finally{this.checkScope();}
  }
  private versionProof(relative:string, observed:{bytes:Uint8Array;version:string[]}):OriginalVersionProof {
    const sha256 = hash(observed.bytes);
    return Object.freeze({ rootId: this.rootId, sourceId: relative, sha256,
      versionId: originalVersionId(this.rootId, relative, sha256, observed.version) });
  }
  private async readOriginal(relative: string): Promise<{bytes: Uint8Array; version: string[]; info: BigIntStats}> {
    try{
      this.checkScope();
      if (!validPath(relative)) throw new StandaloneError('SOURCE_REJECTED');
      this.requireScope(relative);
      const observed=await this.readDescriptor(relative);
      this.requireScope(relative);
      return observed;
    }finally{this.checkScope();}
  }
  private async readDescriptor(relative:string):Promise<{bytes:Uint8Array;version:string[];info:BigIntStats}>{
    const parts = relative.split('/');
    // Linux descriptor-anchored walk forbids redirecting an ancestor via symlink.
    const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    let rootDirectory: Awaited<ReturnType<typeof open>> | undefined;
    let directory: Awaited<ReturnType<typeof open>> | undefined;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let finalDirectory: Awaited<ReturnType<typeof open>> | undefined;
    try {
      try {
        rootDirectory = await open(this.root, directoryFlags);
        directory = rootDirectory;
        this.checkScope();
        const rootInfo = await rootDirectory.stat();
        if (!rootInfo.isDirectory() || rootInfo.dev !== this.device || rootInfo.ino !== this.inode)
          throw new StandaloneError('VAULT_IDENTITY_CHANGED');
        this.checkScope();
        await this.rootCheck();
      } catch { this.checkScope(); throw new StandaloneError('VAULT_IDENTITY_CHANGED'); }
      for (const part of parts.slice(0, -1)) {
        this.checkScope();
        const child = await open('/proc/self/fd/' + directory.fd + '/' + part, directoryFlags);
        const previous = directory;
        directory = child;
        if (previous !== rootDirectory) await previous.close();
      }
      this.requireScope(relative);
      handle = await open('/proc/self/fd/' + directory.fd + '/' + parts[parts.length - 1]!,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      this.checkScope();
      const opened = await handle.stat({ bigint: true });
      if (!regularOriginal(opened) || opened.size > BigInt(BOUNDS.fileBytes) || opened.size < 0n)
        throw new StandaloneError('SOURCE_REJECTED');
      const bytes = Buffer.allocUnsafe(BOUNDS.fileBytes + 1);
      let count = 0;
      while (count < bytes.length) {
        this.requireScope(relative);
        const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count);
        if (!bytesRead) break;
        count += bytesRead;
      }
      this.requireScope(relative);
      if (count > BOUNDS.fileBytes) throw new StandaloneError('SOURCE_LIMIT');
      const target = join(this.root, ...parts);
      // The opened parent can be moved outside the root during the read.
      // Rewalk nested ancestry without following any substituted symlink.
      // For a root-level note the initial root descriptor is still anchored.
      for (const part of parts.slice(0, -1)) {
        const parent = finalDirectory ?? rootDirectory;
        const child = await open('/proc/self/fd/' + parent.fd + '/' + part, directoryFlags);
        const previous = finalDirectory;
        finalDirectory = child;
        await previous?.close();
      }
      const finalParent = finalDirectory ?? directory;
      const pathAfter = await lstat('/proc/self/fd/' + finalParent.fd + '/' + parts[parts.length - 1]!,
        { bigint: true });
      await this.rootCheck();
      const after = await handle.stat({ bigint: true });
      // Linux procfs reports the actual descriptor path, not the caller's
      // pathname alias. An observed escaped, removed or replaced path denies.
      if (after.size !== BigInt(count) || !sameVersion(opened, after)
          || !sameVersion(opened, pathAfter)
          || await readlink('/proc/self/fd/' + handle.fd) !== target)
        throw new StandaloneError('SOURCE_CHANGED');
      return { bytes: bytes.subarray(0, count), version: versionFields(opened), info: opened };
    } catch (cause) {
      this.checkScope();
      if (cause instanceof StandaloneError) throw cause;
      // ENOTDIR/ELOOP from descriptor traversal is an explicit denied source,
      // never an untyped filesystem error or a fallback to pathname reading.
      await this.rootCheck();
      throw new StandaloneError('SOURCE_REJECTED');
    } finally {
      try { await handle?.close(); } finally {
        try { await finalDirectory?.close(); } finally {
          try { if (directory !== rootDirectory) await directory?.close(); } finally { await rootDirectory?.close(); }
        }
      }
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
