import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  _mockWatchFiles,
  _mockRunExecPhase,
  _mockStartExecParallel,
  _mockStartExecDev,
  _mockStartServer,
  _callOrder,
} = vi.hoisted(() => {
  const _callOrder: string[] = [];
  return {
    _callOrder,
    _mockWatchFiles: vi.fn().mockImplementation(async () => {
      _callOrder.push("watchFiles");
    }),
    _mockRunExecPhase: vi.fn().mockImplementation(async (phase: string) => {
      _callOrder.push(`runExecPhase:${phase}`);
      return { count: 1, totalElapsed: 5 };
    }),
    _mockStartExecParallel: vi.fn().mockImplementation(() => {
      _callOrder.push("startExecParallel");
    }),
    _mockStartExecDev: vi.fn().mockImplementation(async () => {
      _callOrder.push("startExecDev");
    }),
    _mockStartServer: vi.fn().mockImplementation(async () => {
      _callOrder.push("startServer");
      return "http://localhost:8080";
    }),
  };
});

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

vi.mock("./lib/events.js", () => ({
  eventEmitter: { emit: vi.fn() },
}));

vi.mock("./lib/config.js", () => ({
  BascikConfig: { isBuild: false },
}));

import { runTranspile } from "./transpile.ts";
import { BascikConfig } from "./lib/config.ts";

describe("runTranspile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _callOrder.length = 0;
  });

  it("runs build pipeline with pre -> watchFiles -> post order and logs complete timing", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
    (BascikConfig as any).isBuild = true;
    await runTranspile();

    expect(_mockRunExecPhase).toHaveBeenCalledWith("pre");
    expect(_mockStartExecParallel).toHaveBeenCalled();
    expect(_mockWatchFiles).toHaveBeenCalled();
    expect(_mockRunExecPhase).toHaveBeenCalledWith("post");
    expect(_mockStartExecDev).not.toHaveBeenCalled();

    // Verify ordering: pre -> watchFiles -> post
    expect(_callOrder).toEqual([
      "runExecPhase:pre",
      "startExecParallel",
      "watchFiles",
      "runExecPhase:post",
    ]);

    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/✓ Build complete in (?:[<]?[\d.]+(?:ms|s))/));
    logSpy.mockRestore();
  });

  it("runs dev pipeline awaiting pre exec BEFORE watchFiles, then post after watchFiles", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
    (BascikConfig as any).isBuild = false;
    await runTranspile();

    expect(_mockRunExecPhase).toHaveBeenCalledWith("pre");
    expect(_mockStartExecParallel).toHaveBeenCalled();
    expect(_mockStartExecDev).toHaveBeenCalled();
    expect(_mockStartServer).toHaveBeenCalled();
    expect(_mockWatchFiles).toHaveBeenCalled();
    expect(_mockRunExecPhase).toHaveBeenCalledWith("post");

    // Regression check: pre exec is awaited BEFORE watchFiles in dev mode
    const preIndex = _callOrder.indexOf("runExecPhase:pre");
    const watchIndex = _callOrder.indexOf("watchFiles");
    const postIndex = _callOrder.indexOf("runExecPhase:post");

    expect(preIndex).toBeGreaterThanOrEqual(0);
    expect(watchIndex).toBeGreaterThan(preIndex);
    expect(postIndex).toBeGreaterThan(watchIndex);

    expect(logSpy).toHaveBeenNthCalledWith(1, expect.stringMatching(/✓ All tasks completed in (?:[<]?[\d.]+(?:ms|s))/));
    expect(logSpy).toHaveBeenNthCalledWith(2, "Server running at http://localhost:8080");
    logSpy.mockRestore();
  });

  it("handles server startup error gracefully when exitOnError is false", async () => {
    (BascikConfig as any).isBuild = false;
    _mockStartServer.mockRejectedValueOnce(new Error("Port in use"));

    await expect(runTranspile({ exitOnError: false })).rejects.toThrow("Port in use");
  });

  it("rejects without calling watchFiles when a pre exec script fails in dev", async () => {
    (BascikConfig as any).isBuild = false;
    _mockRunExecPhase.mockRejectedValueOnce(new Error("exec pre failed"));

    await expect(runTranspile({ exitOnError: false })).rejects.toThrow("exec pre failed");
    expect(_mockWatchFiles).not.toHaveBeenCalled();
  });
});

