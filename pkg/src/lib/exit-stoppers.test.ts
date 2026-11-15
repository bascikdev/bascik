import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The registry and the "already exiting" flag are module state: every test
// gets a fresh copy.
const load = async () => {
  vi.resetModules();
  return import("./exit-stoppers.ts");
};

let savedExitCode: typeof process.exitCode;
let savedSigint: NodeJS.SignalsListener[];
let savedSigterm: NodeJS.SignalsListener[];
let savedSighup: NodeJS.SignalsListener[];

beforeEach(() => {
  savedExitCode = process.exitCode;
  savedSigint = process.listeners("SIGINT") as NodeJS.SignalsListener[];
  savedSigterm = process.listeners("SIGTERM") as NodeJS.SignalsListener[];
  savedSighup = process.listeners("SIGHUP") as NodeJS.SignalsListener[];
});

afterEach(() => {
  vi.useRealTimers();
  process.exitCode = savedExitCode;
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGHUP");
  for (const listener of savedSigint) process.on("SIGINT", listener);
  for (const listener of savedSigterm) process.on("SIGTERM", listener);
  for (const listener of savedSighup) process.on("SIGHUP", listener);
});

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = () => new Promise((r) => setImmediate(r));

describe("stopBeforeExit", () => {
  it("returns null with nothing registered, or when no stopper has anything to stop", async () => {
    const { stopBeforeExit, registerExitStopper } = await load();
    expect(stopBeforeExit()).toBeNull();
    registerExitStopper(() => null);
    expect(stopBeforeExit()).toBeNull();
  });

  it("waits for every stopper that has work", async () => {
    const { stopBeforeExit, registerExitStopper } = await load();
    const a = deferred();
    const b = deferred();
    registerExitStopper(() => a.promise);
    registerExitStopper(() => null);
    registerExitStopper(() => b.promise);
    let settled = false;
    void stopBeforeExit()!.then(() => (settled = true));
    a.resolve();
    await flush();
    expect(settled).toBe(false);
    b.resolve();
    await flush();
    expect(settled).toBe(true);
  });

  it("never rejects when a stopper rejects or throws", async () => {
    const { stopBeforeExit, registerExitStopper } = await load();
    registerExitStopper(() => Promise.reject(new Error("terminate failed")));
    registerExitStopper(() => {
      throw new Error("stopper threw");
    });
    await expect(stopBeforeExit()).resolves.toBeUndefined();
  });

  it("gives up after the timeout when a stopper never settles", async () => {
    vi.useFakeTimers();
    const { stopBeforeExit, registerExitStopper, STOP_BEFORE_EXIT_TIMEOUT_MS } =
      await load();
    registerExitStopper(() => new Promise<void>(() => {}));
    let settled = false;
    void stopBeforeExit()!.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(STOP_BEFORE_EXIT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });

  it("registering the same stopper twice runs it once", async () => {
    const { stopBeforeExit, registerExitStopper } = await load();
    const stopper = vi.fn(() => Promise.resolve());
    registerExitStopper(stopper);
    registerExitStopper(stopper);
    await stopBeforeExit();
    expect(stopper).toHaveBeenCalledTimes(1);
  });
});

describe("exitAfterStopping", () => {
  it("exits at once, synchronously, with nothing to stop", async () => {
    const { exitAfterStopping } = await load();
    const exit = vi.fn();
    exitAfterStopping(1, exit);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits only after the stoppers finish, with the exit code already set and Ctrl-C released", async () => {
    const { exitAfterStopping, registerExitStopper } = await load();
    const stop = deferred();
    registerExitStopper(() => stop.promise);
    const sigint = vi.fn();
    process.on("SIGINT", sigint);
    process.on("SIGTERM", sigint);
    process.on("SIGHUP", sigint);
    process.exitCode = undefined;
    const exit = vi.fn();
    exitAfterStopping(1, exit);
    expect(exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    // A Ctrl-C now takes the default action (ends the process at once).
    expect(process.listenerCount("SIGINT")).toBe(0);
    expect(process.listenerCount("SIGTERM")).toBe(0);
    // SIGHUP too (audit 159 finding 142).
    expect(process.listenerCount("SIGHUP")).toBe(0);
    stop.resolve();
    await flush();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("a second exit while the first waits does not exit twice or replace a failure code", async () => {
    const { exitAfterStopping, registerExitStopper } = await load();
    const stop = deferred();
    registerExitStopper(() => stop.promise);
    process.exitCode = undefined;
    const first = vi.fn();
    const second = vi.fn();
    exitAfterStopping(1, first);
    exitAfterStopping(0, second);
    expect(process.exitCode).toBe(1);
    stop.resolve();
    await flush();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("reports an exit in progress only while it waits", async () => {
    const { exitAfterStopping, registerExitStopper, isExitInProgress } =
      await load();
    expect(isExitInProgress()).toBe(false);
    const stop = deferred();
    registerExitStopper(() => stop.promise);
    process.exitCode = undefined;
    const exit = vi.fn();
    exitAfterStopping(1, exit);
    expect(isExitInProgress()).toBe(true);
    stop.resolve();
    await flush();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("a failing exit keeps stdout quiet while it waits, so nothing after the failure reads as progress or success", async () => {
    const { exitAfterStopping, registerExitStopper } = await load();
    const stop = deferred();
    registerExitStopper(() => stop.promise);
    process.exitCode = undefined;
    const original = process.stdout.write;
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: any) => {
        written.push(String(chunk));
        return true;
      });
    try {
      const exit = vi.fn(() => {
        // Restored before the exit itself, for whatever the exit prints.
        process.stdout.write("at exit\n");
      });
      exitAfterStopping(1, exit);
      const returned = process.stdout.write("✓ Build complete\n");
      expect(returned).toBe(true);
      expect(written).toEqual([]);
      stop.resolve();
      await flush();
      expect(exit).toHaveBeenCalledWith(1);
      expect(written).toEqual(["at exit\n"]);
    } finally {
      spy.mockRestore();
      expect(process.stdout.write).toBe(original);
    }
  });

  it("a successful exit (code 0) leaves stdout alone while it waits", async () => {
    const { exitAfterStopping, registerExitStopper } = await load();
    const stop = deferred();
    registerExitStopper(() => stop.promise);
    process.exitCode = undefined;
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: any) => {
        written.push(String(chunk));
        return true;
      });
    try {
      exitAfterStopping(0, vi.fn());
      process.stdout.write("still here\n");
      expect(written).toEqual(["still here\n"]);
      stop.resolve();
      await flush();
    } finally {
      spy.mockRestore();
    }
  });

  it("still exits when a stopper rejects", async () => {
    const { exitAfterStopping, registerExitStopper } = await load();
    registerExitStopper(() => Promise.reject(new Error("boom")));
    const exit = vi.fn();
    exitAfterStopping(1, exit);
    await flush();
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("exitAfterStopping while another exit waits", () => {
  it("a later exit with nothing left to stop still leaves the exit to the first", async () => {
    const { exitAfterStopping, registerExitStopper } = await load();
    // A stopper that has work only once, like a script that is gone by the
    // time its failure reaches the CLI's own exit.
    const stop = deferred();
    let asked = 0;
    registerExitStopper(() => (asked++ === 0 ? stop.promise : null));
    process.exitCode = undefined;
    const first = vi.fn();
    const second = vi.fn();
    exitAfterStopping(143, first);
    exitAfterStopping(1, second);
    expect(second).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(143);
    stop.resolve();
    await flush();
    expect(first).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith(143);
    expect(second).not.toHaveBeenCalled();
  });
});

describe("installExitSignalHandlers", () => {
  const signals = [
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const;

  beforeEach(() => {
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGHUP");
  });

  it.each(signals)(
    "%s runs the stoppers, then ends the process by the same signal",
    async (signal, code) => {
      const { installExitSignalHandlers, registerExitStopper } = await load();
      const stop = deferred();
      const stopper = vi.fn(() => stop.promise);
      registerExitStopper(stopper);
      process.exitCode = undefined;
      const kill = vi.fn();
      installExitSignalHandlers(kill);
      expect(process.listenerCount(signal)).toBe(1);

      process.emit(signal);

      expect(stopper).toHaveBeenCalledTimes(1);
      expect(kill).not.toHaveBeenCalled();
      // Fails even if the process ends some other way while it waits.
      expect(process.exitCode).toBe(code);
      // Any of the three sent now ends the process at once.
      for (const [other] of signals)
        expect(process.listenerCount(other)).toBe(0);
      stop.resolve();
      await flush();
      expect(kill).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith(signal);
    },
  );

  it("ends the process at once when nothing is running", async () => {
    const { installExitSignalHandlers } = await load();
    const kill = vi.fn();
    installExitSignalHandlers(kill);
    process.emit("SIGTERM");
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(process.listenerCount("SIGTERM")).toBe(0);
  });

  it("removes a listener added while the stoppers ran, so the signal it sends itself is not caught", async () => {
    const { installExitSignalHandlers, registerExitStopper } = await load();
    const stop = deferred();
    registerExitStopper(() => stop.promise);
    process.exitCode = undefined;
    const lateListener = vi.fn();
    const listenersAtKill: number[] = [];
    installExitSignalHandlers(() => {
      listenersAtKill.push(process.listenerCount("SIGTERM"));
    });
    process.emit("SIGTERM");
    // A dev server that began listening meanwhile.
    process.once("SIGTERM", lateListener);
    stop.resolve();
    await flush();
    expect(listenersAtKill).toEqual([0]);
    expect(lateListener).not.toHaveBeenCalled();
  });

  it("installing twice adds one listener per signal", async () => {
    const { installExitSignalHandlers } = await load();
    installExitSignalHandlers(vi.fn());
    installExitSignalHandlers(vi.fn());
    for (const [signal] of signals)
      expect(process.listenerCount(signal)).toBe(1);
  });

  it("removeExitSignalHandlers removes only its own listeners", async () => {
    const {
      installExitSignalHandlers,
      removeExitSignalHandlers,
      registerExitStopper,
    } = await load();
    const stopper = vi.fn(() => null);
    registerExitStopper(stopper);
    const serverListener = vi.fn();
    process.on("SIGTERM", serverListener);
    const kill = vi.fn();
    installExitSignalHandlers(kill);
    removeExitSignalHandlers();
    expect(process.listeners("SIGTERM")).toEqual([serverListener]);
    expect(process.listenerCount("SIGINT")).toBe(0);
    expect(process.listenerCount("SIGHUP")).toBe(0);
    process.emit("SIGTERM");
    expect(serverListener).toHaveBeenCalledTimes(1);
    expect(stopper).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    // Removed for good: it can be installed again.
    installExitSignalHandlers(kill);
    expect(process.listenerCount("SIGINT")).toBe(1);
  });
});
