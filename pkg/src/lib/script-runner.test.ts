import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  MAX_INLINE_ENV_BYTES,
  MEM_PER_CHILD,
  SPILLED_ENV_FILE_VAR,
  Semaphore,
  computeMaxChildProcesses,
  runModule,
} from "./script-runner.ts";

/**
 * Prompt 103: child admission for `runModule` is a scoped resource released
 * exactly once for every exit path (success, async error, timeout, and a
 * synchronous argument-validation throw from execFile). Pre-103, the permit was
 * released only from execFile's callback, so a synchronous spawn throw (such as
 * a NUL byte in the module path) rejected the Promise WITHOUT releasing the
 * permit, leaking one slot of the bounded concurrency forever.
 *
 * The tests pass a small dedicated `max` Semaphore so a leaked permit is
 * observable deterministically: a leak of 1 would hold the single slot and hang
 * any subsequent runModule, whereas against the shared semaphore (whose
 * concurrency can exceed the concurrent call count) a one-slot leak may be
 * invisible.
 */

const { execFile: execFileMock } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));
vi.mock("./config.js", () => ({ BascikConfig: { isBuild: false } }));

describe("Semaphore", () => {
  it("honors a concurrency cap and returns to baseline after release", async () => {
    const sem = new Semaphore(2);
    expect(sem.getActiveCount()).toBe(0);
    const gate: Array<() => void> = [];
    const run = async () => {
      await sem.acquire();
      await new Promise<void>((resolve) => gate.push(resolve));
      sem.release();
    };
    // Trigger all four runs; the first two hold a permit, the last two wait.
    const tasks = [run(), run(), run(), run()];
    // Let the synchronous acquire path run for the first two before asserting.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(sem.getActiveCount()).toBe(2);
    // Free the first two; the queued waiters now hold the two slots.
    gate.splice(0, 2).forEach((resolve) => resolve());
    await tasks[0];
    await tasks[1];
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(sem.getActiveCount()).toBe(2);
    // Free the remaining two.
    gate.splice(0, 2).forEach((resolve) => resolve());
    await Promise.all(tasks);
    expect(sem.getActiveCount()).toBe(0);
  });
});

describe("Semaphore.setMax", () => {
  // A page worker learns its final share of the child budget only after the
  // build has expanded its routes (the pool starts before that and is then
  // trimmed), so the cap must change in place.
  it("admits waiters immediately when the cap is raised", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    let second = false;
    const waiter = sem.acquire().then(() => (second = true));
    await Promise.resolve();
    expect(second).toBe(false);
    sem.setMax(2);
    await waiter;
    expect(sem.getActiveCount()).toBe(2);
    expect(sem.getMax()).toBe(2);
  });

  it("lowers the cap without revoking permits already held", async () => {
    const sem = new Semaphore(3);
    await sem.acquire();
    await sem.acquire();
    sem.setMax(1);
    expect(sem.getActiveCount()).toBe(2);
    let admitted = false;
    const waiter = sem.acquire().then(() => (admitted = true));
    sem.release();
    await Promise.resolve();
    // Still at the new cap of 1 after one release.
    expect(admitted).toBe(false);
    sem.release();
    await waiter;
    expect(sem.getActiveCount()).toBe(1);
  });

  it("never drops below one permit, so a build always makes progress", () => {
    const sem = new Semaphore(4);
    sem.setMax(0);
    expect(sem.getMax()).toBe(1);
    sem.setMax(Number.NaN);
    expect(sem.getMax()).toBe(1);
  });
});

describe("runModule permit ownership", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("releases the admitted permit after a synchronous spawn throw so the next admitted call proceeds", async () => {
    const sem = new Semaphore(1);
    execFileMock.mockImplementationOnce(() => {
      throw Object.assign(
        new TypeError('The "path" argument must be of type string'),
        { code: "ERR_INVALID_ARG_VALUE" },
      );
    });
    execFileMock.mockImplementationOnce(
      (
        _cmd: unknown,
        _args: unknown,
        _opts: unknown,
        cb: (err: null, stdout: string, stderr: string) => void,
      ) => {
        cb(null, "ok", "");
      },
    );

    await expect(
      runModule("bad\0path", {}, [], 1000, 1024, sem),
    ).rejects.toThrow();
    expect(sem.getActiveCount()).toBe(0);

    // A subsequent call must be admitted (a leaked permit holding the single
    // slot would make this await hang forever).
    const second = await runModule("good/path", {}, [], 1000, 1024, sem);
    expect(second.stdout).toBe("ok");
    expect(sem.getActiveCount()).toBe(0);
  });

  it("releases the permit after an async execFile error and after a timeout kill", async () => {
    const sem = new Semaphore(1);
    execFileMock.mockImplementationOnce(
      (
        _cmd: unknown,
        _args: unknown,
        _opts: unknown,
        cb: (err: Error) => void,
      ) => {
        cb(new Error("script crashed"));
      },
    );
    await expect(runModule("path", {}, [], 1000, 1024, sem)).rejects.toThrow(
      "script crashed",
    );
    expect(sem.getActiveCount()).toBe(0);

    execFileMock.mockImplementationOnce(
      (
        _cmd: unknown,
        _args: unknown,
        _opts: unknown,
        cb: (err: Error & { killed?: boolean; signal?: string }) => void,
      ) => {
        cb(
          Object.assign(new Error("Command timed out"), {
            killed: true,
            signal: "SIGTERM",
          }),
        );
      },
    );
    await expect(runModule("path", {}, [], 1, 1024, sem)).rejects.toThrow(
      /timed out|Command/,
    );
    expect(sem.getActiveCount()).toBe(0);
  });

  it("passes a small BASCIK_ROUTE inline with no preload", async () => {
    const sem = new Semaphore(1);
    execFileMock.mockImplementationOnce(
      (
        _cmd: unknown,
        _args: unknown,
        _opts: unknown,
        cb: (err: null, stdout: string, stderr: string) => void,
      ) => {
        cb(null, "", "");
      },
    );
    await runModule(
      "script.mjs",
      { BASCIK_ROUTE: '{"params":{}}' },
      [],
      1000,
      1024,
      sem,
    );
    const [, args, opts] = execFileMock.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(args).toEqual(["script.mjs"]);
    expect(opts.env.BASCIK_ROUTE).toBe('{"params":{}}');
    expect(opts.env[SPILLED_ENV_FILE_VAR]).toBeUndefined();
  });

  it("moves an oversized BASCIK_ROUTE to a temp file read by a preload, and removes the file", async () => {
    const sem = new Semaphore(1);
    const route = JSON.stringify({
      params: { slug: "long" },
      data: { body: "é".repeat(MAX_INLINE_ENV_BYTES) },
    });
    let seenFile = "";
    let seenContent = "";
    execFileMock.mockImplementationOnce(
      (
        _cmd: unknown,
        _args: unknown,
        opts: { env: Record<string, string> },
        cb: (err: null, stdout: string, stderr: string) => void,
      ) => {
        seenFile = opts.env[SPILLED_ENV_FILE_VAR];
        seenContent = readFileSync(seenFile, "utf8");
        cb(null, "", "");
      },
    );
    await runModule(
      "script.mjs",
      { BASCIK_ROUTE: route },
      ["x"],
      1000,
      1024,
      sem,
    );
    const [, args, opts] = execFileMock.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(opts.env.BASCIK_ROUTE).toBeUndefined();
    expect(args[0]).toBe("--import");
    expect(args[1]).toMatch(/^data:text\/javascript,/);
    expect(args.slice(2)).toEqual(["script.mjs", "x"]);
    expect(JSON.parse(seenContent)).toEqual({ BASCIK_ROUTE: route });
    expect(existsSync(seenFile)).toBe(false);
    expect(sem.getActiveCount()).toBe(0);
  });

  it("removes the spilled file when the child fails", async () => {
    const sem = new Semaphore(1);
    let seenFile = "";
    execFileMock.mockImplementationOnce(
      (
        _cmd: unknown,
        _args: unknown,
        opts: { env: Record<string, string> },
        cb: (err: Error) => void,
      ) => {
        seenFile = opts.env[SPILLED_ENV_FILE_VAR];
        cb(new Error("script crashed"));
      },
    );
    const route = JSON.stringify({
      data: "x".repeat(MAX_INLINE_ENV_BYTES + 1),
    });
    await expect(
      runModule("script.mjs", { BASCIK_ROUTE: route }, [], 1000, 1024, sem),
    ).rejects.toThrow("script crashed");
    expect(seenFile).not.toBe("");
    expect(existsSync(seenFile)).toBe(false);
    expect(sem.getActiveCount()).toBe(0);
  });

  it("releases the permit exactly once on a successful run", async () => {
    const sem = new Semaphore(1);
    execFileMock.mockImplementationOnce(
      (
        _cmd: unknown,
        _args: unknown,
        _opts: unknown,
        cb: (err: null, stdout: string, stderr: string) => void,
      ) => {
        cb(null, "out", "");
      },
    );
    const result = await runModule("path", {}, [], 1000, 1024, sem);
    expect(result.stdout).toBe("out");
    expect(sem.getActiveCount()).toBe(0);
  });
});

/**
 * Child pool sizing. The old formula took `Math.max(freemem() * 0.6,
 * totalmem() * 0.25)`, so total memory acted as a floor and a 16 GB machine
 * with under 100 MB free still admitted `min(cpus, 35)` children. Available
 * memory (`process.availableMemory()`, since `os.freemem()` under-reports on
 * macOS) now bounds the pool, and a page worker thread gets only its share of
 * the system maximum instead of the whole thing.
 */
describe("computeMaxChildProcesses", () => {
  const GB = 1024 * 1024 * 1024;

  it("caps concurrency to 1 when available memory is below MEM_PER_CHILD instead of inflating to totalMem * 0.25", () => {
    const max = computeMaxChildProcesses({
      cpuCount: 10,
      availableMemBytes: 80 * 1024 * 1024,
      totalMemBytes: 17 * GB,
    });
    // Pre-fix this was min(10, floor(4.25 GB / 120 MB)) = 10.
    expect(max).toBe(1);
  });

  it("keeps a minimum of 1 even with zero available memory or zero CPUs reported", () => {
    expect(
      computeMaxChildProcesses({
        cpuCount: 0,
        availableMemBytes: 0,
        totalMemBytes: 16 * GB,
      }),
    ).toBe(1);
  });

  it("caps abundant available memory by cpuCount", () => {
    expect(
      computeMaxChildProcesses({
        cpuCount: 4,
        availableMemBytes: 64 * GB,
        totalMemBytes: 128 * GB,
      }),
    ).toBe(4);
  });

  it("caps abundant available memory by totalMem * 0.25 / MEM_PER_CHILD", () => {
    // Available memory would allow 60% * 8 GB / 120 MB = 40 children; total memory
    // allows 25% * 8 GB / 120 MB = 17, and there are enough CPUs for either.
    const max = computeMaxChildProcesses({
      cpuCount: 64,
      availableMemBytes: 8 * GB,
      totalMemBytes: 8 * GB,
    });
    expect(max).toBe(Math.floor((8 * GB * 0.25) / MEM_PER_CHILD));
    expect(max).toBe(17);
  });

  it("uses availableMem * 0.6 when it is the tighter memory bound", () => {
    // 60% * 1 GB / 120 MB = 5.12 -> 5; total memory would allow 34.
    const max = computeMaxChildProcesses({
      cpuCount: 64,
      availableMemBytes: 1 * GB,
      totalMemBytes: 16 * GB,
    });
    expect(max).toBe(5);
  });

  it("divides the system maximum across worker threads so the pool total stays within budget", () => {
    const system = {
      cpuCount: 8,
      availableMemBytes: 16 * GB,
      totalMemBytes: 32 * GB,
    };
    const systemMax = computeMaxChildProcesses(system);
    expect(systemMax).toBe(8);
    for (const workerCount of [1, 2, 3, 4, 8]) {
      const perWorker = computeMaxChildProcesses({ ...system, workerCount });
      expect(perWorker).toBe(Math.floor(systemMax / workerCount));
      expect(perWorker).toBeGreaterThanOrEqual(1);
      expect(perWorker * workerCount).toBeLessThanOrEqual(systemMax);
    }
  });

  it("floors each worker's share at 1 when there are more workers than permits", () => {
    // The helper alone would let the pool total reach workerCount here, which
    // is why processAllPages sizes the pool to at most the system maximum;
    // the floor only guarantees that a worker can always make progress.
    const system = {
      cpuCount: 8,
      availableMemBytes: 300 * 1024 * 1024,
      totalMemBytes: 32 * GB,
    };
    expect(computeMaxChildProcesses(system)).toBe(1);
    expect(computeMaxChildProcesses({ ...system, workerCount: 8 })).toBe(1);
  });

  it("treats an undefined or zero workerCount as a single worker", () => {
    const system = {
      cpuCount: 8,
      availableMemBytes: 16 * GB,
      totalMemBytes: 32 * GB,
    };
    expect(
      computeMaxChildProcesses({ ...system, workerCount: undefined }),
    ).toBe(8);
    expect(computeMaxChildProcesses({ ...system, workerCount: 0 })).toBe(8);
  });

  it("lets an explicit override replace the CPU and memory bounds in both directions, still divided across workers", () => {
    const system = {
      cpuCount: 2,
      availableMemBytes: 80 * 1024 * 1024,
      totalMemBytes: 16 * GB,
    };
    expect(computeMaxChildProcesses({ ...system, override: 6 })).toBe(6);
    expect(
      computeMaxChildProcesses({ ...system, override: 6, workerCount: 4 }),
    ).toBe(1);
    expect(
      computeMaxChildProcesses({ ...system, override: 6, workerCount: 2 }),
    ).toBe(3);
    // Tightening below what the machine would allow works too.
    const roomy = {
      cpuCount: 8,
      availableMemBytes: 16 * GB,
      totalMemBytes: 32 * GB,
    };
    expect(computeMaxChildProcesses(roomy)).toBe(8);
    expect(computeMaxChildProcesses({ ...roomy, override: 2 })).toBe(2);
    expect(
      computeMaxChildProcesses({ ...roomy, override: 2, workerCount: 2 }),
    ).toBe(1);
  });
});
