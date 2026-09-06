import { execFile } from "node:child_process";
import { cpus, freemem, totalmem } from "node:os";
import { BascikConfig } from "./config.ts";

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

  await semaphore.acquire();
  try {
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
        [path, ...args],
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
    // Exactly-once release: this runs whether the child succeeded, failed, was
    // killed by timeout, or execFile threw synchronously. `release()` is safe to
    // call from a `finally` even when the acquire above resolved immediately.
    semaphore.release();
  }
};
