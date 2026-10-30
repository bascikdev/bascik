/**
 * @module private-dir
 *
 * Where Bascik keeps its private build files: the ownership inventory, the
 * build state, the server-script sidecar, the component manifest, the CSP
 * hashes and the file manifest.
 *
 * They live beside the output directory, never in it. A static host serves
 * every file of the folder it deploys, dotfiles included, so a folder inside
 * dist/ was published by every static deploy (ownership.json with local
 * source paths, and the sidecar with every server script's source). For
 * `directory.out: "dist"` the folder is `.bascik/dist/`, next to dist/; the
 * name of the output directory keeps two output directories apart.
 * `bascik --server`, targeted builds and the adapters run in the project,
 * which holds both. An adapter's deployment folder is still
 * `dist/.bascik/<target>/`: it is what that target deploys, not a private
 * file.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

/** The private folder for an output directory (relative paths resolve against the working directory). */
export const privateDirFor = (outDir: string): string => {
  const out = resolve(outDir);
  return join(dirname(out), ".bascik", basename(out));
};

/** The private folder as messages name it: relative to the working directory, with forward slashes. */
export const privateDirLabel = (outDir: string): string =>
  relative(process.cwd(), privateDirFor(outDir)).replace(/\\/g, "/") ||
  ".bascik";

/**
 * Create the private folder, and a `.gitignore` of `*` in the `.bascik/`
 * folder that holds it (as tool caches do), so its files never reach a
 * commit. An existing `.gitignore` there is kept.
 */
export const ensurePrivateDir = async (outDir: string): Promise<string> => {
  const dir = privateDirFor(outDir);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dirname(dir), ".gitignore"), "*\n", { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  return dir;
};
