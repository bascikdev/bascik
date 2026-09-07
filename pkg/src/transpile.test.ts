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
    release: () => { },
    settled: Promise.resolve(),
    handle: Object.assign(Promise.resolve(), { tasks: [] as unknown[] }),
    reset: () => { },
  };
  _parallel.reset = () => {
    let resolveSettled: () => void = () => { };
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
    _mockWatchFiles: vi.fn().mockImplementation(async (options?: {
      bootCompile?: (compileInitialSources: () => Promise<void>) => Promise<void>;
    }) => {
      _callOrder.push("watchFiles");
      _state.emitFromWatcher = async () => {
        const compilationEvents = await import("./lib/compilation-events.ts");
        compilationEvents.publishTranspiled({ relativePagePath: "watcher-after-boot.html" });
      };
      if (options?.bootCompile) {
        await options.bootCompile(async () => {
          const compilationEvents = await import("./lib/compilation-events.ts");
          _state.hasPublisherDuringBoot = compilationEvents.hasCompilationPublisher();
          if (_state.emitDuringBoot) {
            compilationEvents.publishTranspiled({ relativePagePath: "boot-buffered.html" });
          }
          if (_state.bootError) {
            if (compilationEvents.getCompilationPageErrorPolicy() === "publish") {
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
    }),
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
import { PageProcessingAggregateError, PageProcessingError } from "./lib/processing.ts";

describe("runTranspile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _callOrder.length = 0;
    _parallel.reset();
    _state.reset();
    (BascikConfig as any).directory.out = "dist";
  });

  it("compiles alongside parallel exec and joins before declaring build success", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
    (BascikConfig as any).isBuild = true;
    const run = runTranspile();
    try {
      await vi.waitFor(() => expect(_mockWatchFiles).toHaveBeenCalled(), { timeout: 250 });
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("Build complete"));
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

    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/✓ Build complete in (?:[<]?[\d.]+(?:ms|s))/));
    logSpy.mockRestore();
  });

  it("runs dev pipeline awaiting pre exec BEFORE watchFiles, then post after watchFiles", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
    const emitSpy = vi.spyOn(eventEmitter, "emit");
    (BascikConfig as any).isBuild = false;
    // The parallel handle stays pending until the server has bound. An
    // implementation that awaits the join before `startServer` never gets
    // there, so a bounded fallback releases the handle and lets the ordering
    // assertion below report the defect instead of hanging the test.
    const fallback = setTimeout(() => _parallel.release(), 1000);
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
    const parallelSettledIndex = _callOrder.indexOf("startExecParallel:settled");
    expect(serverIndex).toBeGreaterThanOrEqual(0);
    expect(parallelSettledIndex).toBeGreaterThan(serverIndex);
    expect(_callOrder.filter((step) => step !== "startExecParallel:settled")).toEqual([
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

    expect(logSpy).toHaveBeenNthCalledWith(1, expect.stringMatching(/✓ All tasks completed in (?:[<]?[\d.]+(?:ms|s))/));
    expect(logSpy).toHaveBeenNthCalledWith(2, "Server running at http://localhost:8080");
    logSpy.mockRestore();
  });

  it("cleans the output directory before pre exec in dev and build modes", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });

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

  it("handles server startup error gracefully when exitOnError is false", async () => {
    (BascikConfig as any).isBuild = false;
    _parallel.release();
    _mockStartServer.mockRejectedValueOnce(new Error("Port in use"));

    await expect(runTranspile({ exitOnError: false })).rejects.toThrow("Port in use");
  });

  it("rejects without calling watchFiles when a pre exec script fails in dev", async () => {
    (BascikConfig as any).isBuild = false;
    _mockRunExecPhase.mockRejectedValueOnce(new Error("exec pre failed"));

    await expect(runTranspile({ exitOnError: false })).rejects.toThrow("exec pre failed");
    expect(_mockWatchFiles).not.toHaveBeenCalled();
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
    expect(emitSpy).toHaveBeenCalledWith("transpiled", { relativePagePath: "boot-buffered.html" });

    emitSpy.mockClear();
    await _state.emitFromWatcher?.();
    expect(emitSpy).toHaveBeenCalledWith("transpiled", { relativePagePath: "watcher-after-boot.html" });
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

