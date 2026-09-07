import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockSpawn,
  setNextExitCode,
  mockWatch,
  mockEventEmit,
  mockRegisterShutdownHandler,
  resetMocks,
} = vi.hoisted(() => {
  let nextExitCode = 0;
  const registeredShutdownHandlers: Array<() => void | Promise<void>> = [];

  const makeProcess = () => {
    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    const proc = {
      kill: vi.fn(),
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        handlers[event] = handlers[event] || [];
        handlers[event].push(cb);
        if (event === "close") {
          Promise.resolve().then(() => cb(nextExitCode));
        }
        return proc;
      }),
      emitEvent: (event: string, ...args: unknown[]) => {
        handlers[event]?.forEach((cb) => cb(...args));
      },
    };
    return proc;
  };

  const mockSpawn = vi.fn(makeProcess);

  const watchers: {
    on: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    handlers: Record<string, (...args: unknown[]) => void>;
  }[] = [];

  const makeWatcher = () => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const watcher = {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        handlers[event] = cb;
        return watcher;
      }),
      close: vi.fn(),
      handlers,
    };
    watchers.push(watcher);
    return watcher;
  };

  const mockWatch = vi.fn(makeWatcher);
  const mockEventEmit = vi.fn();
  const mockRegisterShutdownHandler = vi.fn((fn: () => void | Promise<void>) => {
    registeredShutdownHandlers.push(fn);
  });

  const resetMocks = () => {
    nextExitCode = 0;
    mockSpawn.mockReset().mockImplementation(makeProcess);
    mockWatch.mockReset().mockImplementation(makeWatcher);
    mockEventEmit.mockReset();
    mockRegisterShutdownHandler.mockReset().mockImplementation((fn: () => void | Promise<void>) => {
      registeredShutdownHandlers.push(fn);
    });
    registeredShutdownHandlers.length = 0;
    watchers.length = 0;
  };

  return {
    mockSpawn,
    setNextExitCode: (code: number) => {
      nextExitCode = code;
    },
    mockWatch,
    getWatcher: (i: number) => watchers[i],
    mockEventEmit,
    mockRegisterShutdownHandler,
    registeredShutdownHandlers,
    resetMocks,
  };
});

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));
vi.mock("chokidar", () => ({ default: { watch: mockWatch } }));
vi.mock("./events.js", () => ({
  eventEmitter: { emit: mockEventEmit },
  registerShutdownHandler: mockRegisterShutdownHandler,
}));
vi.mock("./config.js", () => ({
  BascikConfig: { pipeline: { exec: undefined } },
}));

import { BascikConfig } from "./config.ts";
import { runScript, runExecPhase, startExecParallel, startExecDev, execShutdownHandler, getActiveExecChildrenCount, resetActiveExecChildrenForTests } from "./exec.ts";
import { type FrameworkClock } from "./clock.ts";

const cfg = BascikConfig as { pipeline: { exec: typeof BascikConfig.pipeline.exec } };

beforeEach(() => {
  resetMocks();
  resetActiveExecChildrenForTests();
  cfg.pipeline.exec = undefined;
});

afterEach(() => {
  resetActiveExecChildrenForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("runExecPhase", () => {
  it("runs only entries in the requested phase", async () => {
    cfg.pipeline.exec = [
      { script: "scripts/pre.ts", phase: "pre" },
      { script: "scripts/post.ts", phase: "post" },
      { script: "scripts/pre2.ts", phase: "pre" },
    ];

    const result = await runExecPhase("pre");
    expect(result.count).toBe(2);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawn).toHaveBeenNthCalledWith(1, process.execPath, ["scripts/pre.ts"], expect.anything());
    expect(mockSpawn).toHaveBeenNthCalledWith(2, process.execPath, ["scripts/pre2.ts"], expect.anything());
  });

  it("defaults undefined phase to pre", async () => {
    cfg.pipeline.exec = [{ script: "scripts/default.ts" }];
    const result = await runExecPhase("pre");
    expect(result.count).toBe(1);
  });

  it("rejects when a script exits non-zero", async () => {
    setNextExitCode(1);
    cfg.pipeline.exec = [{ script: "scripts/fail.ts", phase: "pre" }];
    await expect(runExecPhase("pre")).rejects.toThrow('exec "scripts/fail.ts" exited with code 1');
  });
});

describe("startExecParallel", () => {
  it("observes an early joined rejection before lazy dev startup registers task reporting", async () => {
    cfg.pipeline.exec = [{ script: "scripts/early-failure.ts", phase: "parallel" }];
    setNextExitCode(1);
    const errors = vi.spyOn(console, "error").mockImplementation(() => { });
    const handle = startExecParallel();
    // Model a lazy module import yielding an event-loop turn before startExecDev.
    await new Promise<void>(resolve => setImmediate(resolve));
    await startExecDev({ parallel: handle });
    await expect(handle).rejects.toThrow("early-failure.ts");
    await Promise.resolve();
    expect(mockEventEmit).toHaveBeenCalledWith("exec-failed", expect.objectContaining({ entry: cfg.pipeline.exec[0] }));
    expect(errors).toHaveBeenCalledOnce();
  });

  it("starts only parallel scripts", () => {
    cfg.pipeline.exec = [
      { script: "scripts/par1.ts", phase: "parallel" },
      { script: "scripts/pre.ts", phase: "pre" },
      { script: "scripts/par2.ts", phase: "parallel" },
    ];

    startExecParallel();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("exposes one task per parallel entry so dev can observe each outcome individually", async () => {
    cfg.pipeline.exec = [
      { script: "scripts/par1.ts", phase: "parallel" },
      { script: "scripts/pre.ts", phase: "pre" },
      { script: "scripts/par2.ts", phase: "parallel" },
    ];

    const handle = startExecParallel();
    expect(handle.tasks.map((task) => task.entry.script)).toEqual(["scripts/par1.ts", "scripts/par2.ts"]);
    // The joined promise still resolves for the build branch's awaited join.
    await expect(handle).resolves.toBeUndefined();
    await expect(Promise.all(handle.tasks.map((task) => task.promise))).resolves.toHaveLength(2);
  });

  it("returns an empty task list and a resolved join when no parallel entries exist", async () => {
    cfg.pipeline.exec = [{ script: "scripts/pre.ts", phase: "pre" }];
    const handle = startExecParallel();
    expect(handle.tasks).toEqual([]);
    await expect(handle).resolves.toBeUndefined();
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe("startExecDev: dev parallel outcome publication (prompt 137)", () => {
  it("observes every parallel rejection, including tasks that fail after the join rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    let failFirst!: (error: Error) => void;
    let failSecond!: (error: Error) => void;
    const tasks = [
      { entry: { script: "first.ts", phase: "parallel" as const }, promise: new Promise<number>((_resolve, reject) => { failFirst = reject; }) },
      { entry: { script: "second.ts", phase: "parallel" as const }, promise: new Promise<number>((_resolve, reject) => { failSecond = reject; }) },
    ];
    const parallel = Object.assign(Promise.all(tasks.map(task => task.promise)).then(() => undefined), { tasks });
    await startExecDev({ parallel });
    failFirst(new Error("first failure"));
    await parallel.catch(() => { });
    failSecond(new Error("second failure"));
    await Promise.allSettled(tasks.map(task => task.promise));
    await Promise.resolve();
    expect(mockEventEmit.mock.calls.filter(([name]) => name === "exec-failed").map(([, payload]) => payload.entry.script)).toEqual(["first.ts", "second.ts"]);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it("emits exec-completed for each settled parallel task without awaiting the join first", async () => {
    cfg.pipeline.exec = [
      { script: "scripts/par1.ts", phase: "parallel" },
      { script: "scripts/par2.ts", phase: "parallel" },
    ];
    const handle = startExecParallel();
    // Both children were spawned before either settled: unrelated parallel
    // entries stay concurrent.
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    await startExecDev({ parallel: handle });
    await handle;
    await Promise.resolve();

    expect(mockEventEmit).toHaveBeenCalledWith(
      "exec-completed",
      expect.objectContaining({
        entry: { script: "scripts/par1.ts", phase: "parallel" },
        paths: [],
      }),
    );
    expect(mockEventEmit).toHaveBeenCalledWith(
      "exec-completed",
      expect.objectContaining({
        entry: { script: "scripts/par2.ts", phase: "parallel" },
        paths: [],
      }),
    );
    const completed = mockEventEmit.mock.calls.filter(([name]) => name === "exec-completed");
    expect(completed).toHaveLength(2);
    // Registration does not rerun the already-started parallel work.
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("emits exec-failed (and never exec-completed) when a parallel task rejects, without throwing", async () => {
    cfg.pipeline.exec = [{ script: "scripts/fail.ts", phase: "parallel" }];
    setNextExitCode(1);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });

    const handle = startExecParallel();
    await expect(startExecDev({ parallel: handle })).resolves.toBeUndefined();
    await handle.catch(() => { });
    await Promise.resolve();

    expect(mockEventEmit).toHaveBeenCalledWith(
      "exec-failed",
      expect.objectContaining({
        entry: { script: "scripts/fail.ts", phase: "parallel" },
        paths: [],
        error: expect.any(Error),
      }),
    );
    expect(mockEventEmit).not.toHaveBeenCalledWith("exec-completed", expect.anything());
    // One failure prints exactly one stderr line; exec-failed only feeds the
    // SSE build-error overlay, which does not log.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("[bascik] exec error:", expect.any(Error));
    errorSpy.mockRestore();
  });

  it("publishes parallel outcomes even when no watched entries exist", async () => {
    cfg.pipeline.exec = [{ script: "scripts/par1.ts", phase: "parallel" }];
    const handle = startExecParallel();
    await startExecDev({ parallel: handle });
    await handle;
    await Promise.resolve();

    expect(mockWatch).not.toHaveBeenCalled();
    expect(mockEventEmit).toHaveBeenCalledWith(
      "exec-completed",
      expect.objectContaining({ paths: [] }),
    );
  });
});

describe("startExecDev", () => {
  it('serializes a watched rerun behind the same entry still running at startup', async () => {
    const closes: ((code: number) => void)[] = [];
    mockSpawn.mockImplementation(() => {
      const child = {
        kill: vi.fn(),
        on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
          if (event === 'close') closes.push(code => callback(code));
          return child;
        }),
        emitEvent: (_event: string, ..._args: unknown[]) => {},
      };
      return child;
    });
    const entry = { script: 'scripts/parallel.ts', phase: 'parallel' as const, watch: ['content/'] };
    cfg.pipeline.exec = [entry];
    const startup = startExecParallel();
    const rerun = runScript(entry);
    try {
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    } finally {
      closes[0](0);
      await startup;
      await vi.waitFor(() => expect(closes).toHaveLength(2));
      closes[1](0);
      await rerun;
    }
  });
  it("does nothing when no watched entries exist", async () => {
    cfg.pipeline.exec = [{ script: "scripts/build-only.ts" }];
    await startExecDev();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockWatch).not.toHaveBeenCalled();
  });

  it("leaves source watches to the phase lifecycle without rerunning startup work", async () => {
    cfg.pipeline.exec = [{ script: "scripts/gen.ts", watch: ["content/"] }];
    await startExecDev();
    expect(mockSpawn).toHaveBeenCalledTimes(0);
    expect(mockWatch).not.toHaveBeenCalled();
    expect(mockRegisterShutdownHandler).not.toHaveBeenCalled();
  });

  it("passes cwd, args, and merged env with Bascik context variables to child process", async () => {
    cfg.pipeline.exec = [
      {
        script: "scripts/build.ts",
        cwd: "custom-dir",
        args: ["--format", "json"],
        env: { CUSTOM_VAR: "custom_val" },
      },
    ];
    await runExecPhase("pre");

    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      ["scripts/build.ts", "--format", "json"],
      expect.objectContaining({
        cwd: expect.stringContaining("custom-dir"),
        env: expect.objectContaining({
          CUSTOM_VAR: "custom_val",
          BASCIK_BASE: "/",
          BASCIK_PAGES_DIR: expect.any(String),
        }),
      }),
    );
  });

  it("fails the build when a parallel script fails", async () => {
    cfg.pipeline.exec = [{ script: "scripts/fail.ts", phase: "parallel" }];
    setNextExitCode(1);

    await expect(startExecParallel()).rejects.toThrow(/exited with code 1/);
  });

});

describe("exec timeout escalation and lifecycle", () => {
  it("escalates SIGTERM at timeout deadline and SIGKILL 500ms later if not exited", async () => {
    vi.useFakeTimers();
    const proc = {
      kill: vi.fn(),
      on: vi.fn(() => proc),
    };
    mockSpawn.mockImplementationOnce(() => proc as any);

    cfg.pipeline.exec = [{ script: "scripts/long.ts", timeout: 1000 }];
    const promise = runExecPhase("pre");

    // Before timeout
    vi.advanceTimersByTime(999);
    expect(proc.kill).not.toHaveBeenCalled();

    // At timeout (1000ms): SIGTERM fired and promise rejected
    vi.advanceTimersByTime(1);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(promise).rejects.toThrow(/timed out after 1000ms/);

    // 499ms after SIGTERM: SIGKILL not yet fired
    vi.advanceTimersByTime(499);
    expect(proc.kill).toHaveBeenCalledTimes(1);

    // 500ms after SIGTERM: SIGKILL fired
    vi.advanceTimersByTime(1);
    expect(proc.kill).toHaveBeenCalledTimes(2);
    expect(proc.kill).toHaveBeenLastCalledWith("SIGKILL");
  });

  it("does not fire SIGKILL if child closes during the 500ms escalation window", async () => {
    vi.useFakeTimers();
    let closeCb: ((code: number) => void) | undefined;
    const proc = {
      kill: vi.fn(),
      on: vi.fn((event: string, cb: any) => {
        if (event === "close") closeCb = cb;
        return proc;
      }),
    };
    mockSpawn.mockImplementationOnce(() => proc as any);

    cfg.pipeline.exec = [{ script: "scripts/long.ts", timeout: 1000 }];
    const promise = runExecPhase("pre");

    // Advance to timeout
    vi.advanceTimersByTime(1000);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(promise).rejects.toThrow(/timed out after 1000ms/);

    // Child closes 200ms into escalation
    vi.advanceTimersByTime(200);
    closeCb?.(0);

    // Advance past escalation deadline
    vi.advanceTimersByTime(400);
    expect(proc.kill).toHaveBeenCalledTimes(1); // Only SIGTERM was called, never SIGKILL
  });

  it("cancels timers immediately when child closes normally", async () => {
    vi.useFakeTimers();
    let closeCb: ((code: number) => void) | undefined;
    const proc = {
      kill: vi.fn(),
      on: vi.fn((event: string, cb: any) => {
        if (event === "close") closeCb = cb;
        return proc;
      }),
    };
    mockSpawn.mockImplementationOnce(() => proc as any);

    cfg.pipeline.exec = [{ script: "scripts/quick.ts", timeout: 5000 }];
    const promise = runExecPhase("pre");

    // Child finishes quickly
    vi.advanceTimersByTime(100);
    closeCb?.(0);
    await expect(promise).resolves.toBeDefined();

    // Advancing past timeout must not trigger any kills
    vi.advanceTimersByTime(10000);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("cancels timers immediately when child errors", async () => {
    vi.useFakeTimers();
    let errorCb: ((err: Error) => void) | undefined;
    const proc = {
      kill: vi.fn(),
      on: vi.fn((event: string, cb: any) => {
        if (event === "error") errorCb = cb;
        return proc;
      }),
    };
    mockSpawn.mockImplementationOnce(() => proc as any);

    cfg.pipeline.exec = [{ script: "scripts/err.ts", timeout: 5000 }];
    const promise = runExecPhase("pre");

    errorCb?.(new Error("spawn ENOENT"));
    await expect(promise).rejects.toThrow("spawn ENOENT");

    vi.advanceTimersByTime(10000);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("shutdown handler awaits child close event up to deadline and sends SIGKILL if not closed", async () => {
    vi.useFakeTimers();
    let closeCb: ((code: number) => void) | undefined;
    const proc = {
      kill: vi.fn(),
      on: vi.fn((event: string, cb: any) => {
        if (event === "close") closeCb = cb;
        return proc;
      }),
    };
    mockSpawn.mockImplementationOnce(() => proc as any);

    cfg.pipeline.exec = [{ script: "scripts/server.ts", timeout: 0 }];
    void runExecPhase("pre"); // leaves child active

    expect(getActiveExecChildrenCount()).toBe(1);

    // Invoke shutdown handler
    const shutdownPromise = execShutdownHandler();
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");

    // Advance 199ms - still waiting
    vi.advanceTimersByTime(199);
    expect(proc.kill).toHaveBeenCalledTimes(1);

    // At 200ms deadline, SIGKILL is sent
    vi.advanceTimersByTime(1);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");

    // Close child to settle
    closeCb?.(0);
    await Promise.resolve();
    await shutdownPromise;
    expect(getActiveExecChildrenCount()).toBe(0);
  });

  it("shutdown handler resolves early if child closes before deadline", async () => {
    vi.useFakeTimers();
    let closeCb: ((code: number) => void) | undefined;
    const proc = {
      kill: vi.fn(),
      on: vi.fn((event: string, cb: any) => {
        if (event === "close") closeCb = cb;
        return proc;
      }),
    };
    mockSpawn.mockImplementationOnce(() => proc as any);

    cfg.pipeline.exec = [{ script: "scripts/server.ts", timeout: 0 }];
    void runExecPhase("pre");

    const shutdownPromise = execShutdownHandler();
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");

    // Child closes at 50ms
    vi.advanceTimersByTime(50);
    closeCb?.(0);

    await shutdownPromise;
    expect(proc.kill).toHaveBeenCalledTimes(1); // No SIGKILL needed
  });

  it("executes options.clock injection when provided", async () => {
    let clockNow = 1000;
    const timeouts = new Map<number, { cb: () => void; delay: number }>();
    let nextId = 1;

    const customClock: FrameworkClock = {
      now: () => clockNow,
      setTimeout: (cb, delay) => {
        const id = nextId++;
        timeouts.set(id, { cb, delay });
        return id as any;
      },
      clearTimeout: (handle) => {
        timeouts.delete(handle as any);
      },
      setInterval: () => 0 as any,
      clearInterval: () => { },
    };

    const proc = {
      kill: vi.fn(),
      on: vi.fn(() => {
        return proc;
      }),
    };
    mockSpawn.mockImplementationOnce(() => proc as any);

    cfg.pipeline.exec = [{ script: "scripts/custom-clock.ts", timeout: 2000 }];
    const promise = runExecPhase("pre", { clock: customClock });

    expect(timeouts.size).toBe(1);
    const timeoutEntry = Array.from(timeouts.values())[0];
    expect(timeoutEntry.delay).toBe(2000);

    // Fire timeout on custom clock
    timeoutEntry.cb();
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(promise).rejects.toThrow(/timed out after 2000ms/);
  });
});
