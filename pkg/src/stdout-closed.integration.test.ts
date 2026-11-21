/**
 * The CLI keeps working when whatever read its stdout has gone away.
 *
 * `bascik --build | head -1` used to stop the build halfway: the next log
 * line failed with EPIPE, Node raised it as an uncaught exception, and the
 * crash net exited 1 with a partly written output directory. A dev or
 * production server whose log reader went away exited the same way on its
 * next log line.
 *
 * Each test runs the real CLI with a stdout pipe whose read end the test
 * closes right after the spawn, before Node has started, so every write the
 * CLI makes to stdout fails. stderr stays open and is collected.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupFixture,
  fixtureRoot,
  writeFixtureFile,
} from "./lib/build-fixtures.ts";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");
const PAGE_COUNT = 40;

const roots: string[] = [];
const children = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    }
  }
  children.clear();
  await Promise.all(roots.splice(0).map(cleanupFixture));
});

const page = (title: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`;

const project = async (name: string): Promise<string> => {
  const root = fixtureRoot(`stdout-closed-${name}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  await writeFixtureFile(root, "package.json", '{"type":"module"}');
  await writeFixtureFile(
    root,
    "bascik.config.js",
    "export default { generate: { sitemap: false, robots: false } };",
  );
  await writeFixtureFile(root, "src/pages/index.html", page("Home"));
  for (let index = 1; index < PAGE_COUNT; index++)
    await writeFixtureFile(
      root,
      `src/pages/page-${index}.html`,
      page(`Page ${index}`),
    );
  return root;
};

interface Running {
  child: ChildProcess;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Start the CLI; `closeStdout` closes the read end of its stdout at once. */
const start = (root: string, args: string[], closeStdout: boolean): Running => {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  if (closeStdout) child.stdout!.destroy();
  else child.stdout!.resume();
  let stderr = "";
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((done) => child.once("exit", (code, signal) => done({ code, signal })));
  return { child, stderr: () => stderr, exited };
};

const within = async <T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | "timeout"> =>
  Promise.race([
    promise,
    new Promise<"timeout">((done) => setTimeout(() => done("timeout"), ms)),
  ]);

/** GET until the server answers or `timeoutMs` passes; the status or null. */
const getStatus = async (
  url: string,
  timeoutMs: number,
): Promise<number | null> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      await response.arrayBuffer();
      return response.status;
    } catch {
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  return null;
};

describe("stdout closed by its reader", { timeout: 90_000 }, () => {
  it("bascik --build finishes, writes every page and exits 0", async () => {
    const root = await project("build");
    const run = start(root, ["--build"], true);
    const exit = await within(run.exited, 60_000);
    expect(run.stderr()).not.toMatch(/Fatal uncaught exception|EPIPE/);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(existsSync(join(root, "dist/index.html"))).toBe(true);
    for (let index = 1; index < PAGE_COUNT; index++)
      expect(
        existsSync(join(root, `dist/page-${index}.html`)),
        `dist/page-${index}.html`,
      ).toBe(true);
  });

  it("a failing bascik --build still exits 1 with its own error on stderr", async () => {
    const root = await project("build-fails");
    await writeFixtureFile(
      root,
      "src/pages/broken.html",
      page("Broken").replace(
        "<h1>",
        '<script data-bascik-build>export default () => { throw new Error("build script exploded"); };</script><h1>',
      ),
    );
    const run = start(root, ["--build"], true);
    const exit = await within(run.exited, 60_000);
    expect(run.stderr()).not.toMatch(/Fatal uncaught exception|EPIPE/);
    expect(run.stderr()).toContain("build script exploded");
    expect(run.stderr()).toContain("src/pages/broken.html");
    expect(exit).toEqual({ code: 1, signal: null });
  });

  it("bascik --server keeps serving and still shuts down on SIGTERM", async () => {
    const root = await project("server");
    const build = start(root, ["--build"], false);
    expect(await within(build.exited, 60_000)).toEqual({
      code: 0,
      signal: null,
    });

    const run = start(root, ["--server", "--port", "24931"], true);
    // Each request writes an access log line to the closed stdout.
    expect(await getStatus("http://localhost:24931/", 30_000)).toBe(200);
    expect(await getStatus("http://localhost:24931/page-1", 5_000)).toBe(200);
    expect(await getStatus("http://localhost:24931/missing", 5_000)).toBe(404);
    expect(await getStatus("http://localhost:24931/", 5_000)).toBe(200);
    expect(run.child.exitCode).toBeNull();
    expect(run.stderr()).not.toMatch(/Fatal uncaught exception|EPIPE/);

    run.child.kill("SIGTERM");
    expect(await within(run.exited, 20_000)).toEqual({ code: 0, signal: null });
  });

  it("bascik (dev) boots, serves, and still shuts down on SIGTERM", async () => {
    const root = await project("dev");
    const run = start(root, ["--port", "24932", "--no-pin"], true);
    expect(await getStatus("http://localhost:24932/", 45_000)).toBe(200);
    expect(await getStatus("http://localhost:24932/page-1", 5_000)).toBe(200);
    expect(run.child.exitCode).toBeNull();
    expect(run.stderr()).not.toMatch(/Fatal uncaught exception|EPIPE/);

    run.child.kill("SIGTERM");
    expect(await within(run.exited, 20_000)).toEqual({ code: 0, signal: null });
  });
});
