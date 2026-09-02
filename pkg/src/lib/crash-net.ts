/**
 * Process-level crash net handlers for unhandled rejections and uncaught exceptions.
 * Logs error details and exits with non-zero exit code.
 */

let installed = false;

export const installProcessCrashHandlers = (): (() => void) => {
  const onUnhandledRejection = (reason: unknown) => {
    console.error("[bascik] Fatal unhandled promise rejection:", reason);
    process.exit(1);
  };

  const onUncaughtException = (error: Error) => {
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
