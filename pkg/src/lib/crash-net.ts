/**
 * Process-level crash net handlers for unhandled rejections and uncaught exceptions.
 * Logs error details and exits with non-zero exit code.
 *
 * The exit waits, bounded, for the page worker pools to stop: exiting while a
 * page worker is still loading can abort Node 24 (`exit-stoppers.ts`). A
 * Ctrl-C during that wait ends the process at once.
 *
 * A write to stderr that fails (EPIPE: the terminal closed, the CI step was
 * killed, `2>&1 | head` stopped reading) is not a crash and cannot be
 * reported: stderr is where the report would go. Without a listener Node
 * raises it as an uncaught exception, the handler below prints it to the
 * same broken stream, and that write fails in turn, from inside the
 * `process.nextTick` queue, so no timer (the bounded exit included) ever
 * runs again. The stderr `error` listener installed here ends that loop.
 *
 * A failed write to stdout is not a crash either: the reader of the log went
 * away (`bascik --build | head -1`, `| grep -q`, a log collector that
 * stopped), not the work. Without a listener the same uncaught exception
 * stopped a build halfway, leaving a partial output directory, and took a
 * running server down on its next access log line. The stdout `error`
 * listener lets the build finish and the server keep serving; the exit code
 * still says whether the build worked.
 */
import { flushHeldOutputForExit } from "./ordered-output.ts";
import { exitAfterStopping, isExitInProgress } from "./exit-stoppers.ts";

let installed = false;

const ignoreOutputFailure = (): void => {};

export const installProcessCrashHandlers = (): (() => void) => {
  // A handler runs in the context of whatever threw. Inside a task whose
  // output is held (a component manifest build), the message would be held
  // with it and lost on exit: write what is held, then print unheld.
  // A failure while an exit already waits for the page pools is shown, but
  // not as another fatal crash: the first one is what failed the run.
  const report = (heading: string, reason: unknown) => {
    flushHeldOutputForExit();
    if (isExitInProgress()) {
      console.error("[bascik] Another error while exiting:", reason);
      return;
    }
    console.error(heading, reason);
    exitAfterStopping(1);
  };

  const onUnhandledRejection = (reason: unknown) =>
    report("[bascik] Fatal unhandled promise rejection:", reason);

  const onUncaughtException = (error: Error) =>
    report("[bascik] Fatal uncaught exception:", error);

  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtException", onUncaughtException);
  process.stderr.on("error", ignoreOutputFailure);
  process.stdout.on("error", ignoreOutputFailure);

  installed = true;

  return () => {
    process.removeListener("unhandledRejection", onUnhandledRejection);
    process.removeListener("uncaughtException", onUncaughtException);
    process.stderr.removeListener("error", ignoreOutputFailure);
    process.stdout.removeListener("error", ignoreOutputFailure);
    installed = false;
  };
};

export const isCrashHandlerInstalled = (): boolean => installed;
