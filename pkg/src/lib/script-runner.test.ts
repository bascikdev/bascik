import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { MAX_INLINE_ENV_BYTES, SPILLED_ENV_FILE_VAR, Semaphore, runModule } from "./script-runner.ts";

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
      throw Object.assign(new TypeError("The \"path\" argument must be of type string"), { code: "ERR_INVALID_ARG_VALUE" });
    });
    execFileMock.mockImplementationOnce(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: null, stdout: string, stderr: string) => void) => {
        cb(null, "ok", "");
      },
    );

    await expect(runModule("bad\0path", {}, [], 1000, 1024, sem)).rejects.toThrow();
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
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: Error) => void) => {
        cb(new Error("script crashed"));
      },
    );
    await expect(runModule("path", {}, [], 1000, 1024, sem)).rejects.toThrow("script crashed");
    expect(sem.getActiveCount()).toBe(0);

    execFileMock.mockImplementationOnce(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: Error & { killed?: boolean; signal?: string }) => void) => {
        cb(Object.assign(new Error("Command timed out"), { killed: true, signal: "SIGTERM" }));
      },
    );
    await expect(runModule("path", {}, [], 1, 1024, sem)).rejects.toThrow(/timed out|Command/);
    expect(sem.getActiveCount()).toBe(0);
  });

  it("passes a small BASCIK_ROUTE inline with no preload", async () => {
    const sem = new Semaphore(1);
    execFileMock.mockImplementationOnce(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: null, stdout: string, stderr: string) => void) => {
        cb(null, "", "");
      },
    );
    await runModule("script.mjs", { BASCIK_ROUTE: '{"params":{}}' }, [], 1000, 1024, sem);
    const [, args, opts] = execFileMock.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    expect(args).toEqual(["script.mjs"]);
    expect(opts.env.BASCIK_ROUTE).toBe('{"params":{}}');
    expect(opts.env[SPILLED_ENV_FILE_VAR]).toBeUndefined();
  });

  it("moves an oversized BASCIK_ROUTE to a temp file read by a preload, and removes the file", async () => {
    const sem = new Semaphore(1);
    const route = JSON.stringify({ params: { slug: "long" }, data: { body: "é".repeat(MAX_INLINE_ENV_BYTES) } });
    let seenFile = "";
    let seenContent = "";
    execFileMock.mockImplementationOnce(
      (_cmd: unknown, _args: unknown, opts: { env: Record<string, string> }, cb: (err: null, stdout: string, stderr: string) => void) => {
        seenFile = opts.env[SPILLED_ENV_FILE_VAR];
        seenContent = readFileSync(seenFile, "utf8");
        cb(null, "", "");
      },
    );
    await runModule("script.mjs", { BASCIK_ROUTE: route }, ["x"], 1000, 1024, sem);
    const [, args, opts] = execFileMock.mock.calls[0] as [string, string[], { env: Record<string, string> }];
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
      (_cmd: unknown, _args: unknown, opts: { env: Record<string, string> }, cb: (err: Error) => void) => {
        seenFile = opts.env[SPILLED_ENV_FILE_VAR];
        cb(new Error("script crashed"));
      },
    );
    const route = JSON.stringify({ data: "x".repeat(MAX_INLINE_ENV_BYTES + 1) });
    await expect(runModule("script.mjs", { BASCIK_ROUTE: route }, [], 1000, 1024, sem)).rejects.toThrow("script crashed");
    expect(seenFile).not.toBe("");
    expect(existsSync(seenFile)).toBe(false);
    expect(sem.getActiveCount()).toBe(0);
  });

  it("releases the permit exactly once on a successful run", async () => {
    const sem = new Semaphore(1);
    execFileMock.mockImplementationOnce(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: null, stdout: string, stderr: string) => void) => {
        cb(null, "out", "");
      },
    );
    const result = await runModule("path", {}, [], 1000, 1024, sem);
    expect(result.stdout).toBe("out");
    expect(sem.getActiveCount()).toBe(0);
  });
});