/**
 * Every way the CLI exits while page workers are still loading stops the
 * page worker pool first.
 *
 * Node 24 can abort the whole process ("Check failed: (location_) !=
 * nullptr", exit 133) when it exits while a worker is still evaluating its
 * module graph, and the early page pool starts workers soon after boot, so a
 * crash in user code or a Ctrl-C during that window used to land in it. The
 * pool waits for each worker to load before stopping it (`readySignal` in
 * `WorkerPool`); these tests check that the crash net, the dev server's
 * SIGINT / SIGTERM handling and the CLI's own exits go through that, that a
 * worker which never loads cannot hang an exit, and that a second Ctrl-C
 * exits at once.
 *
 * They run the real CLI (`src/index.ts`) as a child process with an
 * `--import` preload that, on the main thread only, logs page worker spawns
 * and ready signals and fires the trigger under test: an uncaught exception
 * or unhandled rejection (standing in for a user script that crashes), or a
 * signal. Firing it right after the first worker reports ready lands it while
 * the others are still in the last part of loading, which is where the abort
 * happened (about a third of the runs before the fix, on an 8-core M1), so
 * each case repeats and a pass is the regression check.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupFixture,
  createFixtureDirs,
  fixtureRoot,
  writeFixtureFile,
} from "./lib/build-fixtures.ts";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");

const roots: string[] = [];
const children = new Set<ChildProcess>();
afterEach(async () => {
  // A child a failed assertion never reached `finally` for is still killed,
  // so no dev server is left listening.
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

const CRASH_MESSAGE = "user build script exploded";
const REJECT_MESSAGE = "user build script rejected";
const SECOND_CRASH_MESSAGE = "user build script exploded again";

type Trigger =
  "throw" | "throw-twice" | "reject" | "SIGINT" | "SIGTERM" | "none";

// Main thread only: page workers inherit the preload through execArgv but
// must not wrap anything. `syncBuiltinESMExports` makes the CLI's own
// `import { Worker } from "node:worker_threads"` see the wrapper.
const preloadSource = (log: string) => `
import wt from "node:worker_threads";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const log = (line) => appendFileSync(${JSON.stringify(log)}, line + " " + Date.now() + "\\n");
if (wt.isMainThread) {
  const trigger = process.env.TEST_EXIT_TRIGGER;
  const at = process.env.TEST_EXIT_TRIGGER_AT;
  const delay = Number(process.env.TEST_EXIT_TRIGGER_DELAY ?? 0);
  let fired = false;
  const fire = () => {
    if (fired || trigger === "none") return;
    fired = true;
    const act = () => {
      log("trigger");
      if (trigger === "throw-twice")
        setTimeout(() => {
          log("trigger2");
          throw new Error(${JSON.stringify(SECOND_CRASH_MESSAGE)});
        }, 300);
      if (trigger === "throw" || trigger === "throw-twice")
        throw new Error(${JSON.stringify(CRASH_MESSAGE)});
      if (trigger === "reject") {
        Promise.reject(new Error(${JSON.stringify(REJECT_MESSAGE)}));
        return;
      }
      process.kill(process.pid, trigger);
    };
    // Never inside this listener: it runs before the pool's own, so a throw
    // here would hide the ready signal from the pool. A microtask still runs
    // before any other event.
    if (delay === 0) queueMicrotask(act);
    else setTimeout(act, delay);
  };
  const Original = wt.Worker;
  wt.Worker = class extends Original {
    constructor(...args) {
      super(...args);
      log("spawn " + this.threadId);
      if (at === "spawn") fire();
      this.on("message", (message) => {
        if (!message || message.ready !== true) return;
        log("ready " + this.threadId);
        if (at === "ready") fire();
      });
    }
  };
  syncBuiltinESMExports();
}
`;

const page = (name: string) =>
  `<!DOCTYPE html><html><head><title>${name}</title></head><body><p>${name}</p></body></html>`;

// A TypeScript config: importing it is part of what a page worker still
// awaits while it loads, which keeps the loading window realistic. With
// `stuckWorkers`, a page worker never finishes loading (the config awaits
// for a minute there), to check that no exit waits for it forever.
const configSource = (port: number, stuckWorkers: boolean) => `
${stuckWorkers ? `import { isMainThread } from "node:worker_threads";\nif (!isMainThread) await new Promise((r) => setTimeout(r, 60_000));\n` : ""}
export default {
  directory: { components: ["src/components"] },
  pipeline: { workers: true },
  generate: { manifest: false, sitemap: false, robots: false },
  http: { port: ${port} },
};
`;

let portCounter = 19400 + (process.pid % 200);

interface Fixture {
  root: string;
  log: string;
  preload: string;
  port: number;
}

const makeFixture = async (
  name: string,
  options: { stuckWorkers?: boolean } = {},
): Promise<Fixture> => {
  const root = fixtureRoot(`pool-exit-${name}`);
  roots.push(root);
  await createFixtureDirs(root);
  const port = portCounter++;
  await writeFixtureFile(
    root,
    "bascik.config.ts",
    configSource(port, options.stuckWorkers ?? false),
  );
  // Enough pages for one worker per core, so most are still loading when
  // the first one reports ready.
  for (let i = 0; i < Math.max(2, Math.min(8, cpus().length)); i++)
    await writeFixtureFile(root, `src/pages/p${i}.html`, page(`p${i}`));
  const log = join(root, "timeline.log");
  const preload = join(root, "trigger.mjs");
  await writeFixtureFile(root, "trigger.mjs", preloadSource(log));
  return { root, log, preload, port };
};

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  ms: number;
}

const start = (
  fixture: Fixture,
  mode: "build" | "dev",
  trigger: { kind: Trigger; at: "ready" | "spawn"; delay: number },
) => {
  const started = Date.now();
  const child = spawn(
    process.execPath,
    [
      "--import",
      fixture.preload,
      CLI,
      ...(mode === "build" ? ["--build"] : []),
    ],
    {
      cwd: fixture.root,
      // Its own process group, as a terminal would run it, so cleanup can
      // kill everything it started.
      detached: true,
      env: {
        ...process.env,
        NO_COLOR: "1",
        VITEST: "",
        BASCIK_BUILD: mode === "build" ? "1" : "0",
        BASCIK_SERVER: "0",
        TEST_EXIT_TRIGGER: trigger.kind,
        TEST_EXIT_TRIGGER_AT: trigger.at,
        TEST_EXIT_TRIGGER_DELAY: String(trigger.delay),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => (stdout += chunk));
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  const done = new Promise<Run>((resolveRun) =>
    child.once("close", (code, signal) =>
      resolveRun({ code, signal, stdout, stderr, ms: Date.now() - started }),
    ),
  );
  return { child, done };
};

const run = async (
  fixture: Fixture,
  mode: "build" | "dev",
  trigger: { kind: Trigger; at: "ready" | "spawn"; delay: number },
  timeoutMs = 30_000,
): Promise<Run> => {
  const { child, done } = start(fixture, mode, trigger);
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {}
  }, timeoutMs);
  try {
    return await done;
  } finally {
    clearTimeout(timer);
  }
};

const readLog = (log: string): string[] =>
  existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];

const count = (lines: string[], kind: string) =>
  lines.filter((line) => line.startsWith(kind + " ")).length;

const waitFor = async (check: () => boolean, ms: number) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
};

const describeRun = (label: string, result: Run) =>
  `${label}: code=${result.code} signal=${result.signal}\n--- stderr\n${result.stderr}\n--- stdout\n${result.stdout}`;

/** No V8 / Node fatal error text in either stream. */
const expectNoAbort = (label: string, result: Run) => {
  const all = result.stdout + result.stderr;
  expect(all, describeRun(label, result)).not.toContain("Check failed");
  expect(all, describeRun(label, result)).not.toContain("Fatal error in");
  expect(result.signal, describeRun(label, result)).toBeNull();
};

/**
 * Stopping the pools for an exit must not make the abandoned phase report
 * its pages as failed: the user's crash (or their Ctrl-C) is the only story,
 * not a block of "WorkerPool terminated" page errors after it, and nothing
 * claims success or progress once the process is on its way out.
 */
const expectNoStopNoise = (label: string, result: Run) => {
  const why = describeRun(label, result);
  expect(result.stderr, why).not.toContain("WorkerPool terminated");
  expect(result.stderr, why).not.toMatch(/page errors?\b/);
  expect(result.stderr, why).not.toContain("Build pipeline failed");
  expect(result.stdout, why).not.toMatch(/pages? transpiled/);
  expect(result.stdout, why).not.toContain("Build complete");
};

// Fire at the first ready signal, and a few milliseconds after it, so the
// exit lands at different points of the remaining workers' loading.
const DELAYS = [0, 1, 2, 3, 5, 8];
const ROUNDS = 2;

describe("exiting while page workers load (real CLI)", () => {
  for (const mode of ["build", "dev"] as const) {
    for (const kind of ["throw", "reject"] as const) {
      it(`${mode}: an ${kind === "throw" ? "uncaught exception" : "unhandled rejection"} during worker warm-up exits 1 with the user's message, never a V8 abort`, async () => {
        const fixture = await makeFixture(`${mode}-${kind}`);
        const message = kind === "throw" ? CRASH_MESSAGE : REJECT_MESSAGE;
        const banner =
          kind === "throw"
            ? "[bascik] Fatal uncaught exception:"
            : "[bascik] Fatal unhandled promise rejection:";
        for (let round = 0; round < ROUNDS; round++) {
          for (const delay of DELAYS) {
            const label = `${mode} ${kind} round ${round} delay ${delay}`;
            const result = await run(fixture, mode, {
              kind,
              at: "ready",
              delay,
            });
            expectNoAbort(label, result);
            expectNoStopNoise(label, result);
            expect(result.code, describeRun(label, result)).toBe(1);
            expect(result.stderr, describeRun(label, result)).toContain(banner);
            expect(result.stderr, describeRun(label, result)).toContain(
              message,
            );
            // The crash is reported once, not again by a later exit path.
            expect(result.stderr.split(banner).length - 1, label).toBe(1);
          }
        }
      }, 240_000);
    }
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it(`dev: ${signal} during worker warm-up shuts down cleanly with exit 0, never a V8 abort`, async () => {
      const fixture = await makeFixture(`dev-${signal}`);
      for (let round = 0; round < ROUNDS; round++) {
        for (const delay of DELAYS) {
          const label = `dev ${signal} round ${round} delay ${delay}`;
          const result = await run(fixture, "dev", {
            kind: signal,
            at: "ready",
            delay,
          });
          expectNoAbort(label, result);
          expectNoStopNoise(label, result);
          expect(result.code, describeRun(label, result)).toBe(0);
          expect(result.stdout, describeRun(label, result)).toContain(
            `Received ${signal}, shutting down gracefully`,
          );
        }
      }
    }, 240_000);
  }

  it("build: a crash exits within a bounded time even when a page worker never finishes loading", async () => {
    const fixture = await makeFixture("stuck-crash", { stuckWorkers: true });
    const result = await run(
      fixture,
      "build",
      { kind: "throw", at: "spawn", delay: 300 },
      40_000,
    );
    expectNoAbort("stuck crash", result);
    expectNoStopNoise("stuck crash", result);
    expect(result.code, describeRun("stuck crash", result)).toBe(1);
    expect(result.stderr).toContain(CRASH_MESSAGE);
    // The worker would load in 60 s; the exit waits for it at most ~10 s.
    expect(result.ms, describeRun("stuck crash", result)).toBeLessThan(25_000);
  }, 60_000);

  it("dev: a single Ctrl-C exits within a bounded time even when a page worker never finishes loading", async () => {
    const fixture = await makeFixture("stuck-sigint", { stuckWorkers: true });
    const result = await run(
      fixture,
      "dev",
      { kind: "SIGINT", at: "spawn", delay: 300 },
      40_000,
    );
    // The drain timeout (5 s) forces the exit while the worker is still
    // loading: that forced exit must not abort Node either.
    expectNoAbort("stuck sigint", result);
    expectNoStopNoise("stuck sigint", result);
    expect(result.code, describeRun("stuck sigint", result)).toBe(1);
    expect(result.stdout).toContain(
      "Received SIGINT, shutting down gracefully",
    );
    expect(result.stderr).toContain("Graceful shutdown timeout: forcing exit");
    expect(result.ms, describeRun("stuck sigint", result)).toBeLessThan(25_000);
  }, 60_000);

  it("build: a second crash while the first exit waits for page workers is reported once, under its own heading, not as a second fatal crash", async () => {
    const fixture = await makeFixture("double-crash", { stuckWorkers: true });
    const result = await run(
      fixture,
      "build",
      { kind: "throw-twice", at: "spawn", delay: 300 },
      40_000,
    );
    const why = describeRun("double crash", result);
    expectNoAbort("double crash", result);
    expectNoStopNoise("double crash", result);
    expect(result.code, why).toBe(1);
    const banner = "[bascik] Fatal uncaught exception:";
    expect(result.stderr.split(banner).length - 1, why).toBe(1);
    expect(result.stderr, why).toContain(CRASH_MESSAGE);
    expect(result.stderr, why).toContain(
      "[bascik] Another error while exiting:",
    );
    expect(result.stderr, why).toContain(SECOND_CRASH_MESSAGE);
    // The first crash is the one with the fatal heading.
    expect(result.stderr.indexOf(banner), why).toBeLessThan(
      result.stderr.indexOf("[bascik] Another error while exiting:"),
    );
  }, 60_000);

  for (const [label, mode, kind] of [
    ["dev: a second Ctrl-C", "dev", "SIGINT"],
    ["build: a Ctrl-C after a crash", "build", "throw"],
  ] as const) {
    it(`${label} exits at once while the first exit is waiting for page workers to load`, async () => {
      const fixture = await makeFixture(`second-${mode}`, {
        stuckWorkers: true,
      });
      const { child, done } = start(fixture, mode, {
        kind,
        at: "spawn",
        delay: 300,
      });
      let settled: Run | undefined;
      void done.then((result) => (settled = result));
      await waitFor(() => count(readLog(fixture.log), "trigger") > 0, 20_000);
      // The first exit is waiting for the stuck worker, not exiting now
      // (which could abort Node 24 mid-load).
      await new Promise((r) => setTimeout(r, 1_500));
      expect(settled, settled && describeRun(label, settled)).toBeUndefined();
      expect(count(readLog(fixture.log), "spawn")).toBeGreaterThan(0);
      expect(count(readLog(fixture.log), "ready")).toBe(0);
      const sentAt = Date.now();
      process.kill(-child.pid!, "SIGINT");
      const outcome = await Promise.race([
        done,
        new Promise<"hung">((r) => setTimeout(() => r("hung"), 3_000)),
      ]);
      expect(outcome, label).not.toBe("hung");
      const result = outcome as Run;
      expect(Date.now() - sentAt).toBeLessThan(3_000);
      expect(
        result.signal === "SIGINT" || result.code === 130,
        describeRun(label, result),
      ).toBe(true);
    }, 60_000);
  }
});
