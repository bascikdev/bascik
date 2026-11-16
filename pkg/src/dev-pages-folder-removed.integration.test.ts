/**
 * The dev server when the whole pages folder is removed.
 *
 * `rm -rf src/pages` while `bascik` was running logged "[bascik] watch
 * error: OutputPathError: Refusing path outside the configured output
 * directory: .../src/pages" with a stack, twice (both watchers passed the
 * pages root to deleteDistDir, which maps it to the output root and refuses
 * it), then "pages directory ... does not exist" on every rebuild. The
 * server now logs one warning, clears the pages' output, and builds the
 * pages again when the folder comes back.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupFixture,
  fixtureRoot,
  writeFixtureFile,
} from "./lib/build-fixtures.ts";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");
const DEV_PORT = 24553;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(cleanupFixture));
});

const page = (title: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`;

const writePages = async (root: string) => {
  await writeFixtureFile(root, "src/pages/index.html", page("Books"));
  await writeFixtureFile(root, "src/pages/authors/eliot.html", page("Eliot"));
  await writeFixtureFile(root, "src/pages/covers/middlemarch.txt", "cover");
};

const status = async (path: string): Promise<number | null> => {
  try {
    const response = await fetch(`http://localhost:${DEV_PORT}${path}`);
    await response.arrayBuffer();
    return response.status;
  } catch {
    return null;
  }
};

const waitFor = async (
  check: () => boolean | Promise<boolean>,
  timeout = 20_000,
): Promise<boolean> => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
};

describe(
  "the dev server when src/pages is removed",
  { timeout: 90_000 },
  () => {
    // With a watched exec entry, one source observer (watch-source.ts) owns
    // the pages folder instead of the page and asset watchers (watch.ts).
    for (const observer of ["page watchers", "exec source observer"]) {
      it(`warns once, clears the pages' output, and recovers (${observer})`, async () => {
        const root = fixtureRoot(`dev-pages-folder-removed-${observer.length}`);
        roots.push(root);
        await mkdir(root, { recursive: true });
        await writeFixtureFile(root, "package.json", '{"type":"module"}');
        if (observer === "exec source observer") {
          await writeFixtureFile(
            root,
            "bascik.config.js",
            'export default { pipeline: { exec: [{ script: "scripts/pre.mjs", watch: ["content/"] }] } };',
          );
          await writeFixtureFile(root, "scripts/pre.mjs", "export {};");
          await writeFixtureFile(root, "content/books.md", "# Books");
        }
        await writePages(root);
        const child = spawn(
          process.execPath,
          [cli, "--port", String(DEV_PORT), "--no-pin"],
          { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] },
        );
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (output += chunk));
        try {
          expect(
            await waitFor(
              async () => (await status("/authors/eliot")) === 200,
              45_000,
            ),
            output,
          ).toBe(true);
          // The boot compile and its asset copy are done, as when a person
          // deletes the folder in a running session.
          expect(
            await waitFor(() => /All tasks completed/.test(output)),
            output,
          ).toBe(true);

          await rm(join(root, "src/pages"), { recursive: true, force: true });
          const warning =
            /\[bascik\] warning: pages folder "src\/pages" \(directory\.pages\) was removed/g;
          expect(await waitFor(() => warning.test(output)), output).toBe(true);
          expect(
            await waitFor(
              () =>
                !existsSync(join(root, "dist/authors/eliot.html")) &&
                !existsSync(join(root, "dist/covers/middlemarch.txt")),
            ),
            output,
          ).toBe(true);
          expect(
            await waitFor(async () => (await status("/authors/eliot")) === 404),
            output,
          ).toBe(true);
          // Let every watcher event from the removal land.
          await new Promise((done) => setTimeout(done, 1_500));
          expect(output.match(warning) ?? [], output).toHaveLength(1);
          expect(output).not.toMatch(/OutputPathError|watch error/);
          expect(output).not.toMatch(/does not exist in/);
          expect(output).not.toMatch(/\n\s+at /);

          await writePages(root);
          expect(
            await waitFor(async () => (await status("/authors/eliot")) === 200),
            output,
          ).toBe(true);
          expect(
            await waitFor(
              async () => (await status("/covers/middlemarch.txt")) === 200,
            ),
            output,
          ).toBe(true);
          expect(output).toMatch(/pages folder "src\/pages" is back/);
          expect(child.exitCode).toBeNull();
        } finally {
          const exited = new Promise((done) => child.once("exit", done));
          if (child.exitCode === null && child.signalCode === null) {
            process.kill(-child.pid!, "SIGKILL");
            await exited;
          }
        }
      });
    }
  },
);
