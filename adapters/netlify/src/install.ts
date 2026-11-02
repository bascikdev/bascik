/**
 * @module install
 *
 * Copies the adapter's output out of `dist/.bascik/<target>/` to the places
 * Netlify reads: `publish/` (netlify.toml's publish directory) and
 * `.netlify/v1/functions/` (the Frameworks API functions directory).
 *
 *   bascik --build --target @bascik/adapter-netlify && bascik-netlify-install
 *
 * Bascik rejects adapter output outside the target folder, so this runs as a
 * separate step after the build.
 */

import {
  cp,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveAdapterProjectPaths } from "@bascik/bascik/adapter";
import {
  ADAPTER_NAME,
  FUNCTION_DIR,
  FUNCTION_FILE,
  NETLIFY_FUNCTION_DIR,
  PUBLISH_DIR,
} from "./paths.js";

/** The target folder holding the newest Netlify adapter build. */
export async function findAdapterOutput(distDir: string): Promise<string> {
  const root = join(distDir, ".bascik");
  let newest: { dir: string; builtAt: number } | undefined;
  for (const entry of await readdir(root, { withFileTypes: true }).catch(
    () => [],
  )) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const infoPath = join(dir, "build-info.json");
    const info = await readFile(infoPath, "utf8")
      .then((text) => JSON.parse(text) as { adapter?: string })
      .catch(() => undefined);
    if (info?.adapter !== ADAPTER_NAME) continue;
    const builtAt = (await stat(infoPath)).mtimeMs;
    if (!newest || builtAt > newest.builtAt) newest = { dir, builtAt };
  }
  if (!newest)
    throw new Error(
      `[netlify-install] no "${ADAPTER_NAME}" adapter build found under ${root}. Run bascik --build --target @bascik/adapter-netlify first.`,
    );
  return newest.dir;
}

const isInside = (path: string, parent: string): boolean => {
  const rel = relative(parent, path);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
};

/** Resolve existing ancestors too: a destination need not have been created yet. */
async function physicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      const target = await readlink(path);
      return await physicalPath(resolve(dirname(path), target));
    } catch (linkError) {
      if (
        !["ENOENT", "EINVAL"].includes(
          (linkError as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw linkError;
    }
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await physicalPath(parent), relative(parent, path));
  }
}

async function assertSafeDestinations(
  projectRoot: string,
  destinations: string[],
  protectedPaths: string[],
): Promise<void> {
  const physicalRoot = await physicalPath(projectRoot);
  const protectedEntries = await Promise.all(
    protectedPaths.map(async (path) => ({
      path,
      physical: await physicalPath(path),
    })),
  );
  for (const destination of destinations) {
    const physical = await physicalPath(destination);
    if (!isInside(physical, physicalRoot))
      throw new Error(
        `[netlify-install] refusing to replace ${destination}: destination resolves outside the project.`,
      );
    for (const entry of protectedEntries)
      if (
        isInside(destination, entry.path) ||
        isInside(entry.path, destination) ||
        isInside(physical, entry.physical) ||
        isInside(entry.physical, physical)
      )
        throw new Error(
          `[netlify-install] refusing to replace ${destination}: overlaps source or build output ${entry.path}.`,
        );
  }
}

/** A nested source symlink can alias a destination even when its root does not. */
async function sourceSymlinkTargets(roots: string[]): Promise<string[]> {
  const visited = new Set<string>();
  const targets: string[] = [];
  async function visit(path: string): Promise<void> {
    const physical = await physicalPath(path);
    if (visited.has(physical)) return;
    visited.add(physical);
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (
        ["ENOENT", "ENOTDIR"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        return;
      throw error;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        targets.push(await physicalPath(child));
        await visit(child);
      } else if (entry.isDirectory()) await visit(child);
    }
  }
  for (const root of roots) await visit(root);
  return targets;
}

/** Replace publish/ and the Bascik function with the adapter's latest output. */
export async function installNetlifyOutput(
  projectRoot: string,
  distDir?: string,
  configArgv: string[] = [],
): Promise<{ publishDir: string; functionPath?: string }> {
  projectRoot = resolve(projectRoot);
  const paths = await resolveAdapterProjectPaths(projectRoot, configArgv);
  const outDir = await findAdapterOutput(
    resolve(projectRoot, distDir ?? paths.distDir),
  );
  const publishDir = join(projectRoot, PUBLISH_DIR);
  const functionDir = join(projectRoot, NETLIFY_FUNCTION_DIR);
  const functionPath = join(functionDir, FUNCTION_FILE);
  await assertSafeDestinations(
    projectRoot,
    [publishDir, functionPath],
    [
      ...paths.sourceRoots,
      ...(await sourceSymlinkTargets(paths.sourceRoots)),
      outDir,
    ],
  );
  // Validate both inputs before replacing either destination.
  const publishSource = join(outDir, PUBLISH_DIR);
  if (!(await stat(publishSource)).isDirectory())
    throw new Error(
      `[netlify-install] expected a directory at ${publishSource}.`,
    );
  const built = join(outDir, FUNCTION_DIR, FUNCTION_FILE);
  const hasFunction = await stat(built).then(
    (entry) => {
      if (!entry.isFile())
        throw new Error(`[netlify-install] expected a file at ${built}.`);
      return true;
    },
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  await rm(publishDir, { recursive: true, force: true });
  await cp(publishSource, publishDir, { recursive: true });
  await rm(functionPath, { force: true });
  if (!hasFunction) return { publishDir };
  await mkdir(functionDir, { recursive: true });
  await cp(built, functionPath);
  return { publishDir, functionPath };
}
