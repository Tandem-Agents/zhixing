import { realpathSync } from 'node:fs';

/** npm's POSIX bin is a symlink. Every self-exec and adjacent asset lookup
 * uses the physical entry, while the user's cwd remains entirely unrelated. */
export function resolveCliEntry(entry = process.argv[1], realpath: (file: string) => string = realpathSync): string {
  if (!entry) throw Error('cli-entry-unavailable');
  return realpath(entry);
}
