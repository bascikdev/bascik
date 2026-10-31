/**
 * @module path-containment
 *
 * The one answer pkg gives to "is this path the folder, or inside it?".
 *
 * A hand-rolled `child.startsWith(parent + sep)` misses a parent of `/` or
 * `C:\` (the separator doubles), a parent written with a trailing separator,
 * `..` segments, forward slashes on Windows and Windows' case-insensitive
 * names. `path.relative` already handles all of these (on win32 it compares
 * case-insensitively and across drives), so containment is decided from the
 * relative path between the two.
 */

import { lstatSync } from "node:fs";
import * as nodePath from "node:path";

/** The parts of a `node:path` module the check uses; `path.posix` or `path.win32` in tests. */
export type ContainmentPath = Pick<
  typeof nodePath,
  "relative" | "isAbsolute" | "sep" | "dirname"
>;

/**
 * True when `child` is `parent` or a path inside it. Both should be absolute;
 * they are resolved first, so `..` segments and a trailing separator count
 * as the folder they name. The comparison is by spelling: a symlink, a bind
 * mount or another letter case on a case-insensitive macOS volume is not
 * followed (use isSameOrInsideOnDisk for that).
 */
export const isSameOrInside = (
  child: string,
  parent: string,
  path: ContainmentPath = nodePath,
): boolean => {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  if (rel === "") return true;
  // Another drive or UNC share comes back absolute on win32.
  if (path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
};

/**
 * The device and inode of the entry at `path`, without following a final
 * symlink (a recursive rm removes the link, not its target), or undefined
 * when nothing is there or the file system reports no inode (0).
 */
export const entryIdentity = (path: string): string | undefined => {
  try {
    const stats = lstatSync(path, { bigint: true });
    return stats.ino === 0n ? undefined : `${stats.dev}:${stats.ino}`;
  } catch {
    return undefined;
  }
};

/**
 * isSameOrInside, also true when `parent` exists and `child` or one of its
 * ancestors is that same folder on disk under another spelling. On a
 * case-insensitive file system (the macOS and Windows default) "SRC" is the
 * src folder, and a string comparison misses it; so does any other alias
 * that names the same entry (a bind mount, an 8.3 short name).
 */
export const isSameOrInsideOnDisk = (
  child: string,
  parent: string,
  identify: ((path: string) => string | undefined) | undefined = entryIdentity,
  path: ContainmentPath = nodePath,
): boolean => {
  if (isSameOrInside(child, parent, path)) return true;
  if (!identify) return false;
  const parentIdentity = identify(parent);
  if (parentIdentity === undefined) return false;
  for (let current = child; ; current = path.dirname(current)) {
    if (identify(current) === parentIdentity) return true;
    if (path.dirname(current) === current) return false;
  }
};
