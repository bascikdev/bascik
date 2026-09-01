import { spawn } from 'node:child_process';
import { BascikConfig } from './config.ts';
import { eventEmitter, registerShutdownHandler } from './events.ts';
import { formatDuration } from './format.ts';
import type { ExecPhase } from './types.ts';

const runScript = (scriptPath: string): Promise<number> => {
  const start = performance.now();
  console.log(`(started) exec: ${scriptPath}`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
    child.on('close', (code) => {
      const elapsed = performance.now() - start;
      if (code === 0) {
        console.log(`(completed) exec: ${scriptPath} in ${formatDuration(elapsed)}`);
        resolve(elapsed);
      } else {
        reject(new Error(`[bascik] exec "${scriptPath}" exited with code ${code}`));
      }
    });
    child.on('error', reject);
  });
};

/** Run exec entries matching the specified phase sequentially in array order. */
export const runExecPhase = async (phase: ExecPhase): Promise<{ count: number; totalElapsed: number }> => {
  const entries = BascikConfig.pipeline?.exec;
  if (!entries?.length) return { count: 0, totalElapsed: 0 };
  const matching = entries.filter((e) => (e.phase ?? 'pre') === phase);
  if (!matching.length) return { count: 0, totalElapsed: 0 };

  const start = performance.now();
  for (const entry of matching) {
    await runScript(entry.script);
  }
  const totalElapsed = performance.now() - start;
  return { count: matching.length, totalElapsed };
};

/** Start parallel exec entries without awaiting their completion. */
export const startExecParallel = (): void => {
  const entries = BascikConfig.pipeline?.exec;
  if (!entries?.length) return;
  const matching = entries.filter((e) => e.phase === 'parallel');
  for (const entry of matching) {
    runScript(entry.script).catch((err) => {
      console.error('[bascik] parallel exec error:', err);
    });
  }
};

/**
 * Fire watch-enabled exec entries async on dev startup and set up chokidar
 * re-run watchers. Build-only entries (no `watch`) are skipped.
 * Returns a Promise that resolves when initial watched exec tasks finish.
 */
export const startExecDev = (): Promise<void> => {
  const entries = BascikConfig.pipeline?.exec;
  if (!entries?.length) return Promise.resolve();
  const watchedEntries = entries.filter((entry) => !!entry.watch);
  if (watchedEntries.length === 0) return Promise.resolve();

  return import('chokidar').then(({ default: chokidar }) => {
    const initialRuns: Promise<unknown>[] = [];

    for (const entry of watchedEntries) {
      if (!entry.watch) continue;
      let running = false;
      let pending = false;

      const triggerRun = () => {
        if (running) {
          pending = true;
          return;
        }
        running = true;
        runScript(entry.script)
          .then(() => eventEmitter.emit('asset-changed'))
          .catch((err) => console.error('[bascik] exec error:', err))
          .finally(() => {
            running = false;
            if (pending) {
              pending = false;
              triggerRun();
            }
          });
      };

      // Non-blocking startup run: no reload needed on first run
      running = true;
      const initialRun = runScript(entry.script)
        .catch((err) => console.error('[bascik] exec error:', err))
        .finally(() => {
          running = false;
          if (pending) {
            pending = false;
            triggerRun();
          }
        });
      initialRuns.push(initialRun);

      const patterns = Array.isArray(entry.watch) ? entry.watch : [entry.watch];
      const watcher = chokidar
        .watch(patterns, { ignoreInitial: true })
        .on('all', () => {
          triggerRun();
        });
      registerShutdownHandler(() => watcher.close());
    }

    return Promise.all(initialRuns).then(() => { });
  });
};
