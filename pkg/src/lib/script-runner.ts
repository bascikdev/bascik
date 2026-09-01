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
}

export const sharedChildSemaphore = new Semaphore(MAX_CHILD_PROCESSES);

export const runModule = async (
  path: string,
  extraEnv: Record<string, string> = {},
  args: string[] = [],
  timeoutMs: number = 60_000,
  maxBuffer: number = 10 * 1024 * 1024, // 10MB default
): Promise<{ stdout: string; stderr: string }> => {
  await sharedChildSemaphore.acquire();
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

  return new Promise((resolve, reject) => {
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
        sharedChildSemaphore.release();
        const cleanedStdout = stdout ? stripAnsiEscapeCodes(stdout) : "";
        const cleanedStderr = stderr ? stripAnsiEscapeCodes(stderr) : "";
        if (err) {
          reject(Object.assign(err, { stdout: cleanedStdout, stderr: cleanedStderr }));
        } else {
          resolve({ stdout: cleanedStdout, stderr: cleanedStderr });
        }
      },
    );
  });
};
