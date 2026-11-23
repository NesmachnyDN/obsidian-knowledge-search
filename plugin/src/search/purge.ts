import { constants } from 'node:fs';
import { lstat, open, readdir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, parse, resolve, sep, join } from 'node:path';
import { isDigest, StandaloneError } from '../standalone/contracts';

// Explicit, disabled-only maintenance. Never recursive, never follow symlinks,
// never accept a caller-controlled directory or remove any unknown file.
const derivedName = (name: string): boolean =>
  ['CURRENT', 'PREVIOUS', 'INFLIGHT_PREVIOUS'].includes(name)
  || /^gen-[0-9a-f]{64}\.json$/.test(name)
  || /^\.stage-[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(name);

export async function purgeDerivedIndex(dir: string, rootId: string, expectedDir: string): Promise<number> {
  const deny = (): never => { throw new StandaloneError('CACHE_PATH_REJECTED'); };
  if (!isDigest(rootId) || !isAbsolute(dir) || resolve(dir) !== resolve(expectedDir)
      || basename(dir) !== 'index' || basename(dirname(dir)) !== rootId
      || basename(dirname(dirname(dirname(dir)))) !== 'plugins') return deny();
  // Check every existing ancestor with lstat; never traverse an unexpected symlink.
  const absolute = resolve(dir);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let st;
    try { st = await lstat(current); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw e;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) return deny();
  }
  const fd = await open(absolute, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const before = await fd.stat();
    const observed = await lstat(absolute);
    if (!observed.isDirectory() || observed.ino !== before.ino || observed.dev !== before.dev)
      return deny();
    const names = await readdir(absolute);
    if (names.length > 24 || names.some(name => !derivedName(name))) return deny();
    // Preflight *all* entries before deleting any, and reject hard links/foreign
    // owners/symlinks/nonregular files. Entire cache stays intact on refusal.
    const owner = process.getuid?.();
    for (const name of names) {
      const st = await lstat(join(absolute, name));
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 ||
        (owner !== undefined && st.uid !== owner)) return deny();
    }
    for (const name of names) await unlink(join(absolute, name));
    await fd.sync();
    return names.length;
  } finally { await fd.close(); }
}
