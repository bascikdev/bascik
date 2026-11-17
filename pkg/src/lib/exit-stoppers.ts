/**
 * Work that must be stopped before the process exits.
 *
 * Node 24 can abort the whole process ("Check failed: (location_) !=
 * nullptr") when it exits while a worker thread is still evaluating its
 * module graph, and the page worker pool starts workers early in a build or
 * dev boot. Every exit path (the crash net, the dev server's SIGINT / SIGTERM
 * shutdown, an exec failure stop, the CLI's own exits) therefore asks the
 * stoppers registered here to finish first. `processing.ts` registers the
 * page pools.
 *
 * This module has no dependencies, so the crash net can import it without
 * loading the compiler.
 */

import os from "node:os";

/**
 * Returns a promise while there is something to stop, `null` when there is
 * nothing (so an exit with nothing running stays synchronous).
 */
export type ExitStopper = () => Promise<void> | null;

/**
 * `teardownOnly`: the stopper exists only so that `process.exit()` does not
 * abort Node (the page worker pools: Node aborts when the process exits, or
 * a worker is terminated, while a worker is still evaluating a module that
 * waited for a top-level await). A process that ends by a signal's default
 * action runs no exit teardown, so a signal exit does not wait for these
 * (`endProcess`); every other stopper (the `pipeline.exec` children) is
 * waited for on every exit, or the process would leave it running.
 */
interface StopperOptions {
  teardownOnly?: boolean;
}

const stoppers = new Map<ExitStopper, StopperOptions>();

/** Teardown-only stops started and not yet finished. */
let teardownStopsPending = 0;

export const registerExitStopper = (
  stopper: ExitStopper,
  options: StopperOptions = {},
): void => {
  stoppers.set(stopper, options);
};

/**
 * How long a signal's exit waits for the page pools before it ends by the
 * signal instead. Workers that are loaded stop in milliseconds, and most
 * finish loading within this, so a Ctrl-C usually still exits 0.
 */
export const SIGNAL_EXIT_TEARDOWN_WAIT_MS = 1_000;

/** `settled`, or `SIGNAL_EXIT_TEARDOWN_WAIT_MS`, whichever comes first. */
const briefly = (settled: Promise<void>): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolveWait) => {
    timer = setTimeout(resolveWait, SIGNAL_EXIT_TEARDOWN_WAIT_MS);
  });
  return Promise.race([settled, waited]).finally(() => clearTimeout(timer));
};

/**
 * Run every registered stopper. Returns `null` when none had anything to
 * stop; otherwise a promise that never rejects and settles once all have
 * finished. There is deliberately no deadline: the page pools bound their
 * own stop (a stuck worker is terminated, a loaded one gets 3 s) except for
 * a worker still evaluating, and exiting then is exactly what aborts Node.
 * A Ctrl-C during the wait ends the process at once instead
 * (`exitAfterStopping`, `endProcess`).
 *
 * `signal`: the exit is a signal's (a server's graceful shutdown). The
 * teardown-only stoppers still start, but the returned promise waits for
 * them only up to `SIGNAL_EXIT_TEARDOWN_WAIT_MS`, so a Ctrl-C stays
 * responsive; end with `endProcess(code, signal)`, which ends by the signal
 * while a teardown-only stop is still running.
 */
export const stopBeforeExit = (
  options: { signal?: NodeJS.Signals } = {},
): Promise<void> | null => {
  const awaited: Promise<void>[] = [];
  let started = 0;
  for (const [stop, { teardownOnly }] of stoppers) {
    let result: Promise<void> | null;
    try {
      result = stop();
    } catch {
      continue;
    }
    if (!result) continue;
    started++;
    const settled = Promise.resolve(result).catch(() => {});
    if (teardownOnly) {
      teardownStopsPending++;
      void settled.then(() => {
        teardownStopsPending--;
      });
      if (options.signal) {
        awaited.push(briefly(settled));
        continue;
      }
    }
    awaited.push(settled);
  }
  if (started === 0) return null;
  return Promise.all(awaited).then(() => {});
};

/**
 * End the process with `code`, or, when the exit is a signal's and a
 * teardown-only stop (a page worker still loading) is still running, by
 * that signal's default action: `process.exit()` would abort Node then,
 * while a death by signal runs no exit teardown and is immediate. The shell
 * then sees the signal's status (130 for SIGINT) rather than `code`.
 */
export const endProcess = (code: number, signal?: NodeJS.Signals): void => {
  if (signal && teardownStopsPending > 0) {
    releaseSignals();
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code);
};

/** How long an exit waits for its stoppers before it says what it waits for. */
export const EXIT_WAIT_NOTICE_MS = 3_000;

let exiting = false;
let shuttingDown = false;

/**
 * True while `exitAfterStopping` or a signal is waiting for the stoppers, and
 * from the moment a shutdown begins (`markShutdownStarted`). A script Bascik
 * stops then is not a failure: it is neither reported nor tolerated, and no
 * new one starts.
 */
export const isExitInProgress = (): boolean => exiting || shuttingDown;

/**
 * Mark the process as shutting down for good: a server's graceful shutdown
 * or an exec failure stop (`runShutdownHandlers`), which stop the exec
 * scripts and then exit. Never undone; the process ends next.
 */
export const markShutdownStarted = (): void => {
  shuttingDown = true;
};

/** Undo `markShutdownStarted`, for tests that keep running after a shutdown. */
export const resetShutdownStateForTests = (): void => {
  shuttingDown = false;
};

/**
 * Drop everything written to stdout until the returned function restores
 * it. A failing exit is already reported on stderr; whatever the rest of the
 * process still prints while the exit waits (a page count, "Build
 * complete") would read as progress or success after the failure.
 */
const quietStdout = (): (() => void) => {
  const stdout = process.stdout;
  const write = stdout.write;
  stdout.write = ((
    _chunk: unknown,
    encodingOrCallback?: unknown,
    callback?: unknown,
  ) => {
    const done =
      typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (typeof done === "function") queueMicrotask(() => done());
    return true;
  }) as typeof stdout.write;
  return () => {
    stdout.write = write;
  };
};

/**
 * Exit with `code` once the stoppers have finished. With nothing to stop it
 * exits at once, as `process.exit` would. When a page worker is still
 * loading `EXIT_WAIT_NOTICE_MS` in, it says so on stderr, once, and that a
 * Ctrl-C quits at once.
 *
 * While it waits, `process.exitCode` already holds `code`, so the process
 * fails even if it ends some other way, and SIGINT / SIGTERM have no
 * listener left: a Ctrl-C during the wait takes the default action and ends
 * the process at once, which never runs the exit teardown that can abort.
 * A failing exit (`code` not 0) also keeps stdout quiet while it waits.
 * A second call while one is waiting only waits with it.
 */
export const exitAfterStopping = (
  code: number,
  exit: (code: number) => void = (exitCode) => process.exit(exitCode),
): void => {
  const pending = stopBeforeExit();
  if (!pending) {
    exit(code);
    return;
  }
  if (process.exitCode === undefined || process.exitCode === 0)
    process.exitCode = code;
  if (exiting) return;
  exiting = true;
  releaseSignals();
  const restoreStdout = code === 0 ? () => {} : quietStdout();
  const notice = setTimeout(() => {
    if (teardownStopsPending > 0)
      console.error(
        "[bascik] Waiting for a page worker to finish loading before exiting (stopping a worker while it loads crashes Node). Press Ctrl+C to quit now.",
      );
  }, EXIT_WAIT_NOTICE_MS);
  notice.unref();
  void pending.then(() => {
    clearTimeout(notice);
    exiting = false;
    restoreStdout();
    exit(code);
  });
};

/**
 * The signals that end a process by default and that Bascik turns into a
 * stop: SIGINT (Ctrl+C), SIGTERM, SIGHUP (a closed terminal, a supervisor),
 * and, where the platform has them (not Windows), SIGQUIT (Ctrl+\\) and
 * SIGUSR2 (nodemon's restart). Left to their default action they end Bascik
 * at once and leave its `pipeline.exec` scripts running with no parent.
 */
export const STOP_SIGNALS: readonly NodeJS.Signals[] =
  process.platform === "win32"
    ? ["SIGINT", "SIGTERM", "SIGHUP"]
    : ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGUSR2"];

/**
 * Remove every listener for the `STOP_SIGNALS`, so the next one of them
 * ends the process at once with the signal's default action. For a process
 * that is already on its way out and only waiting for stoppers.
 */
export const releaseSignals = (): void => {
  for (const signal of STOP_SIGNALS) process.removeAllListeners(signal);
};

/** 128 + the signal's number: the status a shell reports for a death by it. */
const signalExitCode = (signal: NodeJS.Signals): number =>
  128 + (os.constants.signals[signal] ?? 0);

let stopExitingOnSignals: (() => void) | undefined;

/**
 * Until a server takes the signals over (`handOverSignals`), the first
 * of the `STOP_SIGNALS` runs `stop` and then ends the process with that
 * same signal, as it would have ended without a listener.
 *
 * A build, and a dev boot before its server is up, have no server and so no
 * graceful shutdown. A signal sent to this process alone (`kill`, a
 * supervisor, a CI runner canceling a step) would otherwise end it at once
 * and leave its `pipeline.exec` children running with no parent. Only those
 * are stopped (`stop` is the exec stopper), not the page worker pools: a
 * process that dies of a signal never runs the exit teardown the pools must
 * be stopped for, and waiting for workers to load would delay every Ctrl-C.
 *
 * While `stop` is pending the process counts as exiting (`isExitInProgress`),
 * stdout is quiet, and a second signal ends the process at once.
 */
export const exitOnSignalsAfterStopping = (stop: ExitStopper): void => {
  if (stopExitingOnSignals) return;
  const listeners = STOP_SIGNALS.map((signal) => {
    const listener = () => {
      // No listener is left by the time this runs, so the signal takes its
      // default action.
      const die = () => {
        releaseSignals();
        process.kill(process.pid, signal);
      };
      let pending: Promise<void> | null = null;
      try {
        pending = stop();
      } catch {
        // Nothing can be stopped; end as the signal asked.
      }
      if (!pending) {
        die();
        return;
      }
      // The code the process holds if it ends some other way first.
      process.exitCode = signalExitCode(signal);
      exiting = true;
      releaseSignals();
      quietStdout();
      void pending.catch(() => {}).then(die);
    };
    process.once(signal, listener);
    return [signal, listener] as const;
  });
  stopExitingOnSignals = () => {
    for (const [signal, listener] of listeners)
      process.removeListener(signal, listener);
  };
};

/**
 * Remove the listeners `exitOnSignalsAfterStopping` installed. A server
 * calls this right before it installs its own graceful shutdown, so one
 * signal never runs both.
 */
export const handOverSignals = (): void => {
  stopExitingOnSignals?.();
  stopExitingOnSignals = undefined;
};
