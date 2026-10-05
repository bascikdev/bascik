import { BascikConfig } from './config.ts';
import { eventEmitter, runShutdownHandlers } from './events.ts';

/**
 * What happens when a `pipeline.exec` script fails.
 *
 * - `'error'`: the failure is fatal. A build stops and exits 1; a dev session
 *   reports it and exits 1.
 * - `'warn'`: the failure is reported and the run continues. A dev session
 *   shows a build-error and keeps serving; a build logs it and finishes.
 *
 * The default is the opposite in each mode. A developer working on a script
 * should not lose the dev server on every typo, and a build must never claim
 * success after a script failed. `pipeline.onExecError` flips either one.
 */
export type ExecErrorAction = 'error' | 'warn';

export const getExecErrorAction = (): ExecErrorAction =>
  BascikConfig.pipeline?.onExecError ?? (BascikConfig.isBuild ? 'error' : 'warn');

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Report a failure that the `'warn'` action tolerates. In dev the failure also
 * reaches open browsers as a build-error overlay; a build has no browsers.
 */
export const reportToleratedExecFailure = (error: unknown): void => {
  console.error(
    `[bascik] ${messageOf(error)}\n` +
    `  Continuing because pipeline.onExecError is 'warn'. Set it to 'error' to stop on exec failures.`,
  );
  if (!BascikConfig.isBuild) {
    eventEmitter.emit('build-error', { message: `exec failed: ${messageOf(error)}` });
  }
};

/**
 * Run exec work under the configured action. Resolves true when the work
 * succeeded and false when it failed and the failure was tolerated. Rethrows
 * under `'error'` so the caller's existing failure path (a build exit or the
 * dev boot rejecting) is unchanged.
 */
export const toleratingExecFailure = async (work: () => Promise<unknown>): Promise<boolean> => {
  try {
    await work();
    return true;
  } catch (error) {
    if (getExecErrorAction() === 'error') throw error;
    reportToleratedExecFailure(error);
    return false;
  }
};

interface StopDeps {
  exit?: (code: number) => void;
  runShutdownHandlers?: () => Promise<void>;
}

let stopping = false;

/**
 * End a running dev session after an exec failure under `'error'`. Failures
 * that arrive after boot (an edit cycle, a parallel script) have no caller to
 * reject to, so this closes the server cleanly and exits 1. Safe to call from
 * several failures at once: only the first one acts.
 */
export const stopAfterExecFailure = (error: unknown, deps: StopDeps = {}): void => {
  if (stopping) return;
  stopping = true;
  console.error(`[bascik] ${messageOf(error)}\n  Stopping because pipeline.onExecError is 'error'.`);
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const shutdown = deps.runShutdownHandlers ?? runShutdownHandlers;
  void shutdown().catch(() => undefined).finally(() => {
    stopping = false;
    exit(1);
  });
};
