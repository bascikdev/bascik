/**
 * Global setup for the `integration` Vitest project (vite.config.js): fails
 * the run when a test left a process running, and names each one (PID, age,
 * command line). Integration tests spawn real CLI builds, servers, and exec
 * scripts; one that is not ended on a failure path outlives the run as an
 * orphan that nothing else notices.
 *
 * The detection, and what it cannot see, is in
 * src/lib/process-leak-guard.test-helper.ts. This file only wires it to
 * Vitest: the run ID goes into `process.env` here, before the first worker
 * starts, so every worker and everything the tests spawn inherits it. An
 * error thrown from the returned teardown makes Vitest exit with code 1.
 */
import {
  createProcessLeakGuard,
  formatAbandonedReport,
  formatLeakReport,
  LEAK_GUARD_ENV,
} from "./src/lib/process-leak-guard.test-helper.ts";

export default async function setup(): Promise<
  (() => Promise<void>) | undefined
> {
  // No `ps` to ask.
  if (process.platform === "win32") return undefined;
  const guard = createProcessLeakGuard({ rootPid: process.pid });
  process.env[LEAK_GUARD_ENV] = guard.marker;
  // A run that was killed (a closed terminal, a canceled job) never got to
  // its own teardown below. What it left is ended here, before it can hold a
  // port this run needs, and reported without failing this run.
  const abandoned = await guard.sweepAbandoned();
  if (abandoned.length > 0) console.warn(formatAbandonedReport(abandoned));
  guard.start();
  return async () => {
    const { checked, leaks } = await guard.finish();
    if (!checked) {
      console.warn(
        "Leak guard: could not read the process table with ps, so leaked processes were not checked.",
      );
      return;
    }
    if (leaks.length === 0) return;
    const error = new Error(formatLeakReport(leaks));
    // The report is the whole message; a stack into this file adds nothing.
    error.stack = error.message;
    throw error;
  };
}
