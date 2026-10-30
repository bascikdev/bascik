import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, totalmem, tmpdir } from "node:os";
import { join } from "node:path";
import { isMainThread } from "node:worker_threads";
import { BascikConfig } from "./config.ts";
import { stripAnsiEscapeCodes } from "./ansi-escapes.ts";

/**
 * Largest environment value passed to a child directly. Linux rejects any
 * single environment string over 128 KiB (MAX_ARG_STRLEN) and macOS limits the
 * whole environment to about 1 MiB, both with `spawn E2BIG`. A larger value
 * (in practice a dynamic route's `data`, which can hold a whole post body) is
 * written to a temp file instead and restored into `process.env` by a preload
 * that runs before the script and every module it imports.
 */
export const MAX_INLINE_ENV_BYTES = 32 * 1024;

/** Environment variables that may carry large payloads and can be spilled to a file. */
const SPILLABLE_ENV = ["BASCIK_ROUTE"] as const;

/** Points the preload at the spilled payload file. Removed before user code runs. */
export const SPILLED_ENV_FILE_VAR = "BASCIK_INTERNAL_ENV_FILE";

// Runs before user code: reads the spilled values into process.env and removes
// the pointer, so scripts read BASCIK_ROUTE exactly as they would inline.
const SPILLED_ENV_PRELOAD =
  "data:text/javascript," +
  encodeURIComponent(
    `import { readFileSync } from "node:fs";` +
      `const file = process.env.${SPILLED_ENV_FILE_VAR};` +
      `delete process.env.${SPILLED_ENV_FILE_VAR};` +
      `if (file) Object.assign(process.env, JSON.parse(readFileSync(file, "utf8")));`,
  );

/**
 * Move oversized spillable values out of `env` into a temp file. Returns the
 * extra node arguments and a cleanup function; both are no-ops when every
 * value is small enough to pass inline.
 */
export const spillLargeEnv = async (
  env: Record<string, string | undefined>,
): Promise<{ execArgv: string[]; cleanup: () => Promise<void> }> => {
  const spilled: Record<string, string> = {};
  for (const name of SPILLABLE_ENV) {
    const value = env[name];
    if (
      value !== undefined &&
      Buffer.byteLength(value, "utf8") > MAX_INLINE_ENV_BYTES
    ) {
      spilled[name] = value;
      delete env[name];
    }
  }
  if (Object.keys(spilled).length === 0) {
    return { execArgv: [], cleanup: async () => {} };
  }
  const directory = await mkdtemp(join(tmpdir(), "bascik-env-"));
  const file = join(directory, "env.json");
  await writeFile(file, JSON.stringify(spilled), {
    encoding: "utf8",
    mode: 0o600,
  });
  env[SPILLED_ENV_FILE_VAR] = file;
  return {
    execArgv: ["--import", SPILLED_ENV_PRELOAD],
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
};

// Portable, so a Worker strips the same sequences (prompt 157).
export { stripAnsiEscapeCodes };

/** Conservative memory reserved for each build-script child process. */
export const MEM_PER_CHILD = 120 * 1024 * 1024; // 120 MB

/**
 * Tells a page worker thread how many workers share the child budget, so each
 * one claims its share instead of the whole system maximum. Set by the main
 * thread in the environment it hands to the worker pool and removed from the
 * worker's `process.env` as soon as it is read, so no build-script child can
 * inherit it whichever runner spawns it. Never meant to be set by users
 * (hence `BASCIK_INTERNAL_`, like `SPILLED_ENV_FILE_VAR`).
 */
export const CHILD_WORKER_COUNT_VAR = "BASCIK_INTERNAL_WORKER_COUNT";

/**
 * Optional user override for the process-wide maximum number of concurrent
 * build-script child processes (`data-bascik-build` / `data-bascik-routes`).
 * A positive integer replaces the CPU- and memory-derived maximum in both
 * directions. With `pipeline.workers` on, the page worker pool is sized to at
 * most this value (see `processAllPages`) and each worker gets its share of
 * it, so the total across all threads never exceeds the value set.
 * A malformed value is ignored, not fatal, like `BASCIK_SERVER_PORT`.
 */
export const MAX_CHILD_PROCESSES_VAR = "BASCIK_MAX_CHILD_PROCESSES";

/** Parse a positive integer env value; `undefined` for unset or malformed. */
const parsePositiveInteger = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw.trim());
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
};

/**
 * Size the child process pool for one thread.
 *
 * The memory budget is `availableMemBytes * 0.6` capped at
 * `totalMemBytes * 0.25`. The earlier formula took the MAX of the two, so
 * `totalmem() * 0.25` acted as a floor: a 16 GB machine with under 100 MB
 * free still admitted `min(cpuCount, 35)` children and thrashed swap until
 * they hit the execFile timeout. Available memory now bounds the pool, with a
 * minimum of 1 so a build always makes forward progress.
 *
 * The caller passes `availableMemoryBytes()`, not `os.freemem()`. On macOS
 * XNU keeps file pages in inactive memory, so `freemem()` counts only truly
 * free pages and reads a few hundred MB on an idle 16 GB machine, which would
 * serialize every build script during normal operation. On Linux and Windows
 * `process.availableMemory()` already counts what the kernel will hand out
 * (MemAvailable, a cgroup limit, ullAvailPhys). On macOS it does so only from
 * libuv 1.52; earlier libuv (every Node 22 release so far, Node 24 before
 * 24.17) returns `freemem()` there, so `availableMemoryBytes()` reads
 * `vm_stat` instead. The `BASCIK_MAX_CHILD_PROCESSES` override replaces the
 * computed system maximum when it still gets it wrong.
 *
 * `workerCount` divides the system maximum across page worker threads, since
 * each thread instantiates its own module-scoped semaphore. The per-thread
 * floor of 1 would let the total exceed the system maximum when there are
 * more workers than permits, so `processAllPages` sizes the pool to at most
 * `SYSTEM_MAX_CHILD_PROCESSES` and every worker's share is a whole permit.
 */
export const computeMaxChildProcesses = ({
  cpuCount,
  availableMemBytes,
  totalMemBytes,
  workerCount = 1,
  override,
}: {
  cpuCount: number;
  availableMemBytes: number;
  totalMemBytes: number;
  workerCount?: number;
  override?: number;
}): number => {
  const systemMax =
    override ??
    Math.min(
      Math.max(1, cpuCount),
      Math.max(
        1,
        Math.floor(
          Math.min(availableMemBytes * 0.6, totalMemBytes * 0.25) /
            MEM_PER_CHILD,
        ),
      ),
    );
  return Math.max(1, Math.floor(systemMax / Math.max(1, workerCount)));
};

/**
 * The first libuv whose `uv_get_available_memory` on macOS counts reclaimable
 * pages (free + inactive + speculative). Earlier versions return the same
 * value as `os.freemem()` there.
 */
const LIBUV_DARWIN_RECLAIMABLE: readonly [number, number] = [1, 52];

/**
 * Whether `process.availableMemory()` under-reports on this runtime: macOS
 * with libuv older than 1.52. An unreadable uv version on macOS counts as
 * old, since `vm_stat` is accurate on every version anyway.
 */
export const needsVmStat = (
  platform: string,
  uvVersion: string | undefined,
): boolean => {
  if (platform !== "darwin") return false;
  const match = /^(\d+)\.(\d+)/.exec(uvVersion ?? "");
  if (!match) return true;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  const [wantMajor, wantMinor] = LIBUV_DARWIN_RECLAIMABLE;
  return major < wantMajor || (major === wantMajor && minor < wantMinor);
};

/**
 * Reclaimable bytes from `vm_stat` output: (free + inactive + speculative)
 * pages times the page size from its header line, the sum libuv 1.52 reports.
 * `undefined` when the header or the free or inactive count is missing or
 * malformed, so a changed format falls back rather than guessing.
 * `speculative` is optional and counts as 0 when absent.
 */
export const parseVmStat = (output: string): number | undefined => {
  const pageSizeMatch = /\(page size of (\d+) bytes\)/.exec(output);
  if (!pageSizeMatch) return undefined;
  const pageSize = Number(pageSizeMatch[1]);
  // Real page sizes are 4 KiB or 16 KiB; anything not a power of two from
  // 512 B to 1 MiB means the line is not what it looks like.
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 512 ||
    pageSize > 1024 * 1024 ||
    (pageSize & (pageSize - 1)) !== 0
  ) {
    return undefined;
  }
  const pages = (label: string): number | undefined => {
    const match = new RegExp(`^Pages ${label}:\\s+(\\d+)\\.?\\s*$`, "m").exec(
      output,
    );
    return match ? Number(match[1]) : undefined;
  };
  const free = pages("free");
  const inactive = pages("inactive");
  if (free === undefined || inactive === undefined) return undefined;
  return (free + inactive + (pages("speculative") ?? 0)) * pageSize;
};

const readVmStat = (): string =>
  execFileSync("/usr/bin/vm_stat", [], {
    encoding: "utf8",
    timeout: 2000,
    stdio: ["ignore", "pipe", "ignore"],
  });

/**
 * Memory the kernel will hand out, in bytes. `process.availableMemory()`
 * except on macOS with libuv older than 1.52 (see `needsVmStat`), where one
 * `vm_stat` call (about 3 ms) gives the reclaimable total. If `vm_stat` fails
 * or prints something unrecognizable, total memory is returned, so the
 * `totalMem * 0.25` cap in `computeMaxChildProcesses` decides instead of a
 * `freemem()`-sized budget that would serialize the build.
 */
export const availableMemoryBytes = ({
  platform = process.platform,
  uvVersion = process.versions.uv,
  vmStat = readVmStat,
  availableMemory = () => process.availableMemory(),
  totalMem = totalmem,
}: {
  platform?: string;
  uvVersion?: string;
  vmStat?: () => string;
  availableMemory?: () => number;
  totalMem?: () => number;
} = {}): number => {
  if (!needsVmStat(platform, uvVersion)) return availableMemory();
  try {
    return parseVmStat(vmStat()) ?? totalMem();
  } catch {
    return totalMem();
  }
};

/**
 * Carries the main thread's `SYSTEM_MAX_CHILD_PROCESSES` to page worker
 * threads, next to `CHILD_WORKER_COUNT_VAR`, so every worker divides the same
 * number (instead of re-measuring memory, and on older macOS running
 * `vm_stat`, once per worker at module load). Internal, consumed on read.
 */
export const CHILD_SYSTEM_MAX_VAR = "BASCIK_INTERNAL_SYSTEM_MAX_CHILDREN";

/**
 * Resolve the process-wide child budget and this thread's share of it. A page
 * worker thread takes both the worker count and the system maximum from the
 * environment the main thread gave it (env is the only channel available at
 * module load, before `workerData` is read) and removes them, so that every
 * child a worker spawns, through `runModule` or `runDirectiveHandler`, sees
 * the same environment the main thread would have given it. Memory is only
 * measured when nothing supplies the system maximum.
 */
export const resolveChildBudget = ({
  mainThread,
  env,
  cpuCount,
  totalMemBytes,
  measureAvailable,
}: {
  mainThread: boolean;
  env: Record<string, string | undefined>;
  cpuCount: number;
  totalMemBytes: number;
  measureAvailable: () => number;
}): { systemMax: number; threadMax: number } => {
  const workerCount = mainThread
    ? 1
    : parsePositiveInteger(env[CHILD_WORKER_COUNT_VAR]);
  const inherited = mainThread
    ? undefined
    : parsePositiveInteger(env[CHILD_SYSTEM_MAX_VAR]);
  delete env[CHILD_WORKER_COUNT_VAR];
  delete env[CHILD_SYSTEM_MAX_VAR];
  const override =
    inherited ?? parsePositiveInteger(env[MAX_CHILD_PROCESSES_VAR]);
  const systemMax = computeMaxChildProcesses({
    cpuCount,
    // Not measured when an override or the inherited value decides anyway.
    availableMemBytes: override === undefined ? measureAvailable() : 0,
    totalMemBytes,
    override,
  });
  return {
    systemMax,
    threadMax: computeMaxChildProcesses({
      cpuCount,
      availableMemBytes: 0,
      totalMemBytes,
      override: systemMax,
      workerCount,
    }),
  };
};

const childBudget = resolveChildBudget({
  mainThread: isMainThread,
  env: process.env,
  cpuCount: cpus().length,
  totalMemBytes: totalmem(),
  measureAvailable: () => availableMemoryBytes(),
});

/**
 * The process-wide child budget. `processAllPages` sizes the page worker pool
 * to at most this many workers, so dividing it among them never bottoms out
 * at the per-worker floor of 1 and the pool as a whole stays within it.
 */
export const SYSTEM_MAX_CHILD_PROCESSES = childBudget.systemMax;

/** This thread's share of the budget: all of it on the main thread. */
const MAX_CHILD_PROCESSES = childBudget.threadMax;

class Semaphore {
  private queue: Array<() => void> = [];
  private current = 0;
  private max: number;

  constructor(max: number) {
    this.max = max;
  }

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.current++;
        resolve();
      });
    });
  }

  release(): void {
    this.current--;
    // Checked against the cap, not just the queue: after `setMax` lowered it,
    // a release must not admit a waiter while still at or over the new cap.
    if (this.queue.length > 0 && this.current < this.max) {
      const next = this.queue.shift()!;
      next();
    }
  }

  getActiveCount(): number {
    return this.current;
  }

  getMax(): number {
    return this.max;
  }

  /**
   * Change the cap in place. Raising it admits waiters at once; lowering it
   * revokes nothing already held, the excess drains as holders release. A
   * non-positive or non-integer value becomes 1, so callers always progress.
   */
  setMax(max: number): void {
    this.max = Number.isInteger(max) && max >= 1 ? max : 1;
    while (this.current < this.max && this.queue.length > 0) {
      this.queue.shift()!();
    }
  }
}

export { Semaphore };

export const sharedChildSemaphore = new Semaphore(MAX_CHILD_PROCESSES);

/**
 * Re-divide the child budget for a page worker after the pool it belongs to
 * changed size. The environment only gives a worker the pool size at spawn;
 * the build starts its pool before it knows the job count and trims it after,
 * so the survivors are told the final count and get the share a pool sized
 * to the job count from the start would have given them (the total across
 * threads stays within the budget either way).
 */
export const setChildWorkerCount = (workerCount: number): void => {
  sharedChildSemaphore.setMax(
    computeMaxChildProcesses({
      cpuCount: 0,
      availableMemBytes: 0,
      totalMemBytes: 0,
      override: SYSTEM_MAX_CHILD_PROCESSES,
      workerCount,
    }),
  );
};

export {
  runDirectiveHandler,
  type DirectiveKind,
  type DirectiveHandlerResult,
  type DirectiveHandlerOptions,
} from "./handler-runner.ts";

/**
 * Run one Node.js module in a bounded fresh child process and return its stdout
 * and stderr, cleaned of ANSI escape codes.
 *
 * Child admission is a scoped resource. A permit is acquired from `semaphore`
 * (defaulting to the process-wide `sharedChildSemaphore`) and released exactly
 * once on every completion path: successful exit, async execFile error, timeout
 * kill, or a SYNCHRONOUS argument-validation throw from execFile. Pre-103 the
 * permit was released only from execFile's callback, so a synchronous throw
 * (for example a NUL byte embedded in `path`) leaked the slot indefinitely.
 *
 * The Promise is settled on a single guarded completion path via execFile's
 * callback, so a timeout kill and an execFile error converge to the same
 * rejection handling and the single `finally` below returns the permit.
 *
 * `semaphore` is injectable so the caller can observe admit/release accounting
 * deterministically in tests; production callers omit it and share the
 * process-wide concurrency budget.
 */
export const runModule = async (
  path: string,
  extraEnv: Record<string, string> = {},
  args: string[] = [],
  timeoutMs: number = 60_000,
  maxBuffer: number = 10 * 1024 * 1024, // 10MB default
  semaphore: Semaphore = sharedChildSemaphore,
): Promise<{ stdout: string; stderr: string }> => {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    BASCIK_BUILD: BascikConfig.isBuild ? "1" : "0",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    ...extraEnv,
  };
  if (!extraEnv.BASCIK_ROUTE) {
    delete childEnv.BASCIK_ROUTE;
  }
  // Never forward a stale pointer from the parent's own environment.
  delete childEnv[SPILLED_ENV_FILE_VAR];

  await semaphore.acquire();
  let cleanupSpill: () => Promise<void> = async () => {};
  try {
    const spill = await spillLargeEnv(childEnv);
    cleanupSpill = spill.cleanup;
    return await new Promise<{ stdout: string; stderr: string }>(
      (resolve, reject) => {
        let settled = false;

        const settle = (
          err: Error | null,
          stdout: string,
          stderr: string,
        ): void => {
          if (settled) return;
          settled = true;
          const cleanedStdout = stdout ? stripAnsiEscapeCodes(stdout) : "";
          const cleanedStderr = stderr ? stripAnsiEscapeCodes(stderr) : "";
          if (err) {
            reject(
              Object.assign(err, {
                stdout: cleanedStdout,
                stderr: cleanedStderr,
              }),
            );
          } else {
            resolve({ stdout: cleanedStdout, stderr: cleanedStderr });
          }
        };

        // execFile throws synchronously for invalid arguments (for example a NUL
        // byte in `path`). The callback never runs, so the release must not depend
        // on it. A synchronous throw settles the Promise with the error; the
        // surrounding try/finally releases the admitted permit.
        execFile(
          process.execPath,
          [...spill.execArgv, path, ...args],
          {
            cwd: process.cwd(),
            env: childEnv as Record<string, string>,
            timeout: timeoutMs,
            maxBuffer,
            killSignal: "SIGTERM",
          },
          (err, stdout, stderr) => {
            settle(err, stdout ?? "", stderr ?? "");
          },
        );
      },
    );
  } finally {
    await cleanupSpill().catch(() => {});
    // Exactly-once release: this runs whether the child succeeded, failed, was
    // killed by timeout, or execFile threw synchronously. `release()` is safe to
    // call from a `finally` even when the acquire above resolved immediately.
    semaphore.release();
  }
};
