/**
 * A build that cannot read a folder of pages fails.
 *
 * `bascik --build` used to print "Failed to read subdirectory" with a raw
 * Node stack (twice), leave out every page in the folder, and exit 0. These
 * tests run the real CLI against a sub-folder of src/pages made unreadable
 * with `chmod 000`: a build (serial and with page workers) and `bascik
 * --check` fail with one [bascik] error naming the folder, and the dev server
 * warns once and serves the other pages.
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
const DEV_PORT = 24551;
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

const page = (title: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`;

const project = async (name: string, workers: boolean): Promise<string> => {
  const root = fixtureRoot(`unreadable-folder-${name}`);
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
  await writeFixtureFile(root, "src/pages/sub/inner.html", page("Inner"));
  const lockedPath = join(root, "src/pages/sub");
  await chmod(lockedPath, 0o000);
  locked.push(lockedPath);
  return root;
};

const folderError =
  /\[bascik\] error: could not read folder "src\/pages\/sub": EACCES/;

// `chmod 000` does not stop the owner on Windows, or root anywhere.
const canLock = process.platform !== "win32" && process.getuid?.() !== 0;

describe.skipIf(!canLock)(
  "a pages sub-folder the build cannot read",
  { timeout: 60_000 },
  () => {
    for (const workers of [false, true]) {
      const mode = workers ? "page workers" : "serial";
      it(`fails the build once, naming the folder (${mode})`, async () => {
        const root = await project(`build-${workers}`, workers);
        const { code, output } = await run(root, ["--build"]);
        expect(code, output).toBe(1);
        expect(output.match(new RegExp(folderError, "g")) ?? []).toHaveLength(
          1,
        );
        expect(output).not.toMatch(/Failed to read subdirectory/);
        expect(output).not.toMatch(/\n\s+at /);
        expect(output).not.toMatch(/Build complete/);
      });
    }

    // The same scan lists components: a folder of them is not skipped either.
    it("fails the build for an unreadable components folder", async () => {
      const root = await project("components", false);
      await chmod(join(root, "src/pages/sub"), 0o755);
      await writeFixtureFile(
        root,
        "src/components/cards/book-card.html",
        "<p>Book</p>",
      );
      const lockedPath = join(root, "src/components/cards");
      await chmod(lockedPath, 0o000);
      locked.push(lockedPath);
      const { code, output } = await run(root, ["--build"]);
      expect(code, output).toBe(1);
      expect(output).toMatch(
        /\[bascik\] error: could not read folder "src\/components\/cards": EACCES/,
      );
      expect(output).not.toMatch(/\n\s+at /);
    });

    it("fails bascik --check at an unreadable components folder, not the config", async () => {
      const root = await project("check-components", false);
      await chmod(join(root, "src/pages/sub"), 0o755);
      await writeFixtureFile(
        root,
        "src/components/cards/book-card.html",
        "<p>Book</p>",
      );
      const lockedPath = join(root, "src/components/cards");
      await chmod(lockedPath, 0o000);
      locked.push(lockedPath);
      const { code, output } = await run(root, ["--check"]);
      expect(code, output).toBe(1);
      expect(output).toMatch(
        /could not read folder "src\/components\/cards": EACCES[^\n]*\(src\/components\/cards\)/,
      );
      expect(output).not.toMatch(/\[bascik\] error: could not read folder/);
      expect(output).not.toMatch(/\(bascik\.config\.js\)/);
    });

    it("fails bascik --check, naming the folder", async () => {
      const root = await project("check", false);
      const { code, output } = await run(root, ["--check"]);
      expect(code, output).toBe(1);
      expect(output).toMatch(/could not read folder "src\/pages\/sub": EACCES/);
      expect(output).not.toMatch(/has no HTML pages/);
      expect(output).not.toMatch(/\n\s+at /);
    });

    // The second dev server runs with an exec entry that watches a file, so
    // one source watcher (watch-source.ts) owns the pages instead.
    for (const exec of [false, true]) {
      const devMode = exec ? "pipeline.exec watch mode" : "page watchers";
      it(`the dev server warns once and serves the other pages (${devMode})`, async () => {
        const root = await project(exec ? "dev-exec" : "dev", false);
        const port = exec ? DEV_PORT + 1 : DEV_PORT;
        if (exec) {
          await writeFixtureFile(root, "scripts/pre.mjs", "");
          await writeFixtureFile(root, "content/books.md", "# Books");
          await writeFixtureFile(
            root,
            "bascik.config.js",
            `export default { pipeline: { workers: false, exec: [{ script: "scripts/pre.mjs", watch: ["content/"] }] }, generate: { sitemap: false, robots: false } };`,
          );
        }
        await devServerRecovers(root, port);
      });
    }
  },
);

/**
 * Start the dev server on a project whose src/pages/sub cannot be read,
 * check the one warning and the other pages, then make the folder readable
 * and check that its pages, and a page and a stylesheet added to it right
 * after, are served.
 */
const devServerRecovers = async (root: string, port: number): Promise<void> => {
  const child = spawn(
    process.execPath,
    [cli, "--port", String(port), "--no-pin"],
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
        const response = await fetch(`http://localhost:${port}/about`);
        await response.arrayBuffer();
        status = response.status;
      } catch {
        await new Promise((done) => setTimeout(done, 100));
      }
    }
    expect(status, output).toBe(200);
    const warning =
      /\[bascik\] warning: could not read folder "src\/pages\/sub": EACCES/g;
    const warned = Date.now() + 20_000;
    while (!warning.test(output) && Date.now() < warned)
      await new Promise((done) => setTimeout(done, 50));
    // Let the boot's other scans of the same folder finish.
    await new Promise((done) => setTimeout(done, 1_000));
    expect(output.match(warning) ?? [], output).toHaveLength(1);
    expect(output).not.toMatch(/\n\s+at /);
    // Linux refuses to watch the folder (EACCES), macOS does not: the
    // watcher's error is the same warning, not a raw "watch error".
    expect(output).not.toMatch(/watch error/);
    expect(child.exitCode).toBeNull();

    // Readable again: its pages are built, and a page added to it later
    // is seen too (on Linux the folder is watched again).
    await chmod(join(root, "src/pages/sub"), 0o755);
    const served = async (
      path: string,
      expected = "<h1>",
    ): Promise<boolean> => {
      const until = Date.now() + 20_000;
      while (Date.now() < until) {
        const response = await fetch(`http://localhost:${port}${path}`);
        const body = await response.text();
        if (response.status === 200 && body.includes(expected)) return true;
        await new Promise((done) => setTimeout(done, 100));
      }
      return false;
    };
    expect(await served("/sub/inner"), output).toBe(true);
    // Written while the folder is being watched again: on Linux a file
    // that lands before that watch starts is not reported as added.
    await writeFixtureFile(root, "src/pages/sub/later.html", page("Later"));
    await writeFixtureFile(root, "src/pages/sub/later.css", "h1{color:red}");
    expect(await served("/sub/later"), output).toBe(true);
    expect(await served("/sub/later.css", "color:red"), output).toBe(true);
    // And a page added once the folder is watched again.
    await new Promise((done) => setTimeout(done, 1_500));
    await writeFixtureFile(root, "src/pages/sub/last.html", page("Last"));
    expect(await served("/sub/last"), output).toBe(true);
    expect(output).not.toMatch(/watch error/);
  } finally {
    const exited = new Promise((done) => child.once("exit", done));
    if (child.exitCode === null && child.signalCode === null) {
      process.kill(-child.pid!, "SIGKILL");
      await exited;
    }
  }
};
