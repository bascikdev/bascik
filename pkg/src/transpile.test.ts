import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  _state,
  _mockWatchFiles,
  _mockRunExecPhase,
  _mockStartExecParallel,
  _mockStartExecDev,
  _mockStartServer,
  _mockRm,
  _callOrder,
  _parallel,
} = vi.hoisted(() => {
  const _callOrder: string[] = [];
  const _state: {
    emitFromWatcher?: () => Promise<void>;
    hasPublisherDuringBoot: boolean;
    emitDuringBoot: boolean;
    bootError?: unknown;
    reset(): void;
  } = {
    emitFromWatcher: undefined,
    hasPublisherDuringBoot: false,
    emitDuringBoot: false,
    bootError: undefined,
    reset() {
      this.emitFromWatcher = undefined;
      this.hasPublisherDuringBoot = false;
      this.emitDuringBoot = false;
      this.bootError = undefined;
    },
  };
  // The parallel phase is modeled as work that is still running when the
  // phase runner returns. Its handle settles when the test releases it, so
  // the call order can tell an awaited join apart from a non-awaited start:
  // an implementation that awaits the handle cannot reach `startServer` until
  // "startExecParallel:settled" has been recorded.
  const _parallel: {
    release: () => void;
    settled: Promise<void>;
    handle: Promise<void> & { tasks: unknown[] };
    reset: () => void;
  } = {
    release: () => {},
    settled: Promise.resolve(),
    handle: Object.assign(Promise.resolve(), { tasks: [] as unknown[] }),
    reset: () => {},
  };
  _parallel.reset = () => {
    let resolveSettled: () => void = () => {};
    const joined = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    _parallel.handle = Object.assign(joined, { tasks: [] as unknown[] });
    _parallel.settled = joined.then(() => {
      _callOrder.push("startExecParallel:settled");
    });
    _parallel.release = resolveSettled;
  };
  _parallel.reset();
  return {
    _state,
    _callOrder,
    _parallel,
    _mockWatchFiles: vi
      .fn()
      .mockImplementation(
        async (options?: {
          bootCompile?: (
            compileInitialSources: () => Promise<void>,
          ) => Promise<void>;
        }) => {
          _callOrder.push("watchFiles");
          _state.emitFromWatcher = async () => {
            const compilationEvents =
              await import("./lib/compilation-events.ts");
            compilationEvents.publishTranspiled({
              relativePagePath: "watcher-after-boot.html",
            });
          };
          if (options?.bootCompile) {
            await options.bootCompile(async () => {
              const compilationEvents =
                await import("./lib/compilation-events.ts");
              _state.hasPublisherDuringBoot =
                compilationEvents.hasCompilationPublisher();
              if (_state.emitDuringBoot) {
                compilationEvents.publishTranspiled({
                  relativePagePath: "boot-buffered.html",
                });
              }
              if (_state.bootError) {
                if (
                  compilationEvents.getCompilationPageErrorPolicy() ===
                  "publish"
                ) {
                  eventEmitter.emit("build-error", {
                    message: (_state.bootError as Error).message,
                    file: "/project/src/pages/broken.html",
                  });
                  return;
                }
                throw _state.bootError;
              }
            });
          }
        },
      ),
    _mockRunExecPhase: vi.fn().mockImplementation(async (phase: string) => {
      _callOrder.push(`runExecPhase:${phase}`);
      return { count: 1, totalElapsed: 5 };
    }),
    _mockStartExecParallel: vi.fn().mockImplementation(() => {
      _callOrder.push("startExecParallel");
      return _parallel.handle;
    }),
    _mockStartExecDev: vi.fn().mockImplementation(async () => {
      _callOrder.push("startExecDev");
    }),
    _mockStartServer: vi.fn().mockImplementation(async () => {
      _callOrder.push("startServer");
      return "http://localhost:8080";
    }),
    _mockRm: vi.fn().mockImplementation(async () => {
      _callOrder.push("cleanOutput");
    }),
  };
});

vi.mock("node:fs/promises", () => ({
  rm: _mockRm,
  // Prompt 101: finalizeOwnedArtifacts stages and atomically renames metadata.
  // These reads return empty content (no prior metadata) and writes resolve.
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(""),
}));

vi.mock("./lib/watch.js", () => ({
  watchFiles: _mockWatchFiles,
}));

vi.mock("./lib/exec.js", () => ({
  runExecPhase: _mockRunExecPhase,
  startExecParallel: _mockStartExecParallel,
  startExecDev: _mockStartExecDev,
}));

vi.mock("./lib/server.js", () => ({
  startServer: _mockStartServer,
}));

vi.mock("./lib/mem.js", () => ({
  mem: { setBootingDone: vi.fn() },
}));

vi.mock("./lib/events.js", async () => {
  const { EventEmitter } = await import("node:events");
  return { eventEmitter: new EventEmitter() };
});

vi.mock("./lib/config.js", () => ({
  BascikConfig: {
    isBuild: false,
    directory: { out: "dist" },
    pipeline: { exec: undefined },
  },
}));

import { runTranspile } from "./transpile.ts";
import { BascikConfig } from "./lib/config.ts";
import { mem } from "./lib/mem.ts";
import { eventEmitter } from "./lib/events.ts";
import {
  PageProcessingAggregateError,
  PageProcessingError,
} from "./lib/processing.ts";

describe("runTranspile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _callOrder.length = 0;
    _parallel.reset();
    _state.reset();
    (BascikConfig as any).directory.out = "dist";
  });

  it("compiles alongside parallel exec and joins before declaring build success", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    (BascikConfig as any).isBuild = true;
    const run = runTranspile();
    try {
      await vi.waitFor(() => expect(_mockWatchFiles).toHaveBeenCalled(), {
        timeout: 250,
      });
      expect(logSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("Build complete"),
      );
    } finally {
      _parallel.release();
      await run;
    }

    expect(_mockRunExecPhase).toHaveBeenCalledWith("pre");
    expect(_mockStartExecParallel).toHaveBeenCalled();
    expect(_mockWatchFiles).toHaveBeenCalled();
    expect(_mockRunExecPhase).toHaveBeenCalledWith("post");
    expect(_mockStartExecDev).not.toHaveBeenCalled();

    // Post follows compilation, not the parallel join.
    expect(_callOrder).toEqual([
      "cleanOutput",
      "runExecPhase:pre",
      "startExecParallel",
      "watchFiles",
      "runExecPhase:post",
      "startExecParallel:settled",
    ]);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/✓ Build complete in (?:[<]?[\d.]+(?:ms|s))/),
    );
    logSpy.mockRestore();
  });

  // The fallback below waits this long, and the test allows for it.
  const JOIN_FALLBACK_MS = 15_000;
  it(
    "runs dev pipeline awaiting pre exec BEFORE watchFiles, then post after watchFiles",
    async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const emitSpy = vi.spyOn(eventEmitter, "emit");
      (BascikConfig as any).isBuild = false;
      // The parallel handle stays pending until the server has bound. An
      // implementation that awaits the join before `startServer` never gets
      // there, so a fallback releases the handle and lets the ordering
      // assertion below report the defect instead of hanging the test. It
      // must fire only on that defect. With 1 s it once fired in a correct
      // run, during a loaded full-suite run: the steps before `startServer`
      // (the mocked pre phase, importing server-dev.ts) took longer, the
      // parallel work settled first, and the ordering check failed
      // ('expected 3 to be greater than 4'). Alone they take about 10 ms;
      // 15 s is far past any load, and only the join waits that long.
      const fallback = setTimeout(() => _parallel.release(), JOIN_FALLBACK_MS);
      _mockStartServer.mockImplementationOnce(async () => {
        _callOrder.push("startServer");
        _parallel.release();
        return "http://localhost:8080";
      });
      await runTranspile();
      await _parallel.settled;
      clearTimeout(fallback);

      expect(_mockRunExecPhase).toHaveBeenCalledWith("pre");
      expect(_mockStartExecParallel).toHaveBeenCalled();
      expect(_mockStartExecDev).toHaveBeenCalled();
      expect(_mockStartServer).toHaveBeenCalled();
      expect(_mockWatchFiles).toHaveBeenCalled();
      expect(_mockRunExecPhase).toHaveBeenCalledWith("post");
      expect(mem.setBootingDone).toHaveBeenCalledOnce();
      expect(emitSpy).toHaveBeenCalledWith("boot-done");
      emitSpy.mockRestore();

      // Regression check: pre exec is awaited BEFORE watchFiles in dev mode
      const preIndex = _callOrder.indexOf("runExecPhase:pre");
      const watchIndex = _callOrder.indexOf("watchFiles");
      const postIndex = _callOrder.indexOf("runExecPhase:post");

      expect(preIndex).toBeGreaterThanOrEqual(0);
      expect(watchIndex).toBeGreaterThan(preIndex);
      expect(postIndex).toBeGreaterThan(watchIndex);

      // Dev does NOT join the parallel phase before binding the server: the
      // parallel work settles only after `startServer` was reached.
      const serverIndex = _callOrder.indexOf("startServer");
      const parallelSettledIndex = _callOrder.indexOf(
        "startExecParallel:settled",
      );
      expect(serverIndex).toBeGreaterThanOrEqual(0);
      expect(parallelSettledIndex).toBeGreaterThan(serverIndex);
      expect(
        _callOrder.filter((step) => step !== "startExecParallel:settled"),
      ).toEqual([
        "cleanOutput",
        "runExecPhase:pre",
        "startExecParallel",
        "startServer",
        "startExecDev",
        "watchFiles",
        "runExecPhase:post",
      ]);

      // The retained handle is handed to the dev lifecycle owner so each
      // parallel outcome is observed without scheduling compilation.
      expect(_mockStartExecDev).toHaveBeenCalledWith(
        expect.objectContaining({ parallel: _parallel.handle }),
      );

      expect(logSpy).toHaveBeenNthCalledWith(
        1,
        expect.stringMatching(
          /✓ All tasks completed in (?:[<]?[\d.]+(?:ms|s))/,
        ),
      );
      expect(logSpy).toHaveBeenNthCalledWith(
        2,
        "Server running at http://localhost:8080",
      );
      logSpy.mockRestore();
    },
    JOIN_FALLBACK_MS + 15_000,
  );

  it("cleans the output directory before pre exec in dev and build modes", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    for (const isBuild of [false, true]) {
      _callOrder.length = 0;
      _parallel.reset();
      _parallel.release();
      (BascikConfig as any).isBuild = isBuild;
      await runTranspile();

      expect(_callOrder.indexOf("cleanOutput")).toBe(0);
      expect(_callOrder.indexOf("cleanOutput")).toBeLessThan(
        _callOrder.indexOf("runExecPhase:pre"),
      );
    }

    logSpy.mockRestore();
  });

  it("rejects an output directory outside the project root before deleting it", async () => {
    (BascikConfig as any).directory.out = "../outside";

    await expect(runTranspile()).rejects.toThrow(/outside the project root/);
    expect(_mockRm).not.toHaveBeenCalled();
  });

  // A dev server or build already writing the same output directory (a
  // second `bascik` in the project, `bascik --build` beside `bascik`) adds
  // files while the clean removes them: rmdir fails with ENOTEMPTY. The
  // clean must not retry through that, because a retry usually wins and
  // deletes the other process's output under it with no error anywhere.
  it("cleans the output once and never retries through another process writing it", async () => {
    (BascikConfig as any).isBuild = true;
    _parallel.release();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runTranspile();
    } finally {
      logSpy.mockRestore();
    }
    expect(_mockRm).toHaveBeenCalledTimes(1);
    const [, options] = _mockRm.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(options).toEqual({ recursive: true, force: true });
  });

  it("names the output directory and the likely cause when the clean still fails", async () => {
    (BascikConfig as any).isBuild = true;
    _parallel.release();
    const busy = Object.assign(
      new Error("ENOTEMPTY: directory not empty, rmdir '/project/dist'"),
      { code: "ENOTEMPTY" },
    );
    _mockRm.mockRejectedValueOnce(busy);

    const failure = await runTranspile().then(
      () => null,
      (err: unknown) => err as Error & { cause?: unknown },
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).toMatch(/Could not clear the output directory/);
    expect(failure!.message).toMatch(/[\\/]dist\b/);
    expect(failure!.message).toMatch(/another bascik dev server or build/);
    expect(failure!.message).toContain("ENOTEMPTY");
    expect(failure!.cause).toBe(busy);
    expect(_mockRunExecPhase).not.toHaveBeenCalled();
  });

  it("handles server startup error gracefully when exitOnError is false", async () => {
    (BascikConfig as any).isBuild = false;
    _parallel.release();
    _mockStartServer.mockRejectedValueOnce(new Error("Port in use"));

    await expect(runTranspile({ exitOnError: false })).rejects.toThrow(
      "Port in use",
    );
  });

  describe("pipeline.onExecError", () => {
    const failOnce = (phase: "pre" | "post") =>
      _mockRunExecPhase.mockImplementation(async (p: string) => {
        _callOrder.push(`runExecPhase:${p}`);
        if (p === phase) throw new Error(`exec ${phase} failed`);
        return { count: 1, totalElapsed: 5 };
      });
    const restore = () => {
      delete (BascikConfig.pipeline as any).onExecError;
      _mockRunExecPhase.mockImplementation(async (p: string) => {
        _callOrder.push(`runExecPhase:${p}`);
        return { count: 1, totalElapsed: 5 };
      });
    };
    const quiet = () => ({
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
      log: vi.spyOn(console, "log").mockImplementation(() => {}),
    });

    it("dev keeps running when a pre script fails: reports a build-error, still compiles and boots", async () => {
      const spies = quiet();
      const emitSpy = vi.spyOn(eventEmitter, "emit");
      (BascikConfig as any).isBuild = false;
      _parallel.release();
      failOnce("pre");
      try {
        await expect(
          runTranspile({ exitOnError: false }),
        ).resolves.toBeUndefined();
        expect(_mockWatchFiles).toHaveBeenCalled();
        expect(emitSpy).toHaveBeenCalledWith("build-error", {
          message: "exec failed: exec pre failed",
        });
        expect(emitSpy).toHaveBeenCalledWith("boot-done");
        expect(mem.setBootingDone).toHaveBeenCalledOnce();
      } finally {
        restore();
        emitSpy.mockRestore();
        spies.error.mockRestore();
        spies.log.mockRestore();
      }
    });

    it("dev keeps running when a post script fails: reports a build-error and still boots", async () => {
      const spies = quiet();
      const emitSpy = vi.spyOn(eventEmitter, "emit");
      (BascikConfig as any).isBuild = false;
      _parallel.release();
      failOnce("post");
      try {
        await expect(
          runTranspile({ exitOnError: false }),
        ).resolves.toBeUndefined();
        expect(emitSpy).toHaveBeenCalledWith("build-error", {
          message: "exec failed: exec post failed",
        });
        expect(emitSpy).toHaveBeenCalledWith("boot-done");
      } finally {
        restore();
        emitSpy.mockRestore();
        spies.error.mockRestore();
        spies.log.mockRestore();
      }
    });

    it("dev with onExecError 'error' rejects on a pre failure before compiling", async () => {
      const spies = quiet();
      (BascikConfig as any).isBuild = false;
      (BascikConfig.pipeline as any).onExecError = "error";
      failOnce("pre");
      try {
        await expect(runTranspile({ exitOnError: false })).rejects.toThrow(
          "exec pre failed",
        );
        expect(_mockWatchFiles).not.toHaveBeenCalled();
      } finally {
        restore();
        spies.error.mockRestore();
        spies.log.mockRestore();
      }
    });

    it("dev with onExecError 'error' rejects on a post failure and never reports ready", async () => {
      const spies = quiet();
      (BascikConfig as any).isBuild = false;
      (BascikConfig.pipeline as any).onExecError = "error";
      _parallel.release();
      failOnce("post");
      try {
        await expect(runTranspile({ exitOnError: false })).rejects.toThrow(
          "exec post failed",
        );
        expect(mem.setBootingDone).not.toHaveBeenCalled();
      } finally {
        restore();
        spies.error.mockRestore();
        spies.log.mockRestore();
      }
    });

    it("a build stops before compiling when a pre script fails", async () => {
      const spies = quiet();
      (BascikConfig as any).isBuild = true;
      failOnce("pre");
      try {
        await expect(runTranspile({ exitOnError: false })).rejects.toThrow(
          "exec pre failed",
        );
        expect(_mockWatchFiles).not.toHaveBeenCalled();
      } finally {
        restore();
        spies.error.mockRestore();
        spies.log.mockRestore();
      }
    });

    it("a build fails after compiling when a post script fails, and never claims success", async () => {
      const spies = quiet();
      (BascikConfig as any).isBuild = true;
      _parallel.release();
      failOnce("post");
      try {
        await expect(runTranspile({ exitOnError: false })).rejects.toThrow(
          "exec post failed",
        );
        expect(spies.log).not.toHaveBeenCalledWith(
          expect.stringContaining("Build complete"),
        );
      } finally {
        restore();
        spies.error.mockRestore();
        spies.log.mockRestore();
      }
    });

    it("a build with onExecError 'warn' logs a failed pre script, continues, and completes", async () => {
      const spies = quiet();
      (BascikConfig as any).isBuild = true;
      (BascikConfig.pipeline as any).onExecError = "warn";
      _parallel.release();
      failOnce("pre");
      try {
        await expect(
          runTranspile({ exitOnError: false }),
        ).resolves.toBeUndefined();
        expect(_mockWatchFiles).toHaveBeenCalled();
        expect(spies.error).toHaveBeenCalledWith(
          expect.stringContaining("pipeline.onExecError"),
        );
        expect(spies.log).toHaveBeenCalledWith(
          expect.stringMatching(/Build complete/),
        );
      } finally {
        restore();
        spies.error.mockRestore();
        spies.log.mockRestore();
      }
    });
  });

  it("buffers only the boot compile and emits later watcher publications directly", async () => {
    const emitSpy = vi.spyOn(eventEmitter, "emit");
    (BascikConfig as any).isBuild = false;
    _state.emitDuringBoot = true;
    _parallel.release();

    await runTranspile({ exitOnError: false });

    expect(_mockWatchFiles).toHaveBeenCalledWith(
      expect.objectContaining({ bootCompile: expect.any(Function) }),
    );
    expect(_state.hasPublisherDuringBoot).toBe(true);
    expect(emitSpy).toHaveBeenCalledWith("transpiled", {
      relativePagePath: "boot-buffered.html",
    });

    emitSpy.mockClear();
    await _state.emitFromWatcher?.();
    expect(emitSpy).toHaveBeenCalledWith("transpiled", {
      relativePagePath: "watcher-after-boot.html",
    });
    emitSpy.mockRestore();
  });

  it("publishes boot page errors in dev instead of rejecting the dev boot", async () => {
    const emitSpy = vi.spyOn(eventEmitter, "emit");
    const pageError = new PageProcessingError(
      "/project/src/pages/broken.html",
      "worker transpile",
      new Error("validate markup: missing body"),
    );
    (BascikConfig as any).isBuild = false;
    _state.bootError = new PageProcessingAggregateError([pageError]);
    _parallel.release();

    await expect(runTranspile({ exitOnError: false })).resolves.toBeUndefined();

    expect(_state.hasPublisherDuringBoot).toBe(true);
    expect(emitSpy).toHaveBeenCalledWith(
      "build-error",
      expect.objectContaining({
        file: "/project/src/pages/broken.html",
      }),
    );
    emitSpy.mockRestore();
  });
});
