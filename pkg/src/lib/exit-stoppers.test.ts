import os from "node:os";
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
const posixOnly: NodeJS.Signals[] = ["SIGQUIT", "SIGUSR2"];
let savedPosixOnly: Map<NodeJS.Signals, NodeJS.SignalsListener[]>;

beforeEach(() => {
  savedPosixOnly = new Map(
    posixOnly.map((signal) => [
      signal,
      process.listeners(signal) as NodeJS.SignalsListener[],
    ]),
  );
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
  for (const [signal, listeners] of savedPosixOnly) {
    process.removeAllListeners(signal);
    for (const listener of listeners) process.on(signal, listener);
  }
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

describe("exitOnSignalsAfterStopping", () => {
  let kill: ReturnType<typeof vi.spyOn>;
  let stdoutWrite: typeof process.stdout.write;

  beforeEach(() => {
    // The listener ends the process by sending itself the signal.
    kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    // A pending stop quiets stdout for good: the real process dies next.
    stdoutWrite = process.stdout.write;
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGHUP");
  });

  afterEach(() => {
    kill.mockRestore();
    process.stdout.write = stdoutWrite;
  });

  it("with nothing to stop, ends the process with the same signal at once", async () => {
    const { exitOnSignalsAfterStopping } = await load();
    const stop = vi.fn(() => null);
    exitOnSignalsAfterStopping(stop);
    process.emit("SIGHUP");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGHUP");
    // No listener is left to swallow the signal it sends itself.
    expect(process.listenerCount("SIGHUP")).toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(0);
    expect(process.listenerCount("SIGTERM")).toBe(0);
  });

  it("waits for the stop, as an exit in progress a second signal can cut short, then ends with the signal", async () => {
    const { exitOnSignalsAfterStopping, isExitInProgress } = await load();
    const stop = deferred();
    exitOnSignalsAfterStopping(() => stop.promise);
    process.exitCode = undefined;
    process.emit("SIGTERM");
    expect(kill).not.toHaveBeenCalled();
    expect(isExitInProgress()).toBe(true);
    expect(process.exitCode).toBe(143);
    expect(process.listenerCount("SIGINT")).toBe(0);
    expect(process.listenerCount("SIGTERM")).toBe(0);
    expect(process.listenerCount("SIGHUP")).toBe(0);
    stop.resolve();
    await flush();
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
  });

  it("still ends the process when the stop rejects or throws", async () => {
    const { exitOnSignalsAfterStopping } = await load();
    const stop = deferred();
    exitOnSignalsAfterStopping(() => stop.promise);
    process.emit("SIGINT");
    stop.reject(new Error("ps failed"));
    await flush();
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGINT");

    const again = await load();
    kill.mockClear();
    again.exitOnSignalsAfterStopping(() => {
      throw new Error("stopper threw");
    });
    process.emit("SIGINT");
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGINT");
  });

  // Ctrl+\ sends SIGQUIT and nodemon restarts with SIGUSR2: both end the
  // process by default, and left alone they orphaned the exec scripts.
  it.skipIf(process.platform === "win32")(
    "stops on SIGQUIT and SIGUSR2 too, and ends with that signal and its shell exit code",
    async () => {
      for (const signal of posixOnly) {
        const { exitOnSignalsAfterStopping, STOP_SIGNALS } = await load();
        expect(STOP_SIGNALS).toContain(signal);
        kill.mockClear();
        const stop = deferred();
        exitOnSignalsAfterStopping(() => stop.promise);
        process.exitCode = undefined;
        process.emit(signal);
        expect(process.exitCode).toBe(128 + os.constants.signals[signal]);
        for (const other of STOP_SIGNALS)
          expect(process.listenerCount(other)).toBe(0);
        stop.resolve();
        await flush();
        expect(kill).toHaveBeenCalledWith(process.pid, signal);
      }
    },
  );

  // Windows has neither signal; listening for them would only mislead.
  it("listens for SIGQUIT and SIGUSR2 only where the platform has them", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const { STOP_SIGNALS } = await load();
      expect(STOP_SIGNALS).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("handOverSignals removes its listeners and leaves a server's in place", async () => {
    const { exitOnSignalsAfterStopping, handOverSignals } = await load();
    const stop = vi.fn(() => null);
    exitOnSignalsAfterStopping(stop);
    const server = vi.fn();
    process.once("SIGTERM", server);
    handOverSignals();
    expect(process.listenerCount("SIGINT")).toBe(0);
    expect(process.listenerCount("SIGHUP")).toBe(0);
    process.emit("SIGTERM");
    expect(server).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });
});
