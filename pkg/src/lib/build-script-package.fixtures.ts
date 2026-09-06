/**
 * Prompt 104 shared helpers: run REAL `bascik --build` against isolated temp
 * fixtures that contain a real `node_modules/` so build scripts can import
 * installed, scoped, subpath-exported, and user-linked packages, and so the
 * on-disk script cache (`node_modules/.cache/bascik/script-cache`) is the exact
 * thing under test. A fresh-process CLI build proves that a changed dependency
 * invalidates the cache key even when the script text and the cached output are
 * preserved across processes.
 *
 * Nothing here mocks `execFile`, `child_process`, or the semaphore: the point is
 * to exercise real child-process execution and real package resolution parity.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

/** Absolute path of the isolated fixture root for the given label. */
export const packageFixtureRoot = (label: string): string =>
  join(tmpdir(), `bascik-104-${label}-${process.pid}-${Date.now()}`);

export const createPackageFixtureDirs = async (root: string): Promise<void> => {
  await mkdir(join(root, "src/pages"), { recursive: true });
  await mkdir(join(root, "src/components"), { recursive: true });
  await mkdir(join(root, "node_modules", ".cache"), { recursive: true });
};

export const writeFixtureFile = async (root: string, relPath: string, content: string): Promise<void> => {
  const abs = join(root, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
};

export const readFixtureFile = async (root: string, relPath: string): Promise<string> =>
  readFile(join(root, relPath), "utf8");

export const cleanupFixture = async (root: string): Promise<void> => {
  await rm(root, { recursive: true, force: true });
};

/**
 * Run a real `bascik --build` against `root` as a fresh CLI process. Throws if
 * the CLI exits non-zero. This is the required fresh-process boundary: an
 * in-memory mock of a changing cache key can never prove resolution parity.
 */
export const runRealPackageBuild = async (
  root: string,
  args: string[] = [],
): Promise<{ stdout: string; stderr: string }> => {
  const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/index.ts");
  const { stdout, stderr } = await execFileAsync(process.execPath, [cli, "--build", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env },
    maxBuffer: 1024 * 1024 * 16,
  });
  return { stdout, stderr };
};

/** Write the minimal fixture config used by the package-identity tests. */
export const writePackageBuildConfig = async (
  root: string,
  workers: boolean,
): Promise<void> => {
  await writeFixtureFile(
    root,
    "bascik.config.js",
    `module.exports = {
  directory: { pages: "src/pages", components: ["src/components"] },
  scripts: { cache: { enabled: true }, onBuildScriptError: "error" },
  pipeline: { workers: ${workers} },
  generate: { sitemap: false, robots: false, cspHashes: false, manifest: false },
  minify: { html: false, css: false, js: false, identifiers: false },
};`,
  );
};

/** Write a minimal node_modules package that exports a single value. */
export const writeInstalledPackage = async (
  root: string,
  pkgPath: string,
  name: string,
  version: string,
  value: string,
  options: { subtype?: boolean } = {},
): Promise<void> => {
  const exports: Record<string, string> = { ".": "./index.mjs" };
  let subIndex = "";
  if (options.subtype) {
    exports["./sub"] = "./sub.mjs";
    subIndex = `export { default as sub } from './sub.mjs';`;
  }
  await writeFixtureFile(
    root,
    join("node_modules", pkgPath, "package.json"),
    `${JSON.stringify({ name, version, type: "module", exports }, null, 2)}\n`,
  );
  await writeFixtureFile(
    root,
    join("node_modules", pkgPath, "index.mjs"),
    `export const value = ${JSON.stringify(value)};\n${subIndex}`,
  );
  if (options.subtype) {
    await writeFixtureFile(
      root,
      join("node_modules", pkgPath, "sub.mjs"),
      `export const sub = ${JSON.stringify(`sub:${value}`)};\n`,
    );
  }
};

/**
 * Reset the fixture script cache so a later build starts cold. This is a TEST
 * setup action in a disposable fixture root, never the shipped fix: the fix
 * must invalidate via the cache key, not by clearing the cache.
 */
export const resetFixtureCache = async (root: string): Promise<void> => {
  await rm(
    join(root, "node_modules", ".cache", "bascik", "script-cache"),
    { recursive: true, force: true },
  );
};

export const readDistHtml = async (root: string, routeFile = "index.html"): Promise<string> =>
  readFile(join(root, "dist", routeFile), "utf8");