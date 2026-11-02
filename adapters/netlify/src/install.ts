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

import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
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

/** Replace publish/ and the Bascik function with the adapter's latest output. */
export async function installNetlifyOutput(
  projectRoot: string,
  distDir = join(projectRoot, "dist"),
): Promise<{ publishDir: string; functionPath?: string }> {
  const outDir = await findAdapterOutput(distDir);

  const publishDir = join(projectRoot, PUBLISH_DIR);
  await rm(publishDir, { recursive: true, force: true });
  await cp(join(outDir, PUBLISH_DIR), publishDir, { recursive: true });

  const functionDir = join(projectRoot, NETLIFY_FUNCTION_DIR);
  const functionPath = join(functionDir, FUNCTION_FILE);
  await rm(functionPath, { force: true });
  const built = join(outDir, FUNCTION_DIR, FUNCTION_FILE);
  const hasFunction = await readFile(built).then(
    () => true,
    () => false,
  );
  if (!hasFunction) return { publishDir };
  await mkdir(functionDir, { recursive: true });
  await cp(built, functionPath);
  return { publishDir, functionPath };
}
