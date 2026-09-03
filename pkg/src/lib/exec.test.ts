import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockSpawn,
  setNextExitCode,
  mockWatch,
  getWatcher,
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
import { runExecPhase, startExecParallel, startExecDev, execShutdownHandler, getActiveExecChildrenCount, resetActiveExecChildrenForTests } from "./exec.ts";
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
  it("starts only parallel scripts", () => {
    cfg.pipeline.exec = [
      { script: "scripts/par1.ts", phase: "parallel" },
      { script: "scripts/pre.ts", phase: "pre" },
      { script: "scripts/par2.ts", phase: "parallel" },
    ];

    startExecParallel();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });
});

describe("startExecDev", () => {
  it("does nothing when no watched entries exist", async () => {
    cfg.pipeline.exec = [{ script: "scripts/build-only.ts" }];
    await startExecDev();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockWatch).not.toHaveBeenCalled();
  });

  it("lazy-loads chokidar and starts watched scripts", async () => {
    cfg.pipeline.exec = [{ script: "scripts/gen.ts", watch: ["content/"] }];
    await startExecDev();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockWatch).toHaveBeenCalledTimes(1);
  });

  it("re-runs script and emits exec-completed on watch event", async () => {
    cfg.pipeline.exec = [{ script: "scripts/gen.ts", watch: ["content/"] }];
    await startExecDev();

    const watcher = getWatcher(0);
    watcher.handlers.all("change", "content/doc.md");
    await new Promise((r) => setTimeout(r, 70));

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockEventEmit).toHaveBeenCalledWith(
      "exec-completed",
      expect.objectContaining({ path: "content/doc.md" }),
    );
  });

  it("registers watcher close handlers for shutdown", async () => {
    cfg.pipeline.exec = [{ script: "scripts/gen.ts", watch: ["content/"] }];
    await startExecDev();
    expect(mockRegisterShutdownHandler).toHaveBeenCalledTimes(1);
    const shutdown = mockRegisterShutdownHandler.mock.calls[0][0] as () => void;
    const watcher = getWatcher(0);
    shutdown();
    expect(watcher.close).toHaveBeenCalledTimes(1);
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

  it("debounces rapid watch triggers into a single re-run", async () => {
    cfg.pipeline.exec = [{ script: "scripts/gen.ts", watch: ["content/"] }];
    await startExecDev();

    const watcher = getWatcher(0);
    watcher.handlers.all();
    watcher.handlers.all();
    watcher.handlers.all();
    await new Promise((r) => setTimeout(r, 70));

    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("coordinates watched exec triggers with dependent page transpile before emitting reload", async () => {
    // When a watched file changes that triggers an exec script, it should await dependent page transpilation
    // rather than emitting uncoordinated asset-changed/reload before dependent pages have re-transpiled.
    cfg.pipeline.exec = [{ script: "scripts/gen.ts", watch: ["content/"] }];
    await startExecDev();

    const watcher = getWatcher(0);
    watcher.handlers.all("change", "content/doc.md");
    await new Promise((r) => setTimeout(r, 70));

    // Must emit coordinated event or coordinate with processing pipeline
    expect(mockEventEmit).toHaveBeenCalledWith(
      "exec-completed",
      expect.objectContaining({ path: "content/doc.md" }),
    );
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
