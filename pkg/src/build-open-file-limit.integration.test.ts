/**
 * A build under a low open-file limit.
 *
 * A serial build of 400 pages, 400 static assets and 300 components under
 * `ulimit -n 64` failed with `EMFILE: too many open files`: every page source,
 * static asset, and component file was opened by one `Promise.all`. The build
 * now opens files through a shared bound (open-file-limit.ts). Each test runs
 * the real CLI through `/bin/sh -c "ulimit -n 64; ..."`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map(cleanupFixture));
});

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const runUnderLimit = async (
  cwd: string,
  args: string[],
): Promise<{ code: number; output: string }> => {
  const command = [process.execPath, cli, ...args].map(quote).join(" ");
  try {
    const { stdout, stderr } = await execFileAsync(
      "/bin/sh",
      ["-c", `ulimit -n 64 && exec ${command}`],
      { cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
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

const project = async (name: string, workers: boolean): Promise<string> => {
  const root = fixtureRoot(`open-file-limit-${name}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  await writeFixtureFile(root, "package.json", '{"type":"module"}');
  await writeFixtureFile(
    root,
    "bascik.config.js",
    `export default { pipeline: { workers: ${workers ? 2 : "false"} }, generate: { sitemap: false, robots: false } };`,
  );
  const writes: Promise<void>[] = [];
  for (let index = 0; index < 400; index++) {
    writes.push(
      writeFixtureFile(
        root,
        `src/pages/book-${index}.html`,
        `<!doctype html><html lang="en"><head><title>Book ${index}</title></head><body><h1>Book ${index}</h1><book-card-${index % 300}></book-card-${index % 300}></body></html>`,
      ),
      writeFixtureFile(root, `src/pages/covers/cover-${index}.txt`, `${index}`),
    );
  }
  for (let index = 0; index < 300; index++) {
    writes.push(
      writeFixtureFile(
        root,
        `src/components/book-card-${index}.html`,
        `<article class="card">Middlemarch ${index}</article>`,
      ),
      writeFixtureFile(
        root,
        `src/components/book-card-${index}.css`,
        `.card { color: green; }`,
      ),
      writeFixtureFile(
        root,
        `src/components/book-card-${index}.js`,
        `console.log(${index});`,
      ),
    );
  }
  // Written in batches: the test process has its own open-file limit.
  for (let start = 0; start < writes.length; start += 64)
    await Promise.all(writes.slice(start, start + 64));
  return root;
};

describe.skipIf(process.platform === "win32")(
  "a build under ulimit -n 64",
  { timeout: 180_000 },
  () => {
    for (const workers of [false, true]) {
      const mode = workers ? "page workers" : "serial";
      it(`builds 400 pages, 400 assets and 300 components (${mode})`, async () => {
        const root = await project(`build-${workers}`, workers);
        const { code, output } = await runUnderLimit(root, ["--build"]);
        expect(output).not.toMatch(/EMFILE/);
        expect(code, output.slice(-4000)).toBe(0);
        expect(existsSync(join(root, "dist/book-399.html"))).toBe(true);
        expect(existsSync(join(root, "dist/covers/cover-399.txt"))).toBe(true);
      });
    }

    it("checks the same project with bascik --check", async () => {
      const root = await project("check", false);
      const { code, output } = await runUnderLimit(root, ["--check"]);
      expect(output).not.toMatch(/EMFILE/);
      expect(code, output.slice(-4000)).toBe(0);
    });
  },
);
