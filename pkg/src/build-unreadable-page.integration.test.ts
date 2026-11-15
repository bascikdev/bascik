/**
 * A build that cannot read a page fails.
 *
 * `bascik --build` used to print a warning for a page it could not read
 * (permission denied, or EMFILE under a low open-file limit), write every
 * other page, and exit 0: the site shipped without the page and CI stayed
 * green. These tests run the real CLI against a page made unreadable with
 * `chmod`, serially and with page workers, for a static and a dynamic page.
 */

import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
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
const roots: string[] = [];
const locked: string[] = [];

afterEach(async () => {
  // Readable again first, or the fixture cannot be removed everywhere.
  await Promise.all(locked.splice(0).map((path) => chmod(path, 0o644)));
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

const page = (title: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`;

const project = async (
  name: string,
  unreadablePage: string,
  workers: boolean,
): Promise<string> => {
  const root = fixtureRoot(`unreadable-page-${name}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  await writeFixtureFile(root, "package.json", '{"type":"module"}');
  await writeFixtureFile(
    root,
    "bascik.config.js",
    `export default { pipeline: { workers: ${workers ? 2 : "false"} }, generate: { sitemap: false, robots: false } };`,
  );
  await writeFixtureFile(root, "src/pages/index.html", page("Home"));
  await writeFixtureFile(root, "src/pages/about.html", page("About"));
  await writeFixtureFile(root, `src/pages/${unreadablePage}`, page("Locked"));
  const lockedPath = join(root, "src/pages", unreadablePage);
  await chmod(lockedPath, 0o000);
  locked.push(lockedPath);
  return root;
};

// `chmod 000` does not stop the owner on Windows, or root anywhere.
const canLock = process.platform !== "win32" && process.getuid?.() !== 0;

describe.skipIf(!canLock)(
  "a page the build cannot read",
  { timeout: 60_000 },
  () => {
    for (const workers of [false, true]) {
      const mode = workers ? "page workers" : "serial";

      it(`fails the build and names the page (${mode})`, async () => {
        const root = await project(`static-${workers}`, "locked.html", workers);
        const { code, output } = await run(root, ["--build"]);
        expect(output).toMatch(/Build failed with 1 page error/);
        expect(output).toMatch(/^ {2}src\/pages\/locked\.html$/m);
        expect(output).toMatch(/EACCES/);
        expect(output).not.toMatch(/Build complete/);
        expect(code).toBe(1);
        expect(existsSync(join(root, "dist/locked.html"))).toBe(false);
      });

      it(`fails the build for a dynamic page it cannot read (${mode})`, async () => {
        const root = await project(
          `dynamic-${workers}`,
          "[slug].html",
          workers,
        );
        const { code, output } = await run(root, ["--build"]);
        expect(output).toMatch(/Build failed with 1 page error/);
        expect(output).toMatch(/^ {2}src\/pages\/\[slug\]\.html$/m);
        expect(output).toMatch(/EACCES/);
        expect(code).toBe(1);
      });
    }
  },
);
