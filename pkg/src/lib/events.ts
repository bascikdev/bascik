import EventEmitter from "node:events";
import { markShutdownStarted, stopBeforeExit } from "./exit-stoppers.ts";

export const eventEmitter = new EventEmitter();
// Every open browser tab adds a `transpiled` + `asset-changed` listener for its
// SSE live-reload connection.  The default max of 10 fires a false-positive
// MaxListenersExceededWarning after just a few tabs; listeners are removed on
// stream close, so an unbounded cap is correct here.
eventEmitter.setMaxListeners(0);

// Cleanup functions registered by modules that hold open handles.
// The SIGINT handler in http2.ts calls all of these before exiting.
let _shutdownHandlers: Array<() => void | Promise<void>> = [];
export const registerShutdownHandler = (fn: () => void | Promise<void>) => {
  _shutdownHandlers.push(fn);
};

export const _resetShutdownHandlersForTesting = () => {
  _shutdownHandlers = [];
};

/**
 * Run the shutdown handlers and the exit stoppers. `signal`: the shutdown is
 * a signal's, so it does not wait for the page worker pools (the caller
 * ends with `endProcess(code, signal)`, by the signal if one is still
 * loading); without it, it waits for them too.
 */
export const runShutdownHandlers = async (
  options: { signal?: NodeJS.Signals } = {},
): Promise<void> => {
  const errors: unknown[] = [];
  // Every caller exits next, so the scripts stopped below are not failures.
  markShutdownStarted();
  // Every caller exits next: stop the exec children and the page worker
  // pools too (never rejects); exiting while a page worker is still loading
  // aborts Node (`exit-stoppers.ts`).
  const promises: Promise<void>[] = [
    stopBeforeExit(options) ?? Promise.resolve(),
  ];

  for (const fn of _shutdownHandlers) {
    try {
      const res = fn();
      if (res && typeof (res as Promise<void>).then === "function") {
        promises.push(
          (res as Promise<void>).catch((err) => {
            errors.push(err);
          }),
        );
      }
    } catch (err) {
      errors.push(err);
    }
  }

  await Promise.all(promises);

  if (errors.length > 0) {
    if (errors.length === 1 && errors[0] instanceof Error) {
      throw errors[0];
    }
    throw new AggregateError(
      errors,
      `Errors occurred during shutdown handlers (${errors.length} error(s))`,
    );
  }
};
