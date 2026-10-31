/**
 * @module fs-errors
 *
 * The one test pkg uses for "the path names no file". Where a missing file,
 * a file used as a folder and an overlong name all mean the same thing (a
 * static request for something that is not there, an explicit `--config`
 * path that does not exist), check with isNoSuchFileError. Where only a
 * missing entry is expected and anything else means a broken layout (a
 * lockfile, a build cache, Bascik's private sidecar), keep `code ===
 * "ENOENT"` so the other codes surface as errors.
 */

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
