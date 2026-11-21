/**
 * A build whose private folder (.bascik) or output folder cannot be written.
 *
 * With `chmod 555 .bascik`, `bascik --build` compiled every page, then
 * failed with a bare "EACCES: permission denied, mkdir '.../.bascik/dist'".
 * It now stops before compiling with a [bascik] error naming the folder and
 * what to do; so does the dev server, which needs the folder too.
 */

import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  cleanupFixture,
  fixtureRoot,
  writeFixtureFile,
} from "./lib/build-fixtures.ts";

const execFileAsync = promisify(execFile);
const cli = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");
const DEV_PORT = "24564";
const roots: string[] = [];
const locked: string[] = [];

afterEach(async () => {
  await Promise.all(locked.splice(0).map((path) => chmod(path, 0o755)));
  await Promise.all(roots.splice(0).map(cleanupFixture));
});

const run = async (
  cwd: string,
  args: string[],
): Promise<{ code: number; output: string }> => {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cli, ...args],
      { cwd, encoding: "utf8", timeout: 60_000 },
    );
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (caught) {
    const error = caught as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof error.code === "number" ? error.code : -1,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
};

const project = async (name: string, lockedFolder: string): Promise<string> => {
  const root = fixtureRoot(`readonly-${name}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  await writeFixtureFile(root, "package.json", '{"type":"module"}');
  await writeFixtureFile(
    root,
    "bascik.config.js",
    `export default { pipeline: { workers: false }, generate: { sitemap: false, robots: false } };`,
  );
  await writeFixtureFile(
    root,
    "src/pages/index.html",
    `<!doctype html><html lang="en"><head><title>Books</title></head><body><h1>Books</h1></body></html>`,
  );
  const lockedPath = join(root, lockedFolder);
  await mkdir(lockedPath, { recursive: true });
  await chmod(lockedPath, 0o555);
  locked.push(lockedPath);
  return root;
};

// A read-only folder does not stop root, and Windows ignores the mode.
const canLock = process.platform !== "win32" && process.getuid?.() !== 0;

describe.skipIf(!canLock)(
  "a private or output folder that cannot be written",
  { timeout: 60_000 },
  () => {
    it("fails the build before compiling, naming .bascik/dist", async () => {
      const root = await project("private", ".bascik");
      const { code, output } = await run(root, ["--build"]);
      expect(output).toMatch(
        /\[bascik\] error: cannot write the private build folder "\.bascik\/dist" \(EACCES\): permission denied/,
      );
      expect(output).not.toMatch(/transpiled/);
      expect(output).not.toMatch(/\n\s+at /);
      expect(code, output).toBe(1);
    });

    it("fails the dev server the same way", async () => {
      const root = await project("private-dev", ".bascik");
      const { code, output } = await run(root, [
        "--port",
        DEV_PORT,
        "--no-pin",
      ]);
      expect(output).toMatch(
        /\[bascik\] error: cannot write the private build folder "\.bascik\/dist"/,
      );
      expect(code, output).toBe(1);
    });

    // The neighbor: a read-only .bascik that still holds a previous build.
    // The clean cannot remove it, and says so before compiling too.
    it("fails the build when .bascik holds an old build it cannot clear", async () => {
      const root = await project("private-inner", ".bascik/dist");
      await chmod(join(root, ".bascik/dist"), 0o755);
      await chmod(join(root, ".bascik"), 0o555);
      locked.push(join(root, ".bascik"));
      const { code, output } = await run(root, ["--build"]);
      expect(output).toMatch(/private build folder/);
      expect(output).toMatch(/EACCES/);
      expect(output).not.toMatch(/transpiled/);
      expect(code, output).toBe(1);
    });

    it("fails the build before compiling when the project root cannot hold dist/", async () => {
      const root = await project("out", "out-parent");
      await writeFixtureFile(
        root,
        "bascik.config.js",
        `export default { directory: { out: "out-parent/dist" }, pipeline: { workers: false }, generate: { sitemap: false, robots: false } };`,
      );
      const { code, output } = await run(root, ["--build"]);
      expect(output).toMatch(
        /\[bascik\] error: cannot write the output directory "out-parent\/dist" \(EACCES\)/,
      );
      expect(output).not.toMatch(/transpiled/);
      expect(code, output).toBe(1);
    });
  },
);
