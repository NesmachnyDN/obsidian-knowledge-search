/** Linux descriptor-anchored private index directory.
 * Walk/create each component with O_DIRECTORY|O_NOFOLLOW and keep a descriptor
 * open throughout IO: swapping an XDG ancestor cannot redirect writes to Vault.
 */
import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { IngestError } from './protocol';

const refused = (): never => { throw new IngestError('INDEX_PUBLICATION_UNCERTAIN'); };
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const beneath = (path: string, root: string): boolean =>
  path === root || path.startsWith(root + sep);

/** All caller IO must use the anchored returned directory; never path-based IO
 * after closing its descriptor. Reject symlinked ancestors even outside Vault.
 */
export async function withPrivateDerivedDirectory<T>(path: string, vaultPath: string,
  action: (anchoredDir: string) => Promise<T>): Promise<T> {
  const target = resolve(path), vault = resolve(vaultPath);
  if (!target.startsWith(sep) || beneath(target, vault)) refused();
  let current: string = sep;
  let enteredAction = false;
  let dir = await open(sep, directoryFlags);
  try {
    const components = target.slice(1).split(sep);
    if (!components.length || components.some(part => !part || part === '.' || part === '..'))
      refused();
    for (const part of components) {
      const childPath = '/proc/self/fd/' + dir.fd + '/' + part;
      let child;
      try { child = await open(childPath, directoryFlags); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') refused();
        try { await mkdir(childPath, {mode: 0o700}); }
        catch (cause) {
          // A concurrent creator may have created a real directory; never
          // follow a symlink or silently accept non-directory replacements.
          if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') refused();
        }
        try { child = await open(childPath, directoryFlags); }
        catch { refused(); }
      }
      await dir.close();
      dir = child!;
      current = join(current, part);
      // The live descriptor is the authority; reject renames, symlink
      // ancestors and a path that resolves to anything besides this location.
      if (await realpath('/proc/self/fd/' + dir.fd) !== current) refused();
    }
    const actual = await realpath('/proc/self/fd/' + dir.fd);
    if (actual !== target || beneath(actual, vault)) refused();
    const st = await dir.stat();
    if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0)
      refused();
    // The final "." is required by syncDirectory(O_NOFOLLOW): /proc/self/fd/N
    // itself is a procfs symlink, while /proc/self/fd/N/. is the directory.
    enteredAction = true;
    return await action('/proc/self/fd/' + dir.fd + '/.');
  } catch (error) {
    if (enteredAction || error instanceof IngestError) throw error;
    return refused();
  } finally {
    await dir.close();
  }
}
