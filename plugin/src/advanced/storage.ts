/** Separate, rebuildable Advanced ingestion generation store, never the Standalone lexical index. */
import { constants } from 'node:fs';
import { open, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateIndexPath } from '../standalone/source';
import { withPrivateDerivedDirectory } from './private-directory';
import { canonical, sha, type IngestResponse, type IngestRequest,
  validateReply, IngestError } from './protocol';
import type { TrustedVaultRoot } from './source';

const MAX_GENERATION_BYTES = 16 * 1024 * 1024;
const MAX_SOURCES = 32;
export type StoredEntry = { sourcePath: string; response: IngestResponse };
type Snapshot = { schemaVersion: 1; rootId: string; entries: StoredEntry[] };
type Pointer = { schemaVersion: 1; rootId: string; filename: string; sha256: string };
const pointerName = 'CURRENT';
const namePattern = /^[0-9a-f]{64}\.json$/;
const stagePattern = /^\.stage-[0-9a-f-]{36}$/;
export const strictFile = async (file: string, maximum: number): Promise<Buffer> => {
  // Inspect the opened inode, not a filename checked before a separate read.
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maximum || info.size < 1
        || (info.mode & 0o077) !== 0)
      throw new IngestError('INDEX_PUBLICATION_UNCERTAIN');
    const bytes = Buffer.alloc(info.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const after = await handle.stat();
    if (count !== info.size || after.size !== info.size || after.dev !== info.dev
        || after.ino !== info.ino || after.mtimeMs !== info.mtimeMs
        || after.ctimeMs !== info.ctimeMs)
      throw new IngestError('INDEX_PUBLICATION_UNCERTAIN');
    return bytes.subarray(0, count);
  } finally {
    await handle.close();
  }
};
export const parseCanonical = (bytes: Buffer): unknown => {
  let data: unknown;
  try { data = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); }
  catch { throw new IngestError('INDEX_PUBLICATION_UNCERTAIN'); }
  if (Buffer.from(canonical(data)).compare(bytes) !== 0)
    throw new IngestError('INDEX_PUBLICATION_UNCERTAIN');
  return data;
};
export const persist = async (file: string, bytes: Buffer): Promise<void> => {
  const handle = await open(file, constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
};
export const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
};
const probeEntry = (entry: StoredEntry, root: TrustedVaultRoot): void => {
  const response = entry.response;
  if (entry.sourcePath !== response.source?.vaultRelativePath || !response.source
      || !['ok','partial'].includes(response.status)) throw new IngestError('INDEX_PUBLICATION_UNCERTAIN');
  const request: IngestRequest = {
    protocolVersion: 3, requestId: response.requestId, operation:'ingest',
    rootPath:root.path, sourcePath:entry.sourcePath, scopeId:root.id,
    expectedSha256:response.source.sha256, profileId:response.source.profileId,
    deadlineUnixMs:1, tokenizerSnapshot:'/pinned',
    tessdataPath:null, artifactsPath:null,
  };
  try { validateReply(response, request); }
  catch { throw new IngestError('INDEX_PUBLICATION_UNCERTAIN'); }
};
export class AdvancedGenerationStore {
  readonly path: string;
  private entries = new Map<string,IngestResponse>();
  private unavailable = false;
  private constructor(private readonly root: TrustedVaultRoot, path: string) { this.path=path; }
  static async open(root: TrustedVaultRoot, pluginId: string): Promise<AdvancedGenerationStore> {
    const indexDir = privateIndexPath(root.path,root.id,pluginId);
    const path = resolve(dirname(indexDir),'advanced-ingestion');
    const store = new AdvancedGenerationStore(root,path);
    // Descriptor-anchored walk rejects symlink ancestors before creating any
    // new path and forbids redirection into the authoritative Vault.
    await store.load();
    return store;
  }
  private async load(): Promise<void> {
    await withPrivateDerivedDirectory(this.path,this.root.path,async dir=>{
    const names = await readdir(dir);
    if (names.length > 12 || names.some(n=>n!==pointerName && !namePattern.test(n) && !stagePattern.test(n)))
      throw new IngestError('INDEX_PUBLICATION_UNCERTAIN');
    if (!names.includes(pointerName)) {
      if (names.some(n=>namePattern.test(n))) throw new IngestError('INDEX_PUBLICATION_UNCERTAIN');
      return;
    }
    const ptr = parseCanonical(await strictFile(join(dir,pointerName),2048)) as Pointer;
    if (!ptr || ptr.schemaVersion !== 1 || ptr.rootId !== this.root.id
        || !namePattern.test(ptr.filename) || ptr.sha256 !== ptr.filename.slice(0,-5))
      throw new IngestError('INDEX_PUBLICATION_UNCERTAIN');
    const bytes = await strictFile(join(dir,ptr.filename),MAX_GENERATION_BYTES);
    if (sha(bytes) !== ptr.sha256) throw new IngestError('INDEX_PUBLICATION_UNCERTAIN');
    const snapshot = parseCanonical(bytes) as Snapshot;
    if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.rootId !== this.root.id
        || !Array.isArray(snapshot.entries) || snapshot.entries.length > MAX_SOURCES)
      throw new IngestError('INDEX_PUBLICATION_UNCERTAIN');
    const next = new Map<string,IngestResponse>();
    for (const entry of snapshot.entries) {
      probeEntry(entry,this.root);
      if (next.has(entry.sourcePath)) throw new IngestError('INDEX_PUBLICATION_UNCERTAIN');
      next.set(entry.sourcePath,entry.response);
    }
    this.entries=next;
    });
  }
  paths(): string[] {
    if(this.unavailable) throw new IngestError('INDEX_PUBLICATION_UNCERTAIN');
    return [...this.entries.keys()].sort();
  }
  get(path: string): IngestResponse | null {
    if (this.unavailable) throw new IngestError('INDEX_PUBLICATION_UNCERTAIN');
    return this.entries.get(path) ?? null;
  }
  revoke(path: string): void { this.entries.delete(path); }
  async publish(path: string, response: IngestResponse, stillCurrent: ()=>Promise<boolean>,
    signal: AbortSignal): Promise<void> {
    if (this.unavailable) throw new IngestError('INDEX_PUBLICATION_UNCERTAIN');
    return withPrivateDerivedDirectory(this.path,this.root.path,async dir=>{
    probeEntry({sourcePath:path,response},this.root);
    const next = new Map(this.entries);
    next.set(path,response);
    if (next.size > MAX_SOURCES) throw new IngestError('ADVANCED_RESOURCE_REFUSED');
    const snapshot: Snapshot = {schemaVersion:1, rootId:this.root.id,
      entries:[...next].sort(([a],[b])=>a.localeCompare(b))
        .map(([sourcePath,value])=>({sourcePath,response:value}))};
    const bytes = Buffer.from(canonical(snapshot),'utf8');
    if (bytes.length > MAX_GENERATION_BYTES) throw new IngestError('ADVANCED_RESOURCE_REFUSED');
    const hash = sha(bytes);
    const name=hash+'.json';
    const stage = join(dir,'.stage-'+randomUUID());
    const check = async () => {
      if (signal.aborted) throw new IngestError('ADVANCED_CANCELLED');
      if (!(await stillCurrent())) throw new IngestError('SOURCE_STALE');
      if (signal.aborted) throw new IngestError('ADVANCED_CANCELLED');
    };
    await check();
    try {
      try { await persist(stage,bytes); }
      catch { throw new IngestError('INDEX_PUBLICATION_UNCERTAIN'); }
      // Previous generation remains referenced by CURRENT until new pointer is committed.
      if (!(await readdir(dir)).includes(name)) await rename(stage,join(dir,name));
      else {
        const existing = await strictFile(join(dir,name),MAX_GENERATION_BYTES);
        if (sha(existing) !== hash) throw new IngestError('INDEX_PUBLICATION_UNCERTAIN');
        await unlink(stage);
      }
      await syncDirectory(dir);
      await check();
      const pointer: Pointer={schemaVersion:1,rootId:this.root.id,filename:name,sha256:hash};
      const pointerStage=join(dir,'.stage-'+randomUUID());
      await persist(pointerStage,Buffer.from(canonical(pointer),'utf8'));
      await check();
      // Synchronous publish point. Any rename error is ambiguous; fail closed.
      try { await rename(pointerStage,join(dir,pointerName)); }
      catch { this.unavailable=true; throw new IngestError('INDEX_PUBLICATION_UNCERTAIN'); }
      this.entries=next;
      try { await syncDirectory(dir); }
      catch { this.unavailable=true; throw new IngestError('INDEX_PUBLICATION_UNCERTAIN'); }
      // Remove old generations only after the new CURRENT is durable.
      // A crash may leave up to bounded remnants; load() rejects unbounded garbage.
      const names=await readdir(dir);
      for (const old of names) if (namePattern.test(old) && old!==name) {
        await unlink(join(dir,old)).catch(()=>{ /* next run may signal bounded maintenance */ });
      }
    } catch(error) {
      // No entry became visible in memory before authenticated publication.
      if (error instanceof IngestError) throw error;
      throw new IngestError('INDEX_PUBLICATION_UNCERTAIN');
    }
     });
  }
}
