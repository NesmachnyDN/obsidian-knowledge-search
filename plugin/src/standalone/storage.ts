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
export type CommitOutcome = {
  generation: IndexGeneration;
  publication: 'rename-confirmed' | 'rename-authenticated-after-error';
  maintenanceWarning: 'INDEX_GC_FAILED' | 'INDEX_DURABILITY_UNCERTAIN' | null;
};

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
async function atomicFile(dir: string, dest: string, data: Buffer,
  beforeRename?: () => void, afterRename?: () => void): Promise<void> {
  const temporary = join(dir, '.stage-' + randomUUID());
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await handle.writeFile(data); await handle.sync(); }
    finally { await handle.close(); }
    // Last cancellable boundary: no await between the guard and starting rename.
    // A rename already started cannot be safely revoked by a later cancel.
    beforeRename?.();
    await rename(temporary, join(dir, dest));
    // A successful rename is already visible; notify the owner before any
    // subsequent awaited fsync or garbage collection can fail or be delayed.
    afterRename?.();
    await syncDir(dir);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
function samePointer(a: Pointer | null, b: Pointer | null): boolean {
  return a === null || b === null ? a === b
    : a.schemaVersion === b.schemaVersion && a.rootId === b.rootId
      && a.generationId === b.generationId && a.contentSha256 === b.contentSha256;
}
export class GenerationStore {
  private publicationUncertain = false;
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
        // A recovered PREVIOUS is the authoritative in-memory current snapshot.
        // Its original pointer must survive the next commit as the new PREVIOUS;
        // retaining a null currentPointer would garbage-collect its generation.
        this.currentPointer = pointer;
        this.previousPointer = null;
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
  async commit(generation: IndexGeneration,
    beginPublication?: () => void,
    onPublished?: (generation: IndexGeneration) => void): Promise<CommitOutcome> {
    if (this.publicationUncertain) throw new StandaloneError('INDEX_PUBLICATION_UNCERTAIN');
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
    // The only cancellable boundary is immediately before the CURRENT rename.
    // Once rename succeeds, both store and engine switch in memory synchronously;
    // subsequent directory fsync / GC failures must not report an uncommitted write.
    let renamed = false;
    let warning: CommitOutcome['maintenanceWarning'] = null;
    let publication: CommitOutcome['publication'] = 'rename-confirmed';
    try {
      await atomicFile(this.dir, 'CURRENT', Buffer.from(JSON.stringify(pointer)), beginPublication, () => {
        renamed = true;
        this.previousPointer = this.currentPointer;
        this.currentPointer = pointer;
        onPublished?.(actual);
      });
    } catch (error) {
      if (!renamed) {
        // A rejected rename Promise is NOT proof that the filesystem rename
        // failed. Authenticate the actual CURRENT before choosing either outcome.
        // Keep the publication boundary noncancellable while this is unresolved.
        try {
          const observed = await this.readPointer('CURRENT');
          if (samePointer(observed, pointer)) {
            // The rename happened but was reported as failed. Authenticate the
            // generation AND rollback pointer before promoting it in memory.
            const verified = await this.generation(pointer);
            const rollback = await this.readPointer('PREVIOUS');
            if (!samePointer(rollback, this.currentPointer))
              throw new StandaloneError('INDEX_PUBLICATION_UNCERTAIN');
            if (rollback) await this.generation(rollback);
            this.previousPointer = this.currentPointer;
            this.currentPointer = pointer;
            onPublished?.(verified);
            publication = 'rename-authenticated-after-error';
            warning = 'INDEX_DURABILITY_UNCERTAIN';
          } else if (samePointer(observed, this.currentPointer)) {
            // Confirm a rejected rename only when the OLD pointer itself is
            // still authentic; do not silently accept damaged/foreign state.
            if (observed) await this.generation(observed);
            throw error;
          } else {
            throw new StandaloneError('INDEX_PUBLICATION_UNCERTAIN');
          }
        } catch (observationError) {
          if (observationError === error) throw error;
          // Unknown/mismatched CURRENT: do not accept another write on this
          // store instance; the engine must suppress all search evidence.
          this.publicationUncertain = true;
          throw new StandaloneError('INDEX_PUBLICATION_UNCERTAIN');
        }
      } else {
        // Rename confirmed but directory fsync failed: power-loss durability
        // remains uncertain. The synchronous published callback already fired.
        warning = 'INDEX_DURABILITY_UNCERTAIN';
      }
    }
    if (!warning) {
      // GC is post-commit maintenance, never part of the publication outcome.
      // Leave unreachable generations for the bounded quota/recovery policy if
      // cleanup fails. Never delete CURRENT, PREVIOUS or any Vault source.
      try {
        const live = new Set([this.currentPointer!.generationId, this.previousPointer?.generationId]);
        for (const file of await readdir(this.dir)) {
          const match = /^gen-([0-9a-f]{64})\.json$/.exec(file);
          if (match && !live.has(match[1])) await unlink(join(this.dir, file));
        }
        await syncDir(this.dir);
      } catch {
        warning = 'INDEX_GC_FAILED';
      }
    }
    return { generation: actual, publication, maintenanceWarning: warning };
  }
}
