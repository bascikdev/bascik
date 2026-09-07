import { describe, it, expect, vi, beforeEach } from "vitest";

const { _mockStartServer, _mockStartExecDev, _callOrder } = vi.hoisted(() => {
  const _callOrder: string[] = [];
  return {
    _callOrder,
    _mockStartServer: vi.fn().mockImplementation(async () => {
      _callOrder.push("startServer");
      return "http://localhost:8080";
    }),
    _mockStartExecDev: vi.fn().mockImplementation(async () => {
      _callOrder.push("startExecDev");
    }),
  };
});

vi.mock("./server.js", () => ({ startServer: _mockStartServer }));
vi.mock("./exec.js", () => ({
  startExecDev: _mockStartExecDev,
  execWatchCoversPath: (_patterns: string[], _path: string, _script?: string) => false,
}));
vi.mock("./mem.js", () => ({ mem: { setBootingDone: vi.fn() } }));
vi.mock("./events.js", async () => {
  const { EventEmitter } = await import("node:events");
  const realEmitter = new EventEmitter();
  return { eventEmitter: realEmitter };
});
vi.mock("./config.js", () => ({
  BascikConfig: { pipeline: { exec: undefined } },
}));
const { _mockInstallModuleGraphHook } = vi.hoisted(() => ({
  _mockInstallModuleGraphHook: vi.fn(() => ({ installed: true, deregister: () => { } })),
}));
vi.mock("./module-graph.js", () => ({ installModuleGraphHook: _mockInstallModuleGraphHook }));

import { startDevServer } from "./server-dev.ts";
import { mem } from "./mem.ts";
import { eventEmitter } from "./events.ts";
import { _execPublicationTestHooks } from "./exec-publication.ts";

describe("server-dev: the dev-only additions on top of the shared server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _callOrder.length = 0;
  });

  it("binds the port immediately and starts dev exec scripts in parallel, then resolves the URL", async () => {
    const dev = startDevServer({ exitOnError: false });
    expect(_callOrder).toEqual(["startServer", "startExecDev"]);
    await expect(dev.url).resolves.toBe("http://localhost:8080");
    // Nothing is marked booted until the caller says the initial work is done.
    expect(mem.setBootingDone).not.toHaveBeenCalled();
    await dev.execReady;
  });

  it("finishBoot awaits dev exec, then flips the boot flag and emits boot-done exactly once", async () => {
    const emitSpy = vi.spyOn(eventEmitter, "emit");
    const dev = startDevServer({ exitOnError: false });
    await dev.url;
    await dev.finishBoot();
    expect(mem.setBootingDone).toHaveBeenCalledOnce();
    expect(emitSpy).toHaveBeenCalledWith("boot-done");
    // Ordering: exec must be settled before the boot flag flips.
    const emitOrder = emitSpy.mock.invocationCallOrder[0];
    const execOrder = _mockStartExecDev.mock.invocationCallOrder[0];
    expect(emitOrder).toBeGreaterThan(execOrder);
    emitSpy.mockRestore();
  });

  it("surfaces a startup failure through url without exiting when exitOnError is false", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    _mockStartServer.mockRejectedValueOnce(new Error("Port in use"));

    const dev = startDevServer({ exitOnError: false });
    await expect(dev.url).rejects.toThrow("Port in use");
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("Server startup failed:", expect.any(Error));
    await dev.execReady;
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("exits the process on startup failure when exitOnError is true (CLI default)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    _mockStartServer.mockRejectedValueOnce(new Error("Port in use"));

    const dev = startDevServer({ exitOnError: true });
    await expect(dev.url).rejects.toThrow("Port in use");
    expect(exitSpy).toHaveBeenCalledWith(1);
    await dev.execReady;
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("forwards the retained parallel handle to startExecDev and installs the coordinator before it can settle", async () => {
    // A parallel entry that finishes fast must find the exec-completed
    // listener already installed; otherwise the completion is dropped. The
    // handle is therefore released only after startExecDev has been reached.
    let release: () => void = () => { };
    const joined = new Promise<void>((resolve) => {
      release = resolve;
    });
    const parallel = Object.assign(joined, { tasks: [] });
    _mockStartExecDev.mockImplementationOnce(async (opts?: { parallel?: unknown }) => {
      _callOrder.push("startExecDev");
      expect(opts?.parallel).toBe(parallel);
      expect(eventEmitter.listenerCount("exec-completed")).toBeGreaterThan(0);
      expect(eventEmitter.listenerCount("exec-failed")).toBeGreaterThan(0);
    });

    const dev = startDevServer({ exitOnError: false, parallel });
    release();
    await dev.execReady;
    expect(_mockStartExecDev).toHaveBeenCalledWith(expect.objectContaining({ parallel }));
  });

  it("installs the dev-only module graph hook before the server binds (prompt 138)", async () => {
    _mockInstallModuleGraphHook.mockClear();
    const dev = startDevServer({ exitOnError: false });
    await dev.url;
    expect(_mockInstallModuleGraphHook).toHaveBeenCalledTimes(1);
    expect(_mockInstallModuleGraphHook).toHaveBeenCalledWith(
      expect.objectContaining({ isDev: true, projectRoot: process.cwd() }),
    );
    // The hook must be registered before any request can import a runtime module.
    expect(_mockInstallModuleGraphHook.mock.invocationCallOrder[0]).toBeLessThan(
      _mockStartServer.mock.invocationCallOrder[0],
    );
    await dev.execReady;
  });

  it("installs the single exec publication coordinator after dev exec registration", async () => {
    const dev = startDevServer({ exitOnError: false });
    await dev.execReady;
    // The lifecycle owner wired the exec-completed listener to the shared
    // emitter: a producer completion must now reach the coordinator.
    expect(eventEmitter.listenerCount("exec-completed")).toBeGreaterThan(0);
    expect(eventEmitter.listenerCount("exec-failed")).toBeGreaterThan(0);
    // A fresh fixture run leaves no leaked pending generation.
    expect(_execPublicationTestHooks.generationValue).toBe(0);
  });
});
