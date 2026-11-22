import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join, parse, resolve, sep } from 'node:path';
import {
  BOUNDS, SCHEMA, StandaloneError, hash, isDigest, isRecord,
  validateGeneration, type IndexGeneration,
} from './contracts';

type Pointer = { schemaVersion: typeof SCHEMA; rootId: string; generationId: string; contentSha256: string };
export type LoadResult = { generation: IndexGeneration | null; recovered: boolean; error: string | null };

async function secureDir(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new StandaloneError('CACHE_PATH_INVALID');
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const component of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new StandaloneError('CACHE_PATH_REJECTED');
  }
}
// Crash-interrupted temp files are derived-only. A short grace period avoids
// touching a stage from another concurrently starting instance. Never follow
// symlinks or remove unknown filenames. Excess orphans fail admission.
async function pruneOldStages(dir: string): Promise<void> {
  const names = (await readdir(dir)).filter(name =>
    /^\.stage-[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(name));
  if (names.length > 8) throw new StandaloneError('INDEX_LIMIT');
  for (const name of names) {
    const path = join(dir, name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new StandaloneError('INDEX_CORRUPT');
    if (Date.now() - info.mtimeMs > 60000) await unlink(path);
  }
}
async function generationCapacity(dir: string, extra: number): Promise<void> {
  const count = (await readdir(dir)).filter(name => /^gen-[0-9a-f]{64}\.json$/.test(name)).length;
  // Two retained generations plus at most two abandoned crash candidates.
  if (count + extra > 4) throw new StandaloneError('INDEX_LIMIT');
}
async function syncDir(dir: string): Promise<void> {
  const handle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function readBounded(path: string, max: number): Promise<Buffer | null> {
  let fd;
  try { fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > max)
      throw new StandaloneError('INDEX_CORRUPT');
    const content = Buffer.alloc(before.size);
    let count = 0;
    while (count < content.length) {
      const { bytesRead } = await fd.read(content, count, content.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const after = await fd.stat();
    if (count !== content.length || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      throw new StandaloneError('INDEX_CORRUPT');
    return content;
  } finally { await fd.close(); }
}
async function atomicFile(dir: string, dest: string, data: Buffer): Promise<void> {
  const temporary = join(dir, '.stage-' + randomUUID());
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await handle.writeFile(data); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, join(dir, dest));
    await syncDir(dir);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
export class GenerationStore {
  private currentPointer: Pointer | null = null;
  private previousPointer: Pointer | null = null;
  private constructor(readonly dir: string, readonly rootId: string) {}
  static async open(dir: string, rootId: string): Promise<GenerationStore> {
    if (!isDigest(rootId) || !isAbsolute(dir)) throw new StandaloneError('CACHE_PATH_INVALID');
    await secureDir(dir);
    await pruneOldStages(resolve(dir));
    await generationCapacity(resolve(dir), 0);
    return new GenerationStore(resolve(dir), rootId);
  }
  private async readPointer(name: 'CURRENT' | 'PREVIOUS'): Promise<Pointer | null> {
    const bytes = await readBounded(join(this.dir, name), 4096);
    if (!bytes) return null;
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new StandaloneError('INDEX_CORRUPT'); }
    if (isRecord(value) && value.rootId !== this.rootId)
      throw new StandaloneError('VAULT_IDENTITY_CHANGED');
    if (!isRecord(value) || value.schemaVersion !== SCHEMA
      || !isDigest(value.generationId) || !isDigest(value.contentSha256)
      || Object.keys(value).length !== 4) throw new StandaloneError('INDEX_INCOMPATIBLE');
    return value as Pointer;
  }
  private async generation(pointer: Pointer): Promise<IndexGeneration> {
    const contents = await readBounded(join(this.dir, 'gen-' + pointer.generationId + '.json'),
      BOUNDS.generationBytes);
    if (!contents || hash(contents) !== pointer.contentSha256) throw new StandaloneError('INDEX_CORRUPT');
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents)); }
    catch { throw new StandaloneError('INDEX_CORRUPT'); }
    validateGeneration(parsed, this.rootId);
    if (parsed.generationId !== pointer.generationId) throw new StandaloneError('INDEX_INCOMPATIBLE');
    return parsed;
  }
  async load(): Promise<LoadResult> {
    let currentError: string | null = null;
    for (const name of ['CURRENT', 'PREVIOUS'] as const) {
      try {
        const pointer = await this.readPointer(name);
        if (!pointer) continue;
        const generation = await this.generation(pointer);
        if (name === 'CURRENT') this.currentPointer = pointer;
        else { this.previousPointer = pointer; this.currentPointer = null; }
        return { generation, recovered: name === 'PREVIOUS', error: name === 'PREVIOUS' ? currentError : null };
      } catch (error) {
        if (error instanceof StandaloneError && error.code === 'VAULT_IDENTITY_CHANGED') throw error;
        currentError = error instanceof StandaloneError ? error.code : 'INDEX_IO_ERROR';
      }
    }
    this.currentPointer = null;
    this.previousPointer = null;
    const directory = await readdir(this.dir);
    const existing = directory.some(x => x === 'CURRENT' || x === 'PREVIOUS' || /^gen-[0-9a-f]{64}\.json$/.test(x));
    return { generation: null, recovered: false, error: currentError ?? (existing ? 'INDEX_CORRUPT' : null) };
  }
  async commit(generation: IndexGeneration): Promise<IndexGeneration> {
    validateGeneration(generation, this.rootId);
    let serialized: Buffer<ArrayBufferLike> = Buffer.from(JSON.stringify(generation), 'utf8');
    if (serialized.length > BOUNDS.generationBytes) throw new StandaloneError('INDEX_LIMIT');
    const target = join(this.dir, 'gen-' + generation.generationId + '.json');
    const existing = await readBounded(target, BOUNDS.generationBytes);
    let actual = generation;
    if (!existing) await generationCapacity(this.dir, 1);
    if (existing) {
      // The canonical ID is over source records, not the publication timestamp.
      // Re-adopting an identical committed generation must preserve its original timestamp.
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(existing)); }
      catch { throw new StandaloneError('INDEX_CORRUPT'); }
      validateGeneration(parsed, this.rootId);
      if (parsed.generationId !== generation.generationId)
        throw new StandaloneError('INDEX_INCOMPATIBLE');
      serialized = existing;
      actual = parsed;
    } else await atomicFile(this.dir, basename(target), serialized);
    const pointer: Pointer = {
      schemaVersion: SCHEMA, rootId: this.rootId, generationId: generation.generationId,
      contentSha256: hash(serialized),
    };
    // Safe rollback: preserve the old CURRENT snapshot while the next pointer is staged.
    if (this.currentPointer) await atomicFile(this.dir, 'PREVIOUS', Buffer.from(JSON.stringify(this.currentPointer)));
    await atomicFile(this.dir, 'CURRENT', Buffer.from(JSON.stringify(pointer)));
    this.previousPointer = this.currentPointer;
    this.currentPointer = pointer;
    // Only unlink known derived generation filenames; never remove any Vault source.
    // Orphans of an interrupted stage are discarded after a confirmed publication.
    const live = new Set([this.currentPointer.generationId, this.previousPointer?.generationId]);
    for (const file of await readdir(this.dir)) {
      const match = /^gen-([0-9a-f]{64})\.json$/.exec(file);
      if (match && !live.has(match[1])) await unlink(join(this.dir, file));
    }
    return actual;
  }
}
