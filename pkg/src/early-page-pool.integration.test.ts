/**
 * The page worker pool of a `pipeline.workers` build starts before route
 * expansion finishes, so worker startup overlaps the routes scripts instead
 * of following them, and is fitted to the job count afterwards.
 *
 * These tests run the real CLI (`src/index.ts --build`) as a child process
 * with an `--import` preload that logs, from the main thread, every page
 * worker the build creates, every task posted to one, and every worker exit.
 * The routes and build scripts in the fixture log their own timing. Nothing
 * in the build is mocked.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { cpus } from "node:os";
import { fileURLToPath } from "node:url";
import {
  cleanupFixture,
  createFixtureDirs,
  fixtureRoot,
  writeFixtureFile,
  writeWorkersConfig,
} from "./lib/build-fixtures.ts";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(cleanupFixture));
});

// Main thread only: page workers inherit the preload through execArgv but
// must not wrap anything. `syncBuiltinESMExports` makes the build's own
// `import { Worker } from "node:worker_threads"` see the wrapper.
const preloadSource = (log: string) => `
import wt from "node:worker_threads";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const log = (line) => appendFileSync(${JSON.stringify(log)}, line + " " + Date.now() + "\\n");
if (wt.isMainThread) {
  const Original = wt.Worker;
  wt.Worker = class extends Original {
    constructor(...args) {
      super(...args);
      const id = this.threadId;
      log("spawn " + id);
      const post = this.postMessage.bind(this);
      this.postMessage = (message, transfer) => {
        log((message && typeof message === "object" && "pagePath" in message ? "task " : "settings ") + id);
        return post(message, transfer);
      };
      this.on("message", (message) =>
        log((message && message.ready === true ? "ready " : "result ") + id),
      );
      this.once("exit", () => log("exit " + id));
    }
  };
  syncBuiltinESMExports();
}
`;

const routesPage = (
  log: string,
  {
    sleepMs,
    routes,
    fail,
  }: { sleepMs: number; routes: string[]; fail?: string },
) => `<!DOCTYPE html><html><head><title>Post</title>
<script data-bascik-routes>
export default async function () {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(${JSON.stringify(log)}, "routes-start " + Date.now() + "\\n");
  await new Promise((r) => setTimeout(r, ${sleepMs}));
  appendFileSync(${JSON.stringify(log)}, "routes-end " + Date.now() + "\\n");
  ${fail ? `throw new Error(${JSON.stringify(fail)});` : ""}
  return ${JSON.stringify(routes.map((slug) => ({ params: { slug } })))};
}
</script></head><body><p>post</p></body></html>`;

const slowPage = (name: string, ms: number) =>
  `<!DOCTYPE html><html><head><title>${name}</title></head><body>
<script data-bascik-build>export default async () => { await new Promise((r) => setTimeout(r, ${ms})); return "<p>${name}</p>"; }</script>
</body></html>`;

interface Fixture {
  root: string;
  log: string;
  preload: string;
}

const makeFixture = async (
  name: string,
  pages: Record<string, (log: string) => string>,
): Promise<Fixture> => {
  const root = fixtureRoot(`early-pool-${name}`);
  roots.push(root);
  await createFixtureDirs(root);
  await writeWorkersConfig(root, true);
  const log = join(root, "timeline.log");
  const preload = join(root, "trace-workers.mjs");
  await writeFixtureFile(root, "trace-workers.mjs", preloadSource(log));
  for (const [path, source] of Object.entries(pages))
    await writeFixtureFile(root, `src/pages/${path}`, source(log));
  return { root, log, preload };
};

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}

/** Start a real build in its own process group, as a terminal would. */
const startBuild = ({ root, preload }: Fixture) => {
  const child = spawn(process.execPath, ["--import", preload, CLI, "--build"], {
    cwd: root,
    detached: true,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const done = new Promise<Run>((resolveRun) =>
    child.once("close", (code, signal) => resolveRun({ code, signal, output })),
  );
  return { child, done };
};

const runBuild = async (fixture: Fixture): Promise<Run> => {
  const { child, done } = startBuild(fixture);
  const timeout = setTimeout(
    () => process.kill(-child.pid!, "SIGKILL"),
    30_000,
  );
  try {
    return await done;
  } finally {
    clearTimeout(timeout);
  }
};

type Event = { kind: string; id: string; at: number };

const readTimeline = (log: string): Event[] =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const parts = line.split(" ");
          return parts.length === 3
            ? { kind: parts[0], id: parts[1], at: Number(parts[2]) }
            : { kind: parts[0], id: "", at: Number(parts[1]) };
        })
    : [];

const of = (events: Event[], kind: string) =>
  events.filter((event) => event.kind === kind);

const waitFor = async (check: () => boolean, ms: number) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
};

const groupAlive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    // EPERM on macOS: members have exited but are not yet reaped.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

// The real page worker's module graph has top-level awaits. Terminating a
// worker while that graph is still evaluating can abort the whole process on
// Node 24 ("Check failed: (location_) != nullptr"), and an early-started pool
// is trimmed, or torn down after a failure, while its workers may still be
// loading. This drives the real `page-worker.ts` through `WorkerPool` in a
// child process (so an abort is observed, not suffered) and stops workers
// at every point of their startup. Without the pool waiting for each
// worker's ready signal the abort is intermittent (about half of the runs of
// this loop on an 8-core M1), so a pass here is the regression check, not a
// single failing run. A TypeScript config matters: importing it is part of
// what the worker still awaits while it loads.
// The pool is configured as `processAllPages` configures it: it also asks
// each worker to end itself (`stopSignal`). This loop also aborted on CI's
// Linux x64 runners, Node 24.21 and 24.22, with "Check failed:
// jit_page.has_value()" (SIGTRAP): V8 13.6 freeing a shared wasm import
// wrapper twice (`Runtime_TierUpWasmToJSWrapper` -> `WasmImportWrapperCache::Free`)
// while workers that type-strip `.ts` with Amaro tear down, whichever way
// they stop. The pool turns off wasm code GC for that (`wasm-code-gc.ts`);
// the next test checks it deterministically, since this loop hit it in only
// a few percent of CI runs.
const stopDuringStartupScript = (poolModule: string, workerScript: string) => `
import { WorkerPool } from ${JSON.stringify(poolModule)};
for (let delay = 0; delay <= 400; delay += 10) {
  const pool = new WorkerPool(${JSON.stringify(workerScript)}, 8, {}, { readySignal: true, stopSignal: true });
  await new Promise((r) => setTimeout(r, delay));
  void pool.shrink(1);
  await new Promise((r) => setTimeout(r, delay / 2));
  await pool.terminate();
}
console.log("survived");
`;

describe("page worker shutdown during startup (real worker)", () => {
  it("never aborts the process when workers are trimmed or terminated while still loading", async () => {
    const fixture = await makeFixture("startup-stop", {});
    const lib = resolve(dirname(fileURLToPath(import.meta.url)), "lib");
    await rm(join(fixture.root, "bascik.config.js"));
    await writeFixtureFile(
      fixture.root,
      "bascik.config.ts",
      `export default { pipeline: { workers: true } };\n`,
    );
    await writeFixtureFile(
      fixture.root,
      "stop-during-startup.mjs",
      stopDuringStartupScript(
        join(lib, "worker-pool.ts"),
        join(lib, "page-worker.ts"),
      ),
    );
    const child = spawn(
      process.execPath,
      [join(fixture.root, "stop-during-startup.mjs")],
      { cwd: fixture.root, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const [code, signal] = await new Promise<[number | null, string | null]>(
      (resolveRun) =>
        child.once("close", (exitCode, exitSignal) =>
          resolveRun([exitCode, exitSignal]),
        ),
    );
    expect({ code, signal }, output).toEqual({ code: 0, signal: null });
    expect(output).toContain("survived");
    expect(output).not.toContain("Fatal error");
    // 41 rounds of eight workers that each load the compiler from source:
    // 29 s on the CI runner, but 66 to 130 s on an 8-core Mac under heavy
    // load, and up to 225 s with six copies running at once. The sweep of
    // delays is the regression check, so the budget grows instead.
  }, 300_000);
});

// A worker that type-strips TypeScript (Amaro, swc compiled to wasm) for each
// task, as a page worker does for a `.ts` config, helper or script block.
const stripWorkerSource = `
import { parentPort } from "node:worker_threads";
import { stripTypeScriptTypes } from "node:module";
parentPort.on("message", (count) => {
  for (let i = 0; i < count; i++)
    stripTypeScriptTypes("const n: number = " + i + "; export type T = string;");
  parentPort.postMessage({ ok: true, result: count });
});
`;

// Workers come and go while others strip types, and V8 is told to run a wasm
// code GC whenever any wasm code dies (`--stress-wasm-code-gc`): without the
// pool's flag the worker isolates take part in many of them (each one a chance
// of the double free on Node 24); with it, in none on V8 13.
const wasmCodeGcScript = (poolModule: string, workerScript: string) => `
import { setFlagsFromString } from "node:v8";
import { stripTypeScriptTypes } from "node:module";
// Set here, not on the command line: a worker thread rejects V8 flags in the
// execArgv it inherits. Both are read each time wasm code dies.
setFlagsFromString("--stress-wasm-code-gc");
setFlagsFromString("--trace-wasm-code-gc");
const { WorkerPool } = await import(${JSON.stringify(poolModule)});
for (let round = 0; round < 6; round++) {
  const pool = new WorkerPool(${JSON.stringify(workerScript)}, 3, {});
  stripTypeScriptTypes("const main: number = " + round + ";");
  await Promise.all([pool.run(2000), pool.run(2000), pool.run(2000)]);
  void pool.shrink(1);
  await pool.run(2000);
  await pool.terminate();
}
console.log("survived");
`;

// Only V8 13 (Node 24) has the race, and only there does the pool change the
// flag. Do not run this loop, or any loop of several threads stripping types
// at once, on V8 14: Node 26.13 on macOS arm64 crashes in it with SIGILL in
// wasm code entered from `Builtins_JSToWasmWrapperAsm`, on a valid
// instruction at the start of freshly compiled code (nodejs/node#67467). No
// stress flag is needed: four workers that each strip types 12,000 times
// crashed in 9 of 400 runs, with or without wasm code GC, and in none of 400
// with V8's wasm-to-JS wrapper tier-up held off
// (`--wasm-wrapper-tiering-budget=1000000000`) or on Node 24.21. No real use
// of Bascik on Node 26 hit it (0 of 860 `bascik --build` runs of 30 to 300
// TypeScript pages, 0 of 200 dev servers stopped with Ctrl+C while starting,
// 0 of 40 runs of the startup loop above), but a large TypeScript-heavy site
// is in range, so `wasm-code-gc.ts` sets that budget on V8 14 on arm64
// (`WorkerPool`'s own pools: 6 of 608 crashes without it, 0 of 608 with it).
// CI has no arm64 runner; the unit tests in `wasm-code-gc.test.ts` cover it.
describe.runIf(Number.parseInt(process.versions.v8, 10) === 13)(
  "wasm code GC while worker threads stop (real workers, Node 24)",
  () => {
    it("is off for the whole process once a pool starts", async () => {
      const fixture = await makeFixture("wasm-code-gc", {});
      const lib = resolve(dirname(fileURLToPath(import.meta.url)), "lib");
      const workerScript = join(fixture.root, "strip-worker.mjs");
      await writeFixtureFile(
        fixture.root,
        "strip-worker.mjs",
        stripWorkerSource,
      );
      await writeFixtureFile(
        fixture.root,
        "wasm-code-gc.mjs",
        wasmCodeGcScript(join(lib, "worker-pool.ts"), workerScript),
      );
      const child = spawn(
        process.execPath,
        ["--no-warnings", join(fixture.root, "wasm-code-gc.mjs")],
        { cwd: fixture.root, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      const [code, signal] = await new Promise<[number | null, string | null]>(
        (resolveRun) =>
          child.once("close", (exitCode, exitSignal) =>
            resolveRun([exitCode, exitSignal]),
          ),
      );
      const tail = output.split("\n").slice(-40).join("\n");
      expect({ code, signal }, tail).toEqual({ code: 0, signal: null });
      expect(output).toContain("survived");
      // Loading `worker-pool.ts` strips its types on the main thread before
      // any pool exists, so a GC there is expected; a worker isolate taking
      // part in one means wasm code GC was still on while workers ran.
      const codeGcs =
        output.match(/\[wasm-gc\] Isolate [1-9]\d* reporting/g)?.length ?? 0;
      expect(codeGcs, tail).toBe(0);
    }, 120_000);
  },
);

describe("early page worker pool (real build)", () => {
  it("starts page workers while a routes script is still running", async () => {
    const fixture = await makeFixture("overlap", {
      "index.html": () => slowPage("home", 0),
      "about.html": () => slowPage("about", 0),
      "blog/[slug].html": (log) =>
        routesPage(log, { sleepMs: 1500, routes: ["one", "two"] }),
    });
    const run = await runBuild(fixture);
    expect(run.code, run.output).toBe(0);
    const events = readTimeline(fixture.log);
    const [routesEnd] = of(events, "routes-end");
    const spawns = of(events, "spawn");
    expect(spawns.length).toBeGreaterThan(0);
    // One worker per page existed before expansion finished, not after it;
    // only the one for the job the dynamic route added beyond its page
    // started later.
    expect(spawns.filter((s) => s.at < routesEnd.at)).toHaveLength(
      Math.min(3, cpus().length),
    );
    expect(spawns).toHaveLength(Math.min(4, cpus().length));
    expect(of(events, "task")[0].at).toBeGreaterThanOrEqual(routesEnd.at);
    for (const page of [
      "index.html",
      "about.html",
      "blog/one.html",
      "blog/two.html",
    ])
      expect(existsSync(join(fixture.root, "dist", page)), page).toBe(true);
    // Every worker the build started had stopped before the process exited.
    expect(of(events, "exit")).toHaveLength(spawns.length);
  }, 40_000);

  it("starts one worker per page for a small dynamic site and grows to its jobs, never spawning an unused worker", async () => {
    // A dynamic route can expand to any number of jobs. Starting a worker
    // per CPU for it would load the compiler in threads a two-page site never
    // uses, and those cannot be stopped until they have loaded.
    const fixture = await makeFixture("grow", {
      "blog/[slug].html": (log) =>
        routesPage(log, { sleepMs: 300, routes: ["one", "two"] }),
    });
    const run = await runBuild(fixture);
    expect(run.code, run.output).toBe(0);
    const events = readTimeline(fixture.log);
    const [routesEnd] = of(events, "routes-end");
    const spawns = of(events, "spawn");
    // One page, so one worker while expansion runs...
    expect(spawns.filter((s) => s.at < routesEnd.at)).toHaveLength(1);
    // ...and one more for the second job, each of which ran a page.
    expect(spawns).toHaveLength(2);
    const busy = new Set(of(events, "task").map((event) => event.id));
    expect(busy.size).toBe(2);
    expect(of(events, "exit")).toHaveLength(spawns.length);
    for (const page of ["blog/one.html", "blog/two.html"])
      expect(existsSync(join(fixture.root, "dist", page)), page).toBe(true);
  }, 40_000);

  it("stops the worker of a page whose routes script found no routes, after it loads and before the pages compile", async () => {
    const fixture = await makeFixture("trim", {
      "index.html": () => slowPage("home", 800),
      "about.html": () => slowPage("about", 800),
      "blog/[slug].html": (log) =>
        routesPage(log, { sleepMs: 300, routes: [] }),
    });
    const run = await runBuild(fixture);
    expect(run.code, run.output).toBe(0);
    const events = readTimeline(fixture.log);
    const spawns = of(events, "spawn");
    const busy = new Set(of(events, "task").map((event) => event.id));
    expect(busy.size).toBe(Math.min(2, spawns.length));
    const firstResult = of(events, "result")[0].at;
    const idle = spawns.filter((spawned) => !busy.has(spawned.id));
    expect(idle.length).toBe(spawns.length - busy.size);
    for (const worker of idle) {
      const find = (kind: string) =>
        events.find((e) => e.kind === kind && e.id === worker.id);
      const exit = find("exit");
      // Gone before the first page finished (each takes 800 ms), not kept
      // alive for the rest of the phase...
      expect(exit, `worker ${worker.id}`).toBeDefined();
      expect(exit!.at).toBeLessThanOrEqual(firstResult);
      // ...but only once it had finished loading: stopping a worker that is
      // still evaluating its modules can abort the process.
      expect(find("ready"), `worker ${worker.id} ready`).toBeDefined();
      expect(exit!.at).toBeGreaterThanOrEqual(find("ready")!.at);
    }
    expect(of(events, "exit")).toHaveLength(spawns.length);
  }, 40_000);

  it("waits for a worker whose config loads for longer than the ready grace instead of terminating it mid-evaluation", async () => {
    // Every page worker loads the user's config through Bascik's own
    // top-level await (`userConfig.ts`). A config that works past
    // READY_GRACE_MS (10 s) at load time keeps the worker evaluating a module
    // whose dependency had a top-level await, and a terminate() or a process
    // exit then aborts Node 24 ("Check failed: (location_) != nullptr") and
    // Node 26 ("Check failed: !is_null()") every time. The routes script
    // finds no routes, so the early pool is trimmed while all its workers are
    // still loading. The work is in workers only, to keep the test short.
    const fixture = await makeFixture("slow-config", {
      "index.html": () => slowPage("home", 0),
      "about.html": () => slowPage("about", 0),
      "blog/[slug].html": (log) =>
        routesPage(log, { sleepMs: 300, routes: [] }),
    });
    await rm(join(fixture.root, "bascik.config.js"));
    await writeFixtureFile(
      fixture.root,
      "src/lib/books-data.ts",
      `import { readFile } from "node:fs/promises";\nexport const raw: string = await readFile(new URL(import.meta.url), "utf8");\n`,
    );
    await writeFixtureFile(
      fixture.root,
      "bascik.config.ts",
      `import { isMainThread } from "node:worker_threads";
import { raw } from "./src/lib/books-data.ts";
let n: number = 0;
if (!isMainThread) {
  const end = Date.now() + 11_500;
  while (Date.now() < end) n += raw.length;
}
export default {
  directory: { components: ["src/components"] },
  pipeline: { workers: true },
  generate: { manifest: true, cspHashes: true, sitemap: false, robots: false },
  minify: { identifiers: false },
};
`,
    );
    const run = await runBuild(fixture);
    expect(run.output).not.toContain("Check failed");
    expect({ code: run.code, signal: run.signal }, run.output).toEqual({
      code: 0,
      signal: null,
    });
    expect(run.output).toContain("A page worker is still loading after 10 s");
    const events = readTimeline(fixture.log);
    const spawns = of(events, "spawn");
    expect(spawns.length).toBeGreaterThan(0);
    expect(of(events, "exit")).toHaveLength(spawns.length);
    for (const worker of spawns) {
      const find = (kind: string) =>
        events.find((e) => e.kind === kind && e.id === worker.id);
      expect(find("ready"), `worker ${worker.id} ready`).toBeDefined();
      expect(find("exit")!.at).toBeGreaterThanOrEqual(find("ready")!.at);
    }
    for (const page of ["index.html", "about.html"])
      expect(existsSync(join(fixture.root, "dist", page)), page).toBe(true);
  }, 60_000);

  it("stops every worker, after it loads, before exiting on a static asset copy failure", async () => {
    // The asset copy runs next to page processing and the CLI exits as soon
    // as it fails; exiting while a worker is still loading can abort Node 24.
    const fixture = await makeFixture("copy-fail", {
      "index.html": () => slowPage("home", 0),
      "blog/[slug].html": (log) =>
        routesPage(log, { sleepMs: 600, routes: ["one"] }),
    });
    const locked = join(fixture.root, "src/pages/assets/locked.txt");
    await writeFixtureFile(fixture.root, "src/pages/assets/locked.txt", "x");
    chmodSync(locked, 0o000);
    try {
      const run = await runBuild(fixture);
      expect(run.code).not.toBe(0);
      expect(run.signal).toBeNull();
      expect(run.output).toContain("locked.txt");
      expect(run.output).not.toContain("Check failed");
      const events = readTimeline(fixture.log);
      const spawns = of(events, "spawn");
      expect(spawns.length).toBeGreaterThan(0);
      // An exit event is only logged for a worker stopped before the process
      // exited; one still running at process.exit never logs it.
      expect(of(events, "exit")).toHaveLength(spawns.length);
      for (const worker of spawns) {
        const find = (kind: string) =>
          events.find((e) => e.kind === kind && e.id === worker.id);
        expect(find("ready"), `worker ${worker.id} ready`).toBeDefined();
        expect(find("exit")!.at).toBeGreaterThanOrEqual(find("ready")!.at);
      }
    } finally {
      chmodSync(locked, 0o644);
    }
  }, 40_000);

  it("starts one worker for a single-page site", async () => {
    const fixture = await makeFixture("single", {
      "index.html": () => slowPage("home", 0),
    });
    const run = await runBuild(fixture);
    expect(run.code, run.output).toBe(0);
    const events = readTimeline(fixture.log);
    expect(of(events, "spawn")).toHaveLength(1);
    expect(of(events, "exit")).toHaveLength(1);
  }, 40_000);

  it("starts no worker for a site with zero pages", async () => {
    const fixture = await makeFixture("empty", {});
    const run = await runBuild(fixture);
    expect(run.code, run.output).toBe(0);
    expect(of(readTimeline(fixture.log), "spawn")).toHaveLength(0);
  }, 40_000);

  it("fails with the page and its error when expansion fails, and stops every worker", async () => {
    const fixture = await makeFixture("expand-fail", {
      "index.html": () => slowPage("home", 0),
      "blog/[slug].html": (log) =>
        routesPage(log, { sleepMs: 300, routes: [], fail: "routes exploded" }),
    });
    const run = await runBuild(fixture);
    expect(run.code).not.toBe(0);
    expect(run.output).toContain("blog/[slug].html");
    expect(run.output).toContain("routes exploded");
    const events = readTimeline(fixture.log);
    expect(of(events, "spawn").length).toBeGreaterThan(0);
    expect(of(events, "exit")).toHaveLength(of(events, "spawn").length);
  }, 40_000);

  it("exits promptly on Ctrl-C while the workers are warming up and leaves no process behind", async () => {
    const fixture = await makeFixture("sigint", {
      "index.html": () => slowPage("home", 0),
      "blog/[slug].html": (log) =>
        routesPage(log, { sleepMs: 20_000, routes: ["one"] }),
    });
    const { child, done } = startBuild(fixture);
    const pid = child.pid!;
    try {
      await waitFor(() => {
        const events = readTimeline(fixture.log);
        return (
          of(events, "spawn").length > 0 &&
          of(events, "routes-start").length > 0
        );
      }, 20_000);
      // A terminal delivers Ctrl-C to the whole foreground process group.
      process.kill(-pid, "SIGINT");
      const outcome = await Promise.race([
        done,
        new Promise<"hung">((r) => setTimeout(() => r("hung"), 5_000)),
      ]);
      expect(outcome).not.toBe("hung");
      const run = outcome as Run;
      expect(run.signal === "SIGINT" || run.code === 130, run.output).toBe(
        true,
      );
      await waitFor(() => !groupAlive(pid), 2_000);
      expect(of(readTimeline(fixture.log), "routes-end")).toHaveLength(0);
    } finally {
      if (groupAlive(pid)) process.kill(-pid, "SIGKILL");
    }
  }, 40_000);
});
