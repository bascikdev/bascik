import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerPool } from "./worker-pool.ts";

/**
 * Real-worker lifecycle tests (actual worker_threads, isolated temp dirs).
 * These live in a separate file from worker-pool.test.ts because that file
 * mocks node:worker_threads for deterministic EventEmitter-style control; a
 * real boundary needs the real module. Each fixture is an .mjs script written
 * to a disposable temp root, so no package fixture is mutated on disk.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixture(name: string, source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `bascik-wpool-${name}-`));
  tempDirs.push(dir);
  const file = join(dir, "worker.mjs");
  await writeFile(file, source);
  return file;
}

// Exits cleanly with code 0 when asked; echoes every other task.
const EXIT_ON_SIGNAL = `
import { parentPort } from "node:worker_threads";
parentPort.on("message", (task) => {
  if (task && task.kind === "exit0") {
    process.exit(0);
    return;
  }
  parentPort.postMessage({ ok: true, result: task });
});
`;

// Auto-exits 0 after a long quiescence (no message). Any message cancels the
// timer and echoes, so a replacement can still serve late work before its own
// timer fires.
const IDLE_EXIT = `
import { parentPort } from "node:worker_threads";
let idle = setTimeout(() => process.exit(0), 700);
parentPort.on("message", (task) => {
  clearTimeout(idle);
  parentPort.postMessage({ ok: true, result: task });
});
`;

// Throws uncaught on the first message (parent sees an "error" event) and the
// worker then exits, exercising the error-followed-by-exit race.
const ERROR_THEN_EXIT = `
import { parentPort } from "node:worker_threads";
parentPort.on("message", () => {
  throw new Error("boom-then-exit");
});
`;

// Throws at module top level: the worker thread can never start, so repeated
// respawn is pointless.
const BROKEN_TOP = `
throw new Error("broken module");
`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("WorkerPool real-worker lifecycle settlement", () => {
  it(
    "rejects a clean exit(0) active task and dispatches the queued task to a replacement",
    async () => {
      const script = await fixture("exit0", EXIT_ON_SIGNAL);
      const pool = new WorkerPool<unknown, unknown>(script, 1, {});
      try {
        const active = pool.run({ kind: "exit0" });
        await expect(active).rejects.toThrow("Worker exited with code 0");
        // The replacement worker must pick up the second task from the queue.
        const queued = pool.run("queued-ok");
        await expect(queued).resolves.toEqual("queued-ok");
      } finally {
        await pool.terminate();
      }
    },
    10_000,
  );

  it(
    "settles late queued work after an idle clean exit(0) and restores capacity",
    async () => {
      const script = await fixture("idle", IDLE_EXIT);
      const pool = new WorkerPool<unknown, unknown>(script, 1, {});
      try {
        // Wait past the idle auto-exit window so the first worker dissolves
        // while idle and a replacement is spawned.
        await sleep(1200);
        const late = pool.run("after-idle");
        await expect(late).resolves.toEqual("after-idle");
      } finally {
        await pool.terminate();
      }
    },
    15_000,
  );

  it(
    "settles the active task exactly once when a worker errors then exits",
    async () => {
      const script = await fixture("err", ERROR_THEN_EXIT);
      const pool = new WorkerPool<unknown, unknown>(script, 1, {});
      try {
        const active = pool.run("task-a");
        await expect(active).rejects.toThrow("boom-then-exit");
      } finally {
        await pool.terminate();
      }
    },
    10_000,
  );

  it(
    "bounded startup failure: a broken module rejects queued callers instead of respawning forever",
    async () => {
      const script = await fixture("broken", BROKEN_TOP);
      const pool = new WorkerPool<unknown, unknown>(script, 1, {});
      try {
        // Let the bounded respawn exhaust every attempt so no livable capacity
        // remains, then confirm callers settle promptly with a useful error.
        await sleep(500);
        const first = pool.run("never-1");
        await expect(first).rejects.toThrow(/no viable worker/);
        const second = pool.run("never-2");
        await expect(second).rejects.toThrow(/no viable worker/);
      } finally {
        await pool.terminate();
      }
    },
    15_000,
  );

  it(
    "explicit shutdown terminates even with a worker that would otherwise auto-exit",
    async () => {
      const script = await fixture("idle", IDLE_EXIT);
      const pool = new WorkerPool<unknown, unknown>(script, 1, {});
      await pool.terminate();
      // terminate() resolved without leaving a hanging task.
      expect(true).toBe(true);
    },
    10_000,
  );
});