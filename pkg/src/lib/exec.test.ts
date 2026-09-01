import { describe, it, expect, vi, beforeEach } from "vitest";

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

  const makeProcess = () => {
    const proc = {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === "close") {
          Promise.resolve().then(() => cb(nextExitCode));
        }
        return proc;
      }),
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
  const mockRegisterShutdownHandler = vi.fn();

  const resetMocks = () => {
    nextExitCode = 0;
    mockSpawn.mockReset().mockImplementation(makeProcess);
    mockWatch.mockReset().mockImplementation(makeWatcher);
    mockEventEmit.mockReset();
    mockRegisterShutdownHandler.mockReset();
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
import { runExecPhase, startExecParallel, startExecDev } from "./exec.ts";

const cfg = BascikConfig as { pipeline: { exec: typeof BascikConfig.pipeline.exec } };

beforeEach(() => {
  resetMocks();
  cfg.pipeline.exec = undefined;
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

  it("re-runs script and emits asset-changed on watch event", async () => {
    cfg.pipeline.exec = [{ script: "scripts/gen.ts", watch: ["content/"] }];
    await startExecDev();

    const watcher = getWatcher(0);
    watcher.handlers.all();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockEventEmit).toHaveBeenCalledWith("asset-changed");
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
});
