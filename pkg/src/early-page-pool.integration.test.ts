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
const stopDuringStartupScript = (poolModule: string, workerScript: string) => `
import { WorkerPool } from ${JSON.stringify(poolModule)};
for (let delay = 0; delay <= 400; delay += 10) {
  const pool = new WorkerPool(${JSON.stringify(workerScript)}, 8, {}, { readySignal: true });
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
  }, 120_000);
});

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
