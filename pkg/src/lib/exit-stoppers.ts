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

const stoppers = new Set<ExitStopper>();

/**
 * The longest any exit waits for its stoppers. The page pool waits for a
 * loading worker for as long as it is evaluating (terminating it then aborts
 * Node), terminates one that has been waiting rather than evaluating past
 * its 10 s ready grace, and gives a loaded worker up to 3 s to end itself
 * on the stop message (`READY_GRACE_MS` and `STOP_GRACE_MS` in
 * `worker-pool.ts`); past this bound, a worker must not keep a crashed or
 * interrupted process alive, so a worker still evaluating its config 13 s
 * into the exit is the one case left that can abort.
 */
export const STOP_BEFORE_EXIT_TIMEOUT_MS = 13_000;

export const registerExitStopper = (stopper: ExitStopper): void => {
  stoppers.add(stopper);
};

/**
 * Run every registered stopper. Returns `null` when none had anything to
 * stop; otherwise a promise that never rejects and settles once all have
 * finished, or after `timeoutMs`, whichever comes first.
 */
export const stopBeforeExit = (
  timeoutMs: number = STOP_BEFORE_EXIT_TIMEOUT_MS,
): Promise<void> | null => {
  const pending: Promise<void>[] = [];
  for (const stop of stoppers) {
    let result: Promise<void> | null;
    try {
      result = stop();
    } catch {
      continue;
    }
    if (result) pending.push(Promise.resolve(result).catch(() => {}));
  }
  if (pending.length === 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolveDeadline) => {
    timer = setTimeout(resolveDeadline, timeoutMs);
  });
  return Promise.race([Promise.all(pending).then(() => {}), deadline]).finally(
    () => clearTimeout(timer),
  );
};

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
 * Exit with `code` once the stoppers have finished (bounded by
 * `STOP_BEFORE_EXIT_TIMEOUT_MS`). With nothing to stop it exits at once, as
 * `process.exit` would.
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
  void pending.then(() => {
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
