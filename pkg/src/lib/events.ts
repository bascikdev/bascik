import EventEmitter from 'node:events';

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

export const runShutdownHandlers = async (): Promise<void> => {
  const errors: unknown[] = [];
  const promises: Promise<void>[] = [];

  for (const fn of _shutdownHandlers) {
    try {
      const res = fn();
      if (res && typeof (res as Promise<void>).then === 'function') {
        promises.push(
          (res as Promise<void>).catch((err) => {
            errors.push(err);
          })
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
    throw new AggregateError(errors, `Errors occurred during shutdown handlers (${errors.length} error(s))`);
  }
};