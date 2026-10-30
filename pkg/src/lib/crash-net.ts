/**
 * Process-level crash net handlers for unhandled rejections and uncaught exceptions.
 * Logs error details and exits with non-zero exit code.
 *
 * The exit waits, bounded, for the page worker pools to stop: exiting while a
 * page worker is still loading can abort Node 24 (`exit-stoppers.ts`). A
 * Ctrl-C during that wait ends the process at once.
 */
import { flushHeldOutputForExit } from "./ordered-output.ts";
import { exitAfterStopping, isExitInProgress } from "./exit-stoppers.ts";

let installed = false;

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

  installed = true;

  return () => {
    process.removeListener("unhandledRejection", onUnhandledRejection);
    process.removeListener("uncaughtException", onUncaughtException);
    installed = false;
  };
};

export const isCrashHandlerInstalled = (): boolean => installed;
