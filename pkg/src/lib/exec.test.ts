import { resolve } from "node:path";
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
  const mockRegisterShutdownHandler = vi.fn(
    (fn: () => void | Promise<void>) => {
      registeredShutdownHandlers.push(fn);
    },
  );

  const resetMocks = () => {
    nextExitCode = 0;
    mockSpawn.mockReset().mockImplementation(makeProcess);
    mockWatch.mockReset().mockImplementation(makeWatcher);
    mockEventEmit.mockReset();
    mockRegisterShutdownHandler
      .mockReset()
      .mockImplementation((fn: () => void | Promise<void>) => {
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

const { mockSpawnSync } = vi.hoisted(() => ({ mockSpawnSync: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
  spawnSync: mockSpawnSync,
}));
vi.mock("chokidar", () => ({ default: { watch: mockWatch } }));
vi.mock("./events.js", () => ({
  eventEmitter: { emit: mockEventEmit },
  registerShutdownHandler: mockRegisterShutdownHandler,
  runShutdownHandlers: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./config.js", () => ({
  BascikConfig: {
    pipeline: { exec: undefined },
    directory: { out: undefined, pages: undefined, components: undefined },
  },
}));

import { BascikConfig } from "./config.ts";
import {
  runScript,
  runExecPhase,
  startExecParallel,
  startExecDev,
  execShutdownHandler,
  getActiveExecChildrenCount,
  resetActiveExecChildrenForTests,
} from "./exec.ts";
import { type FrameworkClock } from "./clock.ts";
import { stopBeforeExit } from "./exit-stoppers.ts";

const cfg = BascikConfig as {
  pipeline: { exec: typeof BascikConfig.pipeline.exec };
  directory: { out?: string; pages?: string; components?: string[] };
};

beforeEach(() => {
  resetMocks();
  // `ps` lists nothing unless a test says otherwise.
  mockSpawnSync.mockReset().mockReturnValue({ status: 1, stdout: "" });
  resetActiveExecChildrenForTests();
  cfg.pipeline.exec = undefined;
  cfg.directory = { out: undefined, pages: undefined, components: undefined };
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
    expect(mockSpawn).toHaveBeenNthCalledWith(
      1,
      process.execPath,
      [resolve(process.cwd(), "scripts/pre.ts")],
      expect.anything(),
    );
    expect(mockSpawn).toHaveBeenNthCalledWith(
      2,
      process.execPath,
      [resolve(process.cwd(), "scripts/pre2.ts")],
      expect.anything(),
    );
  });

  it("defaults undefined phase to pre", async () => {
    cfg.pipeline.exec = [{ script: "scripts/default.ts" }];
    const result = await runExecPhase("pre");
    expect(result.count).toBe(1);
  });

  describe("(started) and (completed) lines", () => {
    const printed = (spy: { mock: { calls: unknown[][] } }): string[] =>
      spy.mock.calls.map((call) => String(call[0]));
    const withLevel = (level: string | undefined) => {
      (cfg as unknown as { logging?: { level?: string } }).logging =
        level === undefined ? undefined : { level };
    };
    afterEach(() => withLevel(undefined));

    it("prints both at the default level", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      cfg.pipeline.exec = [{ script: "scripts/a.ts", phase: "pre" }];
      await runExecPhase("pre");
      const lines = printed(log);
      expect(
        lines.some(
          (l) => l.includes("(started)") && l.includes("scripts/a.ts"),
        ),
      ).toBe(true);
      expect(
        lines.some(
          (l) => l.includes("(completed)") && l.includes("scripts/a.ts"),
        ),
      ).toBe(true);
    });

    it.each(["warn", "error", "silent"])(
      "prints neither at %s, which is what --quiet selects",
      async (level) => {
        withLevel(level);
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        cfg.pipeline.exec = [{ script: "scripts/a.ts", phase: "pre" }];
        await runExecPhase("pre");
        expect(printed(log).filter((l) => l.includes("exec:"))).toEqual([]);
      },
    );

    it("still runs the script and still reports a failure when the lines are hidden", async () => {
      withLevel("warn");
      vi.spyOn(console, "log").mockImplementation(() => {});
      setNextExitCode(1);
      cfg.pipeline.exec = [{ script: "scripts/fail.ts", phase: "pre" }];
      await expect(runExecPhase("pre")).rejects.toThrow(
        'exec "scripts/fail.ts" exited with code 1',
      );
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects when a script exits non-zero", async () => {
    setNextExitCode(1);
    cfg.pipeline.exec = [{ script: "scripts/fail.ts", phase: "pre" }];
    await expect(runExecPhase("pre")).rejects.toThrow(
      'exec "scripts/fail.ts" exited with code 1',
    );
  });
});

describe("startExecParallel", () => {
  it("observes an early joined rejection before lazy dev startup registers task reporting", async () => {
    cfg.pipeline.exec = [
      { script: "scripts/early-failure.ts", phase: "parallel" },
    ];
    setNextExitCode(1);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = startExecParallel();
    // Model a lazy module import yielding an event-loop turn before startExecDev.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await startExecDev({ parallel: handle });
    await expect(handle).rejects.toThrow("early-failure.ts");
    await Promise.resolve();
    expect(mockEventEmit).toHaveBeenCalledWith(
      "exec-failed",
      expect.objectContaining({ entry: cfg.pipeline.exec[0] }),
    );
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
    expect(handle.tasks.map((task) => task.entry.script)).toEqual([
      "scripts/par1.ts",
      "scripts/par2.ts",
    ]);
    // The joined promise still resolves for the build branch's awaited join.
    await expect(handle).resolves.toBeUndefined();
    await expect(
      Promise.all(handle.tasks.map((task) => task.promise)),
    ).resolves.toHaveLength(2);
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
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let failFirst!: (error: Error) => void;
    let failSecond!: (error: Error) => void;
    const tasks = [
      {
        entry: { script: "first.ts", phase: "parallel" as const },
        promise: new Promise<number>((_resolve, reject) => {
          failFirst = reject;
        }),
      },
      {
        entry: { script: "second.ts", phase: "parallel" as const },
        promise: new Promise<number>((_resolve, reject) => {
          failSecond = reject;
        }),
      },
    ];
    const parallel = Object.assign(
      Promise.all(tasks.map((task) => task.promise)).then(() => undefined),
      { tasks },
    );
    await startExecDev({ parallel });
    failFirst(new Error("first failure"));
    await parallel.catch(() => {});
    failSecond(new Error("second failure"));
    await Promise.allSettled(tasks.map((task) => task.promise));
    await Promise.resolve();
    expect(
      mockEventEmit.mock.calls
        .filter(([name]) => name === "exec-failed")
        .map(([, payload]) => payload.entry.script),
    ).toEqual(["first.ts", "second.ts"]);
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
    const completed = mockEventEmit.mock.calls.filter(
      ([name]) => name === "exec-completed",
    );
    expect(completed).toHaveLength(2);
    // Registration does not rerun the already-started parallel work.
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("emits exec-failed (and never exec-completed) when a parallel task rejects, without throwing", async () => {
    cfg.pipeline.exec = [{ script: "scripts/fail.ts", phase: "parallel" }];
    setNextExitCode(1);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const handle = startExecParallel();
    await expect(startExecDev({ parallel: handle })).resolves.toBeUndefined();
    await handle.catch(() => {});
    await Promise.resolve();

    expect(mockEventEmit).toHaveBeenCalledWith(
      "exec-failed",
      expect.objectContaining({
        entry: { script: "scripts/fail.ts", phase: "parallel" },
        paths: [],
        error: expect.any(Error),
      }),
    );
    expect(mockEventEmit).not.toHaveBeenCalledWith(
      "exec-completed",
      expect.anything(),
    );
    // One failure prints exactly one stderr line; exec-failed only feeds the
    // SSE build-error overlay, which does not log.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "[bascik] exec error:",
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it("stops the dev session when a parallel script fails and pipeline.onExecError is 'error'", async () => {
    cfg.pipeline.exec = [{ script: "scripts/fail.ts", phase: "parallel" }];
    (cfg.pipeline as any).onExecError = "error";
    setNextExitCode(1);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    try {
      const handle = startExecParallel();
      await startExecDev({ parallel: handle });
      await handle.catch(() => {});
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
      // One report: the stop message, not a stack-trace line before it.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0][0])).toContain(
        "Stopping because pipeline.onExecError is 'error'",
      );
    } finally {
      delete (cfg.pipeline as any).onExecError;
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("keeps the dev session running on a parallel failure by default", async () => {
    cfg.pipeline.exec = [{ script: "scripts/fail.ts", phase: "parallel" }];
    setNextExitCode(1);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const handle = startExecParallel();
    await startExecDev({ parallel: handle });
    await handle.catch(() => {});
    await Promise.resolve();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
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
  it("serializes a watched rerun behind the same entry still running at startup", async () => {
    const closes: ((code: number) => void)[] = [];
    mockSpawn.mockImplementation(() => {
      const child = {
        kill: vi.fn(),
        on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
          if (event === "close") closes.push((code) => callback(code));
          return child;
        }),
        emitEvent: (_event: string, ..._args: unknown[]) => {},
      };
      return child;
    });
    const entry = {
      script: "scripts/parallel.ts",
      phase: "parallel" as const,
      watch: ["content/"],
    };
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
      [resolve(process.cwd(), "scripts/build.ts"), "--format", "json"],
      expect.objectContaining({
        cwd: resolve(process.cwd(), "custom-dir"),
        env: expect.objectContaining({
          CUSTOM_VAR: "custom_val",
          BASCIK_BASE: "/",
          BASCIK_PAGES_DIR: expect.any(String),
          BASCIK_OUT_DIR: expect.any(String),
        }),
      }),
    );
  });

  it.each([
    {
      label: "default dist",
      configuredOut: undefined,
      expectedOut: resolve(process.cwd(), "dist"),
    },
    {
      label: "relative path",
      configuredOut: "custom-output",
      expectedOut: resolve(process.cwd(), "custom-output"),
    },
    {
      label: "absolute path",
      configuredOut: resolve(process.cwd(), "abs-output"),
      expectedOut: resolve(process.cwd(), "abs-output"),
    },
  ])(
    "resolves BASCIK_OUT_DIR with $label ($configuredOut)",
    async ({ configuredOut, expectedOut }) => {
      cfg.directory.out = configuredOut;
      cfg.pipeline.exec = [{ script: "scripts/test-out.ts" }];
      await runExecPhase("pre");

      expect(mockSpawn).toHaveBeenCalledWith(
        process.execPath,
        [resolve(process.cwd(), "scripts/test-out.ts")],
        expect.objectContaining({
          env: expect.objectContaining({
            BASCIK_OUT_DIR: expectedOut,
          }),
        }),
      );
    },
  );

  it("resolves BASCIK_OUT_DIR to project root output even when exec entry specifies a custom cwd", async () => {
    cfg.directory.out = "custom-output";
    cfg.pipeline.exec = [{ script: "scripts/test-out.ts", cwd: "sub-package" }];
    await runExecPhase("pre");

    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      [resolve(process.cwd(), "scripts/test-out.ts")],
      expect.objectContaining({
        cwd: resolve(process.cwd(), "sub-package"),
        env: expect.objectContaining({
          BASCIK_OUT_DIR: resolve(process.cwd(), "custom-output"),
        }),
      }),
    );
  });

  it("resolves a relative script from the project root, not from the entry's cwd", async () => {
    // Config validation and the docs resolve `script` from the project root;
    // `cwd` is only the child's working directory.
    cfg.pipeline.exec = [{ script: "scripts/sync.ts", cwd: "packages/site" }];
    await runExecPhase("pre");

    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      [resolve(process.cwd(), "scripts/sync.ts")],
      expect.objectContaining({
        cwd: resolve(process.cwd(), "packages/site"),
      }),
    );
  });

  it("keeps an absolute script path as written when cwd is set", async () => {
    const absolute = resolve(process.cwd(), "elsewhere", "gen.ts");
    cfg.pipeline.exec = [{ script: absolute, cwd: "packages/site" }];
    await runExecPhase("pre");

    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      [absolute],
      expect.anything(),
    );
  });

  it("names the missing working directory instead of the Node binary when cwd does not exist", async () => {
    const proc = {
      kill: vi.fn(),
      on: vi.fn((event: string, cb: any) => {
        if (event === "error") {
          const err = Object.assign(
            new Error(`spawn ${process.execPath} ENOENT`),
            { code: "ENOENT" },
          );
          Promise.resolve().then(() => cb(err));
        }
        return proc;
      }),
    };
    mockSpawn.mockImplementationOnce(() => proc as any);
    cfg.pipeline.exec = [
      { script: "scripts/sync.ts", cwd: "packagez/site-typo-dir" },
    ];

    const rejection = runExecPhase("pre");
    await expect(rejection).rejects.toThrow(
      /exec "scripts\/sync\.ts": working directory "packagez\/site-typo-dir" does not exist/,
    );
    await expect(rejection).rejects.not.toThrow(/spawn .* ENOENT/);
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

    // At timeout (1000ms): SIGTERM fired. The promise waits for the child
    // to exit, so the next phase never overlaps a dying script.
    let settled = false;
    void promise.then(
      () => (settled = true),
      () => (settled = true),
    );
    vi.advanceTimersByTime(1);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    await Promise.resolve();
    expect(settled).toBe(false);

    // 499ms after SIGTERM: SIGKILL not yet fired
    vi.advanceTimersByTime(499);
    expect(proc.kill).toHaveBeenCalledTimes(1);

    // 500ms after SIGTERM: SIGKILL fired
    vi.advanceTimersByTime(1);
    expect(proc.kill).toHaveBeenCalledTimes(2);
    expect(proc.kill).toHaveBeenLastCalledWith("SIGKILL");

    // A child that never reports close after SIGKILL is given up on 500ms later.
    vi.advanceTimersByTime(500);
    await expect(promise).rejects.toThrow(/timed out after 1000ms/);
  });

  it.skipIf(process.platform === "win32")(
    "re-checks the listed descendants before SIGKILL, so a reused pid is left alone",
    async () => {
      vi.useFakeTimers();
      const proc = { pid: 4242, kill: vi.fn(), on: vi.fn(() => proc) };
      mockSpawn.mockImplementationOnce(() => proc as any);
      // At SIGTERM: the script started 5001 (a watcher) and 5001 started 5002.
      mockSpawnSync.mockReturnValueOnce({
        status: 0,
        stdout: [
          "4242 1 Fri Oct 30 10:00:00 2026",
          "5001 4242 Fri Oct 30 10:00:01 2026",
          "5002 5001 Fri Oct 30 10:00:02 2026",
        ].join("\n"),
      });
      // At SIGKILL: 5001 ignored SIGTERM and was re-parented when its parent
      // died; 5002 exited and its pid now belongs to an unrelated program.
      mockSpawnSync.mockReturnValueOnce({
        status: 0,
        stdout: [
          "4242 1 Fri Oct 30 10:00:00 2026",
          "5001 1 Fri Oct 30 10:00:01 2026",
          "5002 77 Fri Oct 30 10:00:03 2026",
        ].join("\n"),
      });
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

      cfg.pipeline.exec = [{ script: "scripts/long.ts", timeout: 1000 }];
      const promise = runExecPhase("pre");
      void promise.catch(() => undefined);

      vi.advanceTimersByTime(1000);
      expect(kill.mock.calls).toEqual([
        [5001, "SIGTERM"],
        [5002, "SIGTERM"],
      ]);
      expect(proc.kill).toHaveBeenLastCalledWith("SIGTERM");

      kill.mockClear();
      vi.advanceTimersByTime(500);
      expect(kill.mock.calls).toEqual([[5001, "SIGKILL"]]);
      expect(proc.kill).toHaveBeenLastCalledWith("SIGKILL");

      vi.advanceTimersByTime(500);
      await expect(promise).rejects.toThrow(/timed out after 1000ms/);
    },
  );

  it.skipIf(process.platform === "win32")(
    "signals no listed descendant with SIGKILL when ps cannot confirm them",
    async () => {
      vi.useFakeTimers();
      const proc = { pid: 4242, kill: vi.fn(), on: vi.fn(() => proc) };
      mockSpawn.mockImplementationOnce(() => proc as any);
      mockSpawnSync.mockReturnValueOnce({
        status: 0,
        stdout: "5001 4242 Fri Oct 30 10:00:01 2026",
      });
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

      cfg.pipeline.exec = [{ script: "scripts/long.ts", timeout: 1000 }];
      const promise = runExecPhase("pre");
      void promise.catch(() => undefined);

      vi.advanceTimersByTime(1000);
      expect(kill.mock.calls).toEqual([[5001, "SIGTERM"]]);
      kill.mockClear();
      vi.advanceTimersByTime(500);
      expect(kill).not.toHaveBeenCalled();
      expect(proc.kill).toHaveBeenLastCalledWith("SIGKILL");
      vi.advanceTimersByTime(500);
      await expect(promise).rejects.toThrow(/timed out after 1000ms/);
    },
  );

  it.skipIf(process.platform === "win32")(
    "SIGKILLs a started process still running after the timed-out script exited",
    async () => {
      vi.useFakeTimers();
      let closeCb: ((code: number) => void) | undefined;
      const proc = {
        pid: 4242,
        kill: vi.fn(),
        on: vi.fn((event: string, cb: any) => {
          if (event === "close") closeCb = cb;
          return proc;
        }),
      };
      mockSpawn.mockImplementationOnce(() => proc as any);
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: "5001 4242 Fri Oct 30 10:00:01 2026",
      });
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

      cfg.pipeline.exec = [{ script: "scripts/long.ts", timeout: 1000 }];
      const promise = runExecPhase("pre");
      void promise.catch(() => undefined);
      vi.advanceTimersByTime(1000);
      expect(kill.mock.calls).toEqual([[5001, "SIGTERM"]]);

      // The script exits on SIGTERM; the run settles at once, and the process
      // it started, which ignored SIGTERM, is killed 500 ms later.
      closeCb!(143);
      await expect(promise).rejects.toThrow(/timed out after 1000ms/);
      kill.mockClear();
      vi.advanceTimersByTime(499);
      expect(kill).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(kill.mock.calls).toEqual([[5001, "SIGKILL"]]);
      expect(proc.kill).not.toHaveBeenCalledWith("SIGKILL");
    },
  );

  describe.skipIf(process.platform === "win32")(
    "a ps with no start times (BusyBox `ps -o pid,ppid`)",
    () => {
      /** BusyBox `ps` rejects `-A` and `lstart`; it prints a header and every process. */
      let psTable: string[] = [];
      beforeEach(() => {
        psTable = [];
        mockSpawnSync.mockImplementation((_cmd: string, args: string[]) =>
          args.includes("-A") || args.some((arg) => arg.includes("lstart"))
            ? { status: 1, stdout: "" }
            : { status: 0, stdout: ["  PID  PPID", ...psTable].join("\n") },
        );
      });

      it("never SIGKILLs a pid that now belongs to another program, and says so once", async () => {
        vi.useFakeTimers();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const proc = { pid: 4242, kill: vi.fn(), on: vi.fn(() => proc) };
        mockSpawn.mockImplementationOnce(() => proc as any);
        // At SIGTERM: the script started 5001 (a watcher) and 5001 started 5002.
        psTable = ["4242 1", "5001 4242", "5002 5001"];
        const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

        cfg.pipeline.exec = [{ script: "scripts/long.ts", timeout: 1000 }];
        const promise = runExecPhase("pre");
        void promise.catch(() => undefined);
        vi.advanceTimersByTime(1000);
        expect(kill.mock.calls).toEqual([
          [5001, "SIGTERM"],
          [5002, "SIGTERM"],
        ]);

        // At SIGKILL: 5001 ignored SIGTERM and is still the script's child;
        // 5002 exited and its pid now belongs to an unrelated program. With
        // no start time the two look alike by pid alone.
        psTable = ["4242 1", "5001 4242", "5002 77"];
        kill.mockClear();
        vi.advanceTimersByTime(500);
        expect(kill.mock.calls).toEqual([[5001, "SIGKILL"]]);
        expect(proc.kill).toHaveBeenLastCalledWith("SIGKILL");
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toMatch(
          /exec "scripts\/long\.ts".*no process start times.*5002/s,
        );

        vi.advanceTimersByTime(500);
        await expect(promise).rejects.toThrow(/timed out after 1000ms/);
      });

      it("leaves a re-parented process alone without a start time to confirm it", async () => {
        vi.useFakeTimers();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        let closeCb: ((code: number) => void) | undefined;
        const proc = {
          pid: 4242,
          kill: vi.fn(),
          on: vi.fn((event: string, cb: any) => {
            if (event === "close") closeCb = cb;
            return proc;
          }),
        };
        mockSpawn.mockImplementationOnce(() => proc as any);
        psTable = ["4242 1", "5001 4242"];
        const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

        cfg.pipeline.exec = [{ script: "scripts/long.ts", timeout: 1000 }];
        const promise = runExecPhase("pre");
        void promise.catch(() => undefined);
        vi.advanceTimersByTime(1000);
        expect(kill.mock.calls).toEqual([[5001, "SIGTERM"]]);

        // The script exits on SIGTERM. 5001 is re-parented to init, or its
        // pid was reused by a program init started: ps cannot tell which.
        closeCb!(143);
        await expect(promise).rejects.toThrow(/timed out after 1000ms/);
        psTable = ["5001 1"];
        kill.mockClear();
        vi.advanceTimersByTime(500);
        expect(kill).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toMatch(/5001/);

        // A second run that hits the same limit does not warn again.
        mockSpawn.mockImplementationOnce(() => proc as any);
        psTable = ["4242 1", "6001 4242"];
        const again = runExecPhase("pre");
        void again.catch(() => undefined);
        vi.advanceTimersByTime(1000);
        closeCb!(143);
        await expect(again).rejects.toThrow(/timed out after 1000ms/);
        psTable = ["6001 1"];
        vi.advanceTimersByTime(500);
        expect(kill.mock.calls).toEqual([[6001, "SIGTERM"]]);
        expect(warn).toHaveBeenCalledTimes(1);
      });

      it("on exit, SIGKILLs a started process whose parent chain to the running script is unchanged", async () => {
        vi.useFakeTimers();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const proc = {
          pid: 4242,
          kill: vi.fn(),
          on: vi.fn(() => proc),
          once: vi.fn(() => proc),
          removeListener: vi.fn(),
        };
        mockSpawn.mockImplementationOnce(() => proc as any);
        psTable = ["4242 1", "5001 4242", "5002 5001"];
        const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
        cfg.pipeline.exec = [
          { script: "scripts/css-watch.ts", phase: "parallel", timeout: 0 },
        ];
        void startExecParallel().catch(() => undefined);

        const stopping = execShutdownHandler();
        expect(kill.mock.calls).toEqual([
          [5001, "SIGTERM"],
          [5002, "SIGTERM"],
        ]);
        // Nothing exited: the script, 5001 and 5002 all ignored SIGTERM.
        kill.mockClear();
        vi.advanceTimersByTime(200);
        await stopping;
        expect(kill.mock.calls).toEqual([
          [5001, "SIGKILL"],
          [5002, "SIGKILL"],
        ]);
        expect(proc.kill).toHaveBeenLastCalledWith("SIGKILL");
        expect(warn).not.toHaveBeenCalled();
      });
    },
  );

  describe("on Windows (taskkill)", () => {
    const realPlatform = process.platform;
    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "win32" });
    });
    afterEach(() => {
      Object.defineProperty(process, "platform", { value: realPlatform });
    });

    it("ends the whole tree with taskkill, passing the pid as its own argument", async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockSpawnSync.mockReturnValue({ status: 0, stdout: "" });
      const proc = { pid: 4242, kill: vi.fn(), on: vi.fn(() => proc) };
      mockSpawn.mockImplementationOnce(() => proc as any);

      cfg.pipeline.exec = [{ script: "scripts/long.ts", timeout: 1000 }];
      const promise = runExecPhase("pre");
      void promise.catch(() => undefined);
      vi.advanceTimersByTime(1000);
      expect(mockSpawnSync).toHaveBeenCalledTimes(1);
      const [command, args, options] = mockSpawnSync.mock.calls[0];
      expect(command).toBe("taskkill");
      expect(args).toEqual(["/pid", "4242", "/T", "/F"]);
      expect(options).not.toHaveProperty("shell");
      expect(proc.kill).toHaveBeenLastCalledWith("SIGTERM");
      vi.advanceTimersByTime(1000);
      await expect(promise).rejects.toThrow(/timed out after 1000ms/);
      expect(warn).not.toHaveBeenCalled();
    });

    it("warns once and still stops the script when taskkill cannot run", async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockSpawnSync.mockReturnValue({
        status: null,
        stdout: null,
        error: Object.assign(new Error("spawnSync taskkill ENOENT"), {
          code: "ENOENT",
        }),
      });
      const proc = { pid: 4242, kill: vi.fn(), on: vi.fn(() => proc) };
      mockSpawn.mockImplementationOnce(() => proc as any);

      cfg.pipeline.exec = [{ script: "scripts/long.ts", timeout: 1000 }];
      const promise = runExecPhase("pre");
      void promise.catch(() => undefined);
      vi.advanceTimersByTime(1000);
      expect(proc.kill).toHaveBeenLastCalledWith("SIGTERM");
      vi.advanceTimersByTime(500);
      expect(proc.kill).toHaveBeenLastCalledWith("SIGKILL");
      vi.advanceTimersByTime(500);
      await expect(promise).rejects.toThrow(/timed out after 1000ms/);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(
        /exec "scripts\/long\.ts": could not run taskkill.*ENOENT.*processes it started may still be running/s,
      );
    });

    it("does not crash when taskkill throws, and stays quiet when the pid is already gone", async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // taskkill exits 128 when the process no longer exists.
      mockSpawnSync.mockReturnValueOnce({ status: 128, stdout: "" });
      mockSpawnSync.mockImplementationOnce(() => {
        throw new Error("EPERM");
      });
      const proc = { pid: 4242, kill: vi.fn(), on: vi.fn(() => proc) };
      mockSpawn.mockImplementationOnce(() => proc as any);

      cfg.pipeline.exec = [{ script: "scripts/long.ts", timeout: 1000 }];
      const promise = runExecPhase("pre");
      void promise.catch(() => undefined);
      vi.advanceTimersByTime(1000);
      vi.advanceTimersByTime(500);
      expect(proc.kill).toHaveBeenLastCalledWith("SIGKILL");
      vi.advanceTimersByTime(500);
      await expect(promise).rejects.toThrow(/timed out after 1000ms/);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/taskkill.*EPERM/s);
    });

    it("never runs taskkill on the pid of a script that has already exited", async () => {
      vi.useFakeTimers();
      mockSpawnSync.mockReturnValue({ status: 0, stdout: "" });
      const proc = {
        pid: 4242,
        exitCode: null as number | null,
        kill: vi.fn(),
        on: vi.fn(() => proc),
      };
      mockSpawn.mockImplementationOnce(() => proc as any);

      cfg.pipeline.exec = [{ script: "scripts/long.ts", timeout: 1000 }];
      const promise = runExecPhase("pre");
      void promise.catch(() => undefined);
      vi.advanceTimersByTime(1000);
      expect(mockSpawnSync).toHaveBeenCalledTimes(1);
      // The script exited (Node reaped it) but has not reported close yet:
      // its pid may already name another program's tree.
      proc.exitCode = 1;
      vi.advanceTimersByTime(500);
      expect(mockSpawnSync).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(500);
      await expect(promise).rejects.toThrow(/timed out after 1000ms/);
    });
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

    // Child closes 200ms into escalation; the timeout is reported then
    vi.advanceTimersByTime(200);
    closeCb?.(0);
    await expect(promise).rejects.toThrow(/timed out after 1000ms/);

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

  it("stops running exec children on every exit path, not only graceful shutdown", async () => {
    // exitAfterStopping (CLI failure exits, a dev bind failure, the crash
    // net) runs only the exit stoppers before process.exit.
    expect(stopBeforeExit()).toBeNull();

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
    cfg.pipeline.exec = [
      { script: "scripts/css-watch.ts", phase: "parallel", timeout: 0 },
    ];
    void startExecParallel();
    expect(getActiveExecChildrenCount()).toBe(1);

    const stopping = stopBeforeExit();
    expect(stopping).not.toBeNull();
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    closeCb?.(0);
    await stopping;
    expect(getActiveExecChildrenCount()).toBe(0);
  });

  it.skipIf(process.platform === "win32")(
    "on exit, SIGKILLs a started process that outlived its script's SIGTERM",
    async () => {
      vi.useFakeTimers();
      let closeCb: ((code: number) => void) | undefined;
      const proc = {
        pid: 4242,
        kill: vi.fn(),
        on: vi.fn((event: string, cb: any) => {
          if (event === "close") closeCb = cb;
          return proc;
        }),
        once: vi.fn((event: string, cb: any) => {
          if (event === "close") closeCb = cb;
          return proc;
        }),
        removeListener: vi.fn(),
      };
      mockSpawn.mockImplementationOnce(() => proc as any);
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: "5001 4242 Fri Oct 30 10:00:01 2026",
      });
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      cfg.pipeline.exec = [
        { script: "scripts/css-watch.ts", phase: "parallel", timeout: 0 },
      ];
      void startExecParallel().catch(() => undefined);

      const stopping = stopBeforeExit();
      expect(kill.mock.calls).toEqual([[5001, "SIGTERM"]]);
      // The script exits on SIGTERM; the watcher it started ignores it. The
      // stop is not done until SIGKILL has reached the watcher.
      let done = false;
      void stopping!.then(() => (done = true));
      closeCb!(0);
      await Promise.resolve();
      expect(done).toBe(false);
      kill.mockClear();
      vi.advanceTimersByTime(200);
      await stopping;
      expect(kill.mock.calls).toEqual([[5001, "SIGKILL"]]);
      expect(getActiveExecChildrenCount()).toBe(0);
    },
  );

  it.skipIf(process.platform === "win32")(
    "an exit right after a timeout SIGKILLs what the timed-out script left at once",
    async () => {
      vi.useFakeTimers();
      let closeCb: ((code: number) => void) | undefined;
      const proc = {
        pid: 4242,
        kill: vi.fn(),
        on: vi.fn((event: string, cb: any) => {
          if (event === "close") closeCb = cb;
          return proc;
        }),
      };
      mockSpawn.mockImplementationOnce(() => proc as any);
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: "5001 4242 Fri Oct 30 10:00:01 2026",
      });
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      cfg.pipeline.exec = [{ script: "scripts/long.ts", timeout: 1000 }];
      const promise = runExecPhase("pre");
      void promise.catch(() => undefined);
      vi.advanceTimersByTime(1000);
      closeCb!(143);
      await expect(promise).rejects.toThrow(/timed out after 1000ms/);
      expect(getActiveExecChildrenCount()).toBe(0);

      // A failed build exits now, before the 500 ms leftover timer.
      kill.mockClear();
      const stopping = stopBeforeExit();
      expect(stopping).not.toBeNull();
      await stopping;
      expect(kill.mock.calls).toEqual([[5001, "SIGKILL"]]);
      expect(stopBeforeExit()).toBeNull();
      vi.advanceTimersByTime(500);
      expect(kill.mock.calls).toHaveLength(1);
    },
  );

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
      clearInterval: () => {},
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
    // The child never closes: run the SIGKILL escalation and the grace
    // period on the same injected clock.
    timeouts.delete(Array.from(timeouts.keys())[0]);
    for (let step = 0; step < 2; step++) {
      const [id, next] = Array.from(timeouts.entries())[0];
      expect(next.delay).toBe(500);
      timeouts.delete(id);
      next.cb();
    }
    expect(proc.kill).toHaveBeenLastCalledWith("SIGKILL");
    await expect(promise).rejects.toThrow(/timed out after 2000ms/);
  });
});
