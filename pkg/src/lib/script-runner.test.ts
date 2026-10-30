import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  MAX_INLINE_ENV_BYTES,
  MEM_PER_CHILD,
  SPILLED_ENV_FILE_VAR,
  Semaphore,
  CHILD_SYSTEM_MAX_VAR,
  CHILD_WORKER_COUNT_VAR,
  MAX_CHILD_PROCESSES_VAR,
  availableMemoryBytes,
  computeMaxChildProcesses,
  needsVmStat,
  parseVmStat,
  resolveChildBudget,
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
 * memory (`availableMemoryBytes()`: `process.availableMemory()`, or `vm_stat`
 * on macOS with libuv before 1.52, where both it and `os.freemem()` count only
 * truly free pages) now bounds the pool, and a page worker thread gets only
 * its share of the system maximum instead of the whole thing.
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

/**
 * On macOS, libuv before 1.52 (every Node 22 release so far, Node 24 before
 * 24.17) makes `process.availableMemory()` return `os.freemem()`: a few hundred
 * MB on an idle 16 GB machine. That sized the child budget, and so the page
 * worker pool, to 1 for the whole build. `vm_stat` gives the reclaimable total
 * libuv 1.52 reports.
 */
describe("availableMemoryBytes on macOS with libuv before 1.52", () => {
  const MB = 1024 * 1024;
  const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     6147.
Pages active:                                 330799.
Pages inactive:                               329896.
Pages speculative:                               433.
Pages throttled:                                   0.
Pages wired down:                             164798.
`;
  const reclaimable = (6147 + 329896 + 433) * 16384;

  it("chooses vm_stat by platform and libuv version", () => {
    expect(needsVmStat("darwin", "1.51.0")).toBe(true);
    expect(needsVmStat("darwin", "1.50.0")).toBe(true);
    expect(needsVmStat("darwin", "0.99.9")).toBe(true);
    expect(needsVmStat("darwin", "1.52.0")).toBe(false);
    expect(needsVmStat("darwin", "1.52.1")).toBe(false);
    expect(needsVmStat("darwin", "2.0.0")).toBe(false);
    // Linux and Windows libuv already counts reclaimable memory.
    expect(needsVmStat("linux", "1.51.0")).toBe(false);
    expect(needsVmStat("win32", "1.40.0")).toBe(false);
    // An unreadable version on macOS is treated as old: vm_stat is right on any.
    expect(needsVmStat("darwin", undefined)).toBe(true);
    expect(needsVmStat("darwin", "unknown")).toBe(true);
  });

  it("parses free + inactive + speculative pages times the page size", () => {
    expect(parseVmStat(VM_STAT)).toBe(reclaimable);
    // 4 KiB pages (Intel Macs) and a missing speculative line.
    expect(
      parseVmStat(
        "Mach Virtual Memory Statistics: (page size of 4096 bytes)\n" +
          "Pages free:  10.\nPages inactive:  20.\n",
      ),
    ).toBe(30 * 4096);
  });

  it("rejects unreadable output and unexpected page-size lines instead of guessing", () => {
    expect(parseVmStat("")).toBeUndefined();
    expect(parseVmStat("vm_stat: command not found")).toBeUndefined();
    // No header: the page size is unknown.
    expect(
      parseVmStat("Pages free: 10.\nPages inactive: 20.\n"),
    ).toBeUndefined();
    for (const header of [
      "(page size of 0 bytes)",
      "(page size of 12345 bytes)",
      "(page size of 268435456 bytes)",
      "(page size of sixteen bytes)",
    ]) {
      expect(
        parseVmStat(`${header}\nPages free: 10.\nPages inactive: 20.\n`),
        header,
      ).toBeUndefined();
    }
    // A required count missing or malformed.
    expect(
      parseVmStat("(page size of 4096 bytes)\nPages free: 10.\n"),
    ).toBeUndefined();
    expect(
      parseVmStat(
        "(page size of 4096 bytes)\nPages free: lots.\nPages inactive: 20.\n",
      ),
    ).toBeUndefined();
  });

  it("uses vm_stat on darwin with libuv 1.51, and availableMemory() everywhere else", () => {
    const vmStat = vi.fn(() => VM_STAT);
    const availableMemory = vi.fn(() => 200 * MB);
    const totalMem = () => 16 * 1024 * MB;
    expect(
      availableMemoryBytes({
        platform: "darwin",
        uvVersion: "1.51.0",
        vmStat,
        availableMemory,
        totalMem,
      }),
    ).toBe(reclaimable);
    expect(availableMemory).not.toHaveBeenCalled();
    vmStat.mockClear();
    for (const [platform, uvVersion] of [
      ["darwin", "1.52.1"],
      ["linux", "1.51.0"],
    ]) {
      expect(
        availableMemoryBytes({
          platform,
          uvVersion,
          vmStat,
          availableMemory,
          totalMem,
        }),
      ).toBe(200 * MB);
    }
    expect(vmStat).not.toHaveBeenCalled();
  });

  it("falls back to total memory when vm_stat is missing or prints something else", () => {
    const totalMem = () => 16 * 1024 * MB;
    const availableMemory = () => 200 * MB;
    const missing = () => {
      throw Object.assign(new Error("spawnSync /usr/bin/vm_stat ENOENT"), {
        code: "ENOENT",
      });
    };
    for (const vmStat of [missing, () => "garbage", () => ""]) {
      expect(
        availableMemoryBytes({
          platform: "darwin",
          uvVersion: "1.51.0",
          vmStat,
          availableMemory,
          totalMem,
        }),
      ).toBe(16 * 1024 * MB);
    }
  });

  it("sizes a 16 GB, 8 CPU Mac with 200 MB free to the CPU count, not 1", () => {
    const totalMemBytes = 16 * 1024 * MB;
    const budget = (available: number) =>
      computeMaxChildProcesses({
        cpuCount: 8,
        availableMemBytes: available,
        totalMemBytes,
      });
    // What Node 22 on macOS measured before this fix.
    expect(budget(200 * MB)).toBe(1);
    expect(
      budget(
        availableMemoryBytes({
          platform: "darwin",
          uvVersion: "1.51.0",
          vmStat: () => VM_STAT,
          availableMemory: () => 200 * MB,
          totalMem: () => totalMemBytes,
        }),
      ),
    ).toBe(8);
  });
});

describe("resolveChildBudget", () => {
  const GB = 1024 * 1024 * 1024;
  const machine = { cpuCount: 8, totalMemBytes: 32 * GB };

  it("measures memory on the main thread and ignores worker variables there", () => {
    const measureAvailable = vi.fn(() => 16 * GB);
    const env: Record<string, string | undefined> = {
      [CHILD_WORKER_COUNT_VAR]: "4",
      [CHILD_SYSTEM_MAX_VAR]: "2",
    };
    expect(
      resolveChildBudget({
        ...machine,
        mainThread: true,
        env,
        measureAvailable,
      }),
    ).toEqual({ systemMax: 8, threadMax: 8 });
    expect(measureAvailable).toHaveBeenCalledTimes(1);
    expect(env).toEqual({});
  });

  it("gives a page worker its share of the inherited system maximum without measuring memory", () => {
    const measureAvailable = vi.fn(() => 0);
    const env: Record<string, string | undefined> = {
      [CHILD_WORKER_COUNT_VAR]: "3",
      [CHILD_SYSTEM_MAX_VAR]: "6",
      [MAX_CHILD_PROCESSES_VAR]: "1",
    };
    expect(
      resolveChildBudget({
        ...machine,
        mainThread: false,
        env,
        measureAvailable,
      }),
    ).toEqual({ systemMax: 6, threadMax: 2 });
    expect(measureAvailable).not.toHaveBeenCalled();
    // Consumed so build-script children do not inherit them; the user's own
    // override is left in place.
    expect(env).toEqual({ [MAX_CHILD_PROCESSES_VAR]: "1" });
  });

  it("falls back to measuring in a worker when the inherited value is missing or malformed", () => {
    for (const inherited of [undefined, "", "0", "-2", "two", "1.5"]) {
      const measureAvailable = vi.fn(() => 16 * GB);
      const env: Record<string, string | undefined> = {
        [CHILD_WORKER_COUNT_VAR]: "2",
        [CHILD_SYSTEM_MAX_VAR]: inherited,
      };
      expect(
        resolveChildBudget({
          ...machine,
          mainThread: false,
          env,
          measureAvailable,
        }),
        String(inherited),
      ).toEqual({ systemMax: 8, threadMax: 4 });
      expect(measureAvailable).toHaveBeenCalledTimes(1);
    }
  });

  it("skips the memory measurement when BASCIK_MAX_CHILD_PROCESSES decides", () => {
    const measureAvailable = vi.fn(() => 0);
    expect(
      resolveChildBudget({
        ...machine,
        mainThread: true,
        env: { [MAX_CHILD_PROCESSES_VAR]: "3" },
        measureAvailable,
      }),
    ).toEqual({ systemMax: 3, threadMax: 3 });
    expect(measureAvailable).not.toHaveBeenCalled();
  });
});
