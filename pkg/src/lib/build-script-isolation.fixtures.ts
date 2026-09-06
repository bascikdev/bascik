/**
 * Prompt 103 shared helpers: run REAL build-script execution against isolated
 * temp fixtures so the integration suite compares final HTML bytes (not just
 * task-runner JSON). Nothing here mocks `execFile`, `child_process`, or the
 * semaphore: the whole point is that cold, warm, and partial-hit executions
 * produce per-script output ownership independent of cache temperature and
 * neighboring misses.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

/** Absolute path of the isolated fixture root for the given label. */
export const buildScriptFixtureRoot = (label: string): string =>
  join(tmpdir(), `bascik-103-${label}-${process.pid}-${Date.now()}`);

export const createFixtureDirs = async (root: string): Promise<void> => {
  await mkdir(join(root, "src/pages"), { recursive: true });
  await mkdir(join(root, "src/components"), { recursive: true });
  await mkdir(join(root, "src/lib"), { recursive: true });
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

/** A single real `bascik --build` against `root`; throws if the CLI fails. */
export const runRealBuildScriptBuild = async (
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

/** Write the minimal fixture config used by the build-script isolation tests. */
export const writeBuildScriptConfig = async (
  root: string,
  workers: boolean,
  onBuildScriptError: "error" | "warn" = "error",
): Promise<void> => {
  await writeFixtureFile(
    root,
    "bascik.config.js",
    `module.exports = {
  directory: { pages: "src/pages", components: ["src/components"] },
  scripts: { cache: { enabled: true }, onBuildScriptError: "${onBuildScriptError}" },
  pipeline: { workers: ${workers} },
  generate: { sitemap: false, robots: false, cspHashes: false, manifest: false },
  minify: { html: false, css: false, js: false, identifiers: false },
};`,
  );
};

/**
 * The counter helper is authored by the test as `src/lib/helper.js` with
 * `export let counter = 0; export const next = () => ++counter;`.
 * It deliberately owns process-local state: `next()` returns 1, then 2, 3, ...
 * within one execution context. Two sibling build scripts importing this helper
 * must each see their own module instance (counter starts at 1) because each
 * script runs in its own fresh process. A shared-process batch would let the
 * second script see counter=2.
 */

/**
 * Page with two sibling build scripts that import `../lib/helper.js` and each
 * emit a <span data-testid> whose text encodes their own counter value.
 */
export const twoScriptPageTemplate = (extraComment = ""): string =>
  `<!DOCTYPE html><html lang="en"><head><title>iso</title></head><body>
<script data-bascik-build>
import { next } from '../lib/helper.js';
const n = next();
console.log('<span data-testid="count-a">first:' + n + '</span>');
</script>
<script data-bascik-build>
import { next } from '../lib/helper.js';
const n = next();
console.log('<span data-testid="count-b">second:' + n + '</span>');${extraComment}
</script>
</body></html>`;

export const readDistHtml = async (root: string, routeFile = "index.html"): Promise<string> =>
  readFile(join(root, "dist", routeFile), "utf8");