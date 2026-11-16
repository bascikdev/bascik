/**
 * A build that cannot read a component file fails.
 *
 * `bascik --build` used to print "warning: Failed to process" with a raw Node
 * stack for a component file made unreadable with `chmod 000`, then reported
 * its tag as unresolved, shipped the literal `<my-card></my-card>`, and exited
 * 0. The file is there, so the tag is not unresolved: a build (serial and
 * with page workers) and `bascik --check` fail with one [bascik] error naming
 * the file, as they do for its companion stylesheet, and the dev server warns
 * once and keeps serving.
 */

import { afterEach, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
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
const DEV_PORT = 24552;
const roots: string[] = [];
const locked: string[] = [];

afterEach(async () => {
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

const project = async (
  name: string,
  workers: boolean,
  lockedFile = "book-card.html",
): Promise<string> => {
  const root = fixtureRoot(`unreadable-component-${name}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  await writeFixtureFile(root, "package.json", '{"type":"module"}');
  await writeFixtureFile(
    root,
    "bascik.config.js",
    `export default { pipeline: { workers: ${workers ? 2 : "false"} }, generate: { sitemap: false, robots: false } };`,
  );
  await writeFixtureFile(
    root,
    "src/pages/index.html",
    `<!doctype html><html lang="en"><head><title>Books</title></head><body><h1>Books</h1><book-card></book-card></body></html>`,
  );
  await writeFixtureFile(
    root,
    "src/components/book-card.html",
    `<article class="card">Middlemarch</article>`,
  );
  await writeFixtureFile(
    root,
    "src/components/book-card.css",
    `.card { color: green; }`,
  );
  // Imported by book-card.css only in the @import test.
  await writeFixtureFile(
    root,
    "src/components/shared.css",
    `.card { margin: 0; }`,
  );
  const lockedPath = join(root, "src/components", lockedFile);
  await chmod(lockedPath, 0o000);
  locked.push(lockedPath);
  return root;
};

// `chmod 000` does not stop the owner on Windows, or root anywhere.
const canLock = process.platform !== "win32" && process.getuid?.() !== 0;

describe.skipIf(!canLock)(
  "a component file the build cannot read",
  { timeout: 60_000 },
  () => {
    for (const workers of [false, true]) {
      const mode = workers ? "page workers" : "serial";
      it(`fails the build, naming the file (${mode})`, async () => {
        const root = await project(`build-${workers}`, workers);
        const { code, output } = await run(root, ["--build"]);
        expect(code, output).toBe(1);
        expect(output).toMatch(
          /\[bascik\] error: could not read component file "src\/components\/book-card\.html": EACCES/,
        );
        expect(output).not.toMatch(/Unresolved component tag/);
        expect(output).not.toMatch(/\n\s+at /);
        expect(output).not.toMatch(/Build complete/);
      });
    }

    it("fails the build for an unreadable companion stylesheet", async () => {
      const root = await project("css", false, "book-card.css");
      const { code, output } = await run(root, ["--build"]);
      expect(code, output).toBe(1);
      expect(output).toMatch(
        /\[bascik\] error: could not read component stylesheet "src\/components\/book-card\.css": EACCES/,
      );
      expect(output).not.toMatch(/could not read component file/);
      expect(output).not.toMatch(/\n\s+at /);
    });

    // A stylesheet the companion `.css` imports is read the same way.
    it("fails the build for an unreadable @import-ed stylesheet", async () => {
      const root = await project("css-import", false, "shared.css");
      await writeFixtureFile(
        root,
        "src/components/book-card.css",
        `@import "./shared.css";\n.card { color: green; }`,
      );
      const { code, output } = await run(root, ["--build"]);
      expect(code, output).toBe(1);
      expect(output).toMatch(
        /\[bascik\] error: could not read imported stylesheet "src\/components\/shared\.css": EACCES/,
      );
      expect(output).not.toMatch(/could not read component file/);
      expect(output).not.toMatch(/\n\s+at /);
      expect(output).not.toMatch(/Build complete/);
    });

    it("fails bascik --check at the file, not as an unmatched tag", async () => {
      const root = await project("check", false);
      const { code, output } = await run(root, ["--check"]);
      expect(code, output).toBe(1);
      expect(output).toMatch(
        /could not read component file "src\/components\/book-card\.html": EACCES[^\n]*\(src\/components\/book-card\.html\)/,
      );
      expect(output).not.toMatch(/no matching file/);
    });

    it("the dev server warns once and keeps serving", async () => {
      const root = await project("dev", false);
      const child = spawn(
        process.execPath,
        [cli, "--port", String(DEV_PORT), "--no-pin"],
        { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      try {
        let status: number | null = null;
        const deadline = Date.now() + 45_000;
        while (status === null && Date.now() < deadline) {
          try {
            const response = await fetch(`http://localhost:${DEV_PORT}/`);
            await response.arrayBuffer();
            status = response.status;
          } catch {
            await new Promise((done) => setTimeout(done, 100));
          }
        }
        expect(status, output).toBe(200);
        const warning =
          /\[bascik\] warning: could not read component file "src\/components\/book-card\.html": EACCES/g;
        const warned = Date.now() + 20_000;
        while (!warning.test(output) && Date.now() < warned)
          await new Promise((done) => setTimeout(done, 50));
        await new Promise((done) => setTimeout(done, 1_000));
        expect(output.match(warning) ?? [], output).toHaveLength(1);
        expect(output).not.toMatch(/\n\s+at /);
        expect(child.exitCode).toBeNull();
      } finally {
        const exited = new Promise((done) => child.once("exit", done));
        if (child.exitCode === null && child.signalCode === null) {
          process.kill(-child.pid!, "SIGKILL");
          await exited;
        }
      }
    });
  },
);
