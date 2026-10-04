import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, freemem, totalmem, tmpdir } from "node:os";
import { join } from "node:path";
import { BascikConfig } from "./config.ts";

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
    if (value !== undefined && Buffer.byteLength(value, "utf8") > MAX_INLINE_ENV_BYTES) {
      spilled[name] = value;
      delete env[name];
    }
  }
  if (Object.keys(spilled).length === 0) {
    return { execArgv: [], cleanup: async () => { } };
  }
  const directory = await mkdtemp(join(tmpdir(), "bascik-env-"));
  const file = join(directory, "env.json");
  await writeFile(file, JSON.stringify(spilled), { encoding: "utf8", mode: 0o600 });
  env[SPILLED_ENV_FILE_VAR] = file;
  return {
    execArgv: ["--import", SPILLED_ENV_PRELOAD],
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
};

export const stripAnsiEscapeCodes = (value: string): string =>
  value.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B[@-Z\\-_]/g, "");

const MEM_PER_CHILD = 120 * 1024 * 1024; // 120 MB conservative per worker
const MAX_CHILD_PROCESSES = Math.min(
  cpus().length,
  Math.max(1, Math.floor(Math.max(freemem() * 0.6, totalmem() * 0.25) / MEM_PER_CHILD)),
);

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
    if (this.queue.length > 0) {
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
}

export { Semaphore };

export const sharedChildSemaphore = new Semaphore(MAX_CHILD_PROCESSES);

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
  let cleanupSpill: () => Promise<void> = async () => { };
  try {
    const spill = await spillLargeEnv(childEnv);
    cleanupSpill = spill.cleanup;
    return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      let settled = false;

      const settle = (err: Error | null, stdout: string, stderr: string): void => {
        if (settled) return;
        settled = true;
        const cleanedStdout = stdout ? stripAnsiEscapeCodes(stdout) : "";
        const cleanedStderr = stderr ? stripAnsiEscapeCodes(stderr) : "";
        if (err) {
          reject(Object.assign(err, { stdout: cleanedStdout, stderr: cleanedStderr }));
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
    });
  } finally {
    await cleanupSpill().catch(() => { });
    // Exactly-once release: this runs whether the child succeeded, failed, was
    // killed by timeout, or execFile threw synchronously. `release()` is safe to
    // call from a `finally` even when the acquire above resolved immediately.
    semaphore.release();
  }
};
