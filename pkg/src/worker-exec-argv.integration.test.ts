/**
 * `bascik --build` with page workers, started with Node flags that Node
 * refuses in a worker's explicit `execArgv` (`--max-old-space-size`,
 * `--stack-size`, `--expose-gc`, `--title`).
 *
 * The pool used to hand every worker this thread's `process.execArgv`, and
 * `new Worker` threw `ERR_WORKER_INVALID_EXEC_ARGV` for each of those flags,
 * so every page failed with "WorkerPool has no viable workers" (6 of 6
 * pages, on Node 24.21 and 26.13). These run the real CLI (`src/index.ts`)
 * as a child process, with an `--import` preload that records, from every
 * page worker, the Node flags it started with and its heap limit: the build
 * has to succeed through real workers (not a serial fallback), the flags a
 * worker can take (the preload, `--conditions`) still have to reach them,
 * and V8's heap limit still applies in them.
 *
 * The last case runs `startWorker` itself under `--input-type=module -e`
 * with refused flags, against the real Node error message it parses.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  cleanupFixture,
  createFixtureDirs,
  fixtureRoot,
  writeFixtureFile,
} from "./lib/build-fixtures.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "index.ts");
const START_WORKER = pathToFileURL(resolve(HERE, "lib/worker-exec-argv.ts"));

const PAGES = 6;

const roots: string[] = [];
const children = new Set<ChildProcess>();
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  children.clear();
  await Promise.all(roots.splice(0).map(cleanupFixture));
});

type Run = { code: number | null; stdout: string; stderr: string };

const run = (args: string[], cwd: string, nodeOptions = ""): Promise<Run> => {
  const child = spawn(process.execPath, args, {
    cwd,
    env: {
      ...process.env,
      NO_COLOR: "1",
      VITEST: "",
      NODE_OPTIONS: nodeOptions,
      BASCIK_BUILD: "1",
      BASCIK_SERVER: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => (stdout += chunk));
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolveRun) =>
    child.once("close", (code) => {
      children.delete(child);
      resolveRun({ code, stdout, stderr });
    }),
  );
};

const makeSite = async (name: string) => {
  const root = fixtureRoot(name);
  roots.push(root);
  await createFixtureDirs(root);
  await writeFixtureFile(
    root,
    "bascik.config.js",
    `module.exports = {
  pipeline: { workers: 2 },
  generate: { sitemap: false, robots: false },
};`,
  );
  for (let i = 0; i < PAGES; i++) {
    await writeFixtureFile(
      root,
      `src/pages/${i === 0 ? "index" : `book-${i}`}.html`,
      `<!doctype html>
<html lang="en">
  <head><title>Book ${i}</title></head>
  <body><h1>Book ${i}</h1></body>
</html>
`,
    );
  }
  const log = join(root, "workers.log");
  const preload = join(root, "record-worker-flags.mjs");
  // Worker threads only: one JSON line of flags per page worker.
  await writeFixtureFile(
    root,
    "record-worker-flags.mjs",
    `import { isMainThread, threadId } from "node:worker_threads";
import { appendFileSync } from "node:fs";
import { getHeapStatistics } from "node:v8";
if (!isMainThread) {
  const heapMb = Math.round(getHeapStatistics().heap_size_limit / 2 ** 20);
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ threadId, execArgv: process.execArgv, heapMb }) + "\\n");
}
`,
  );
  return { root, log, preload };
};

const workerLines = (
  log: string,
): { threadId: number; execArgv: string[]; heapMb: number }[] =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];

describe("page workers under per-process Node flags", () => {
  const expectBuiltPages = (root: string) => {
    for (let i = 0; i < PAGES; i++) {
      const page = i === 0 ? "index" : `book-${i}`;
      expect(
        readFileSync(join(root, "dist", `${page}.html`), "utf8"),
      ).toContain(`Book ${i}`);
    }
  };

  it.each([
    [["--max-old-space-size=4096"]],
    [["--stack-size=900"]],
    [["--expose-gc"]],
    [["--title=bascik-build"]],
    // A value as a separate argument, and a value with the ", " Node joins
    // refused flags with.
    [["--title", "bascik build, books"]],
    // Repeated: the last one wins, as in the main thread.
    [
      [
        "--max-old-space-size=2048",
        "--expose-gc",
        "--max-old-space-size=4096",
        "--expose-gc",
      ],
    ],
  ])(
    "builds every page through workers when started with %j",
    async (flags) => {
      const site = await makeSite("execargv");
      const result = await run(
        [
          ...flags,
          "--import",
          site.preload,
          "--conditions",
          "bascik-test",
          CLI,
          "--build",
        ],
        site.root,
      );
      const output = result.stdout + result.stderr;
      expect(output).not.toMatch(
        /no viable workers|ERR_WORKER_INVALID_EXEC_ARGV/,
      );
      expect(result.code, output).toBe(0);
      expectBuiltPages(site.root);
      const workers = workerLines(site.log);
      expect(workers.length).toBeGreaterThan(0);
      for (const worker of workers) {
        // The flags a worker may take still reach it, whole, after a
        // refused flag and its separate value; the refused ones are not in
        // its explicit execArgv (V8 applies them process-wide anyway).
        expect(worker.execArgv).toEqual([
          "--import",
          site.preload,
          "--conditions",
          "bascik-test",
        ]);
        // V8 applies the heap limit to every isolate of the process.
        if (flags.includes("--max-old-space-size=4096")) {
          expect(worker.heapMb).toBeGreaterThanOrEqual(4096);
        }
      }
    },
    60_000,
  );

  it("builds every page through workers with per-process flags in NODE_OPTIONS", async () => {
    // The page pool hands workers an explicit `env`, which makes Node check
    // its NODE_OPTIONS; V8 and per-process flags are allowed there.
    const site = await makeSite("execargv-node-options");
    const result = await run(
      ["--import", site.preload, CLI, "--build"],
      site.root,
      "--max-old-space-size=4096 --title=bascik-build --conditions=bascik-test",
    );
    const output = result.stdout + result.stderr;
    expect(output).not.toMatch(
      /no viable workers|ERR_WORKER_INVALID_EXEC_ARGV/,
    );
    expect(result.code, output).toBe(0);
    expectBuiltPages(site.root);
    const workers = workerLines(site.log);
    expect(workers.length).toBeGreaterThan(0);
    for (const worker of workers) {
      expect(worker.execArgv).toContain(site.preload);
      expect(worker.heapMb).toBeGreaterThanOrEqual(4096);
    }
  }, 60_000);

  it("still fails a build whose page workers cannot start, naming why", async () => {
    // Unhappy path: a preload that throws in every worker. The pool must give
    // up after its startup attempts and the build must fail, not hang.
    const site = await makeSite("execargv-broken");
    await writeFixtureFile(
      site.root,
      "record-worker-flags.mjs",
      `import { isMainThread } from "node:worker_threads";
if (!isMainThread) throw new Error("preload refuses worker threads");
`,
    );
    const result = await run(
      ["--max-old-space-size=4096", "--import", site.preload, CLI, "--build"],
      site.root,
    );
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(
      /preload refuses worker threads|no viable workers/,
    );
  }, 60_000);
});

describe("startWorker against Node's own refusal", () => {
  it("drops --input-type and exactly the refused flags under node -e", async () => {
    const root = fixtureRoot("execargv-eval");
    roots.push(root);
    await createFixtureDirs(root);
    const child = join(root, "child.mjs");
    await writeFixtureFile(
      root,
      "child.mjs",
      `import { parentPort } from "node:worker_threads";
parentPort.postMessage(process.execArgv);
`,
    );
    const source = `
import { startWorker } from ${JSON.stringify(START_WORKER.href)};
const worker = startWorker(${JSON.stringify(child)}, {});
worker.once("message", (execArgv) => {
  console.log(JSON.stringify(execArgv));
  worker.terminate();
});
worker.once("error", (error) => {
  console.log("worker error " + error.message);
  process.exitCode = 1;
});
`;
    const result = await run(
      [
        "--input-type",
        "module",
        "--max-old-space-size=4096",
        "--title",
        "a, b",
        "--conditions",
        "bascik-test",
        "--expose-gc",
        "-e",
        source,
      ],
      root,
    );
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const workerArgv: string[] = JSON.parse(result.stdout.trim());
    // `-e <source>` is in this thread's execArgv too; a worker ignores it.
    expect(workerArgv.filter((arg) => arg !== "-e" && arg !== source)).toEqual([
      "--conditions",
      "bascik-test",
    ]);
  }, 30_000);
});
