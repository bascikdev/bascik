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
vi.mock("./exec.js", () => ({ startExecDev: _mockStartExecDev }));
vi.mock("./mem.js", () => ({ mem: { setBootingDone: vi.fn() } }));
vi.mock("./events.js", () => ({ eventEmitter: { emit: vi.fn() } }));

import { startDevServer } from "./server-dev.ts";
import { mem } from "./mem.ts";
import { eventEmitter } from "./events.ts";

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
    const dev = startDevServer({ exitOnError: false });
    await dev.url;
    await dev.finishBoot();
    expect(mem.setBootingDone).toHaveBeenCalledOnce();
    expect(eventEmitter.emit).toHaveBeenCalledWith("boot-done");
    // Ordering: exec must be settled before the boot flag flips.
    const emitOrder = (eventEmitter.emit as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const execOrder = _mockStartExecDev.mock.invocationCallOrder[0];
    expect(emitOrder).toBeGreaterThan(execOrder);
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
});
