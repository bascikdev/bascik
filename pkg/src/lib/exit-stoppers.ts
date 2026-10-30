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

/**
 * Returns a promise while there is something to stop, `null` when there is
 * nothing (so an exit with nothing running stays synchronous).
 */
export type ExitStopper = () => Promise<void> | null;

const stoppers = new Set<ExitStopper>();

/**
 * The longest any exit waits for its stoppers. The page pool waits up to
 * 10 s for a loading worker before terminating it anyway; past that, a
 * stuck worker must not keep a crashed or interrupted process alive.
 */
export const STOP_BEFORE_EXIT_TIMEOUT_MS = 10_000;

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

/** True while `exitAfterStopping` is waiting for the stoppers. */
export const isExitInProgress = (): boolean => exiting;

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
 * Remove every SIGINT and SIGTERM listener, so the next one of either ends
 * the process at once with the signal's default action. For a process that
 * is already on its way out and only waiting for stoppers.
 */
export const releaseSignals = (): void => {
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
};
