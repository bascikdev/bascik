/**
 * @module fs-errors
 *
 * The one test pkg uses for "the path names no file". Where a missing file,
 * a file used as a folder and an overlong name all mean the same thing (a
 * static request for something that is not there, an explicit `--config`
 * path that does not exist), check with isNoSuchFileError. Where only a
 * missing entry is expected and anything else means a broken layout (a
 * lockfile, a build cache, Bascik's private sidecar), keep `code ===
 * "ENOENT"` so the other codes surface as errors, and on that ENOENT ask
 * fileInPlaceOfFolder too: Windows reports a file used as a folder as ENOENT.
 */

import { statSync } from "node:fs";
import * as nodePath from "node:path";

/**
 * A filesystem error that means the path names no file: it does not exist
 * (ENOENT), a component of it is a regular file (ENOTDIR, as in
 * `/robots.txt/x.png`), or a name is over the filesystem limit
 * (ENAMETOOLONG). EACCES, EISDIR, EIO and the rest are real faults.
 */
export const isNoSuchFileError = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ENAMETOOLONG";
};

/**
 * The nearest existing ancestor of `path` when it is not a folder, or
 * undefined when that ancestor is a folder (the path is simply missing) or
 * cannot be read. Windows reports ENOENT, not ENOTDIR, when a component of
 * the path is a regular file (`dist\.bascik` written as a file), so a caller
 * that reads ENOENT as "nothing there" asks this before trusting it. The
 * walk stops at the drive, share or `/` root.
 */
export const fileInPlaceOfFolder = (
  path: string,
  stat: (path: string) => { isDirectory(): boolean } = statSync,
  pathModule: Pick<typeof nodePath, "dirname"> = nodePath,
): string | undefined => {
  let current = pathModule.dirname(path);
  for (;;) {
    try {
      return stat(current).isDirectory() ? undefined : current;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
    }
    const parent = pathModule.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
};
