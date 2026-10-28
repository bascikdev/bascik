/**
 * Process-level crash net handlers for unhandled rejections and uncaught exceptions.
 * Logs error details and exits with non-zero exit code.
 */
import { flushHeldOutputForExit } from "./ordered-output.ts";

let installed = false;

export const installProcessCrashHandlers = (): (() => void) => {
  // A handler runs in the context of whatever threw. Inside a task whose
  // output is held (a component manifest build), the message would be held
  // with it and lost on exit: write what is held, then print unheld.
  const onUnhandledRejection = (reason: unknown) => {
    flushHeldOutputForExit();
    console.error("[bascik] Fatal unhandled promise rejection:", reason);
    process.exit(1);
  };

  const onUncaughtException = (error: Error) => {
    flushHeldOutputForExit();
    console.error("[bascik] Fatal uncaught exception:", error);
    process.exit(1);
  };

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
