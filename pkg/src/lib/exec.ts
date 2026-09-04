import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, sep } from 'node:path';
import { BascikConfig } from './config.ts';
import { eventEmitter, registerShutdownHandler } from './events.ts';
import { formatDuration } from './format.ts';
import { getSiteUrl } from './environment.ts';
import { nativeClock, type FrameworkClock, type TimeoutHandle } from './clock.ts';
import { debounce } from './debounce.ts';
import type { ExecEntry, ExecPhase } from './types.ts';

export interface ExecOptions {
  clock?: FrameworkClock;
}

interface ChildExecutionRecord {
  child: ChildProcess;
  timeoutTimer: TimeoutHandle | null;
  escalationTimer: TimeoutHandle | null;
  settled: boolean;
}

const activeChildren = new Set<ChildProcess>();
const childRecords = new Map<ChildProcess, ChildExecutionRecord>();

export const getActiveExecChildrenCount = (): number => activeChildren.size;

export const resetActiveExecChildrenForTests = (): void => {
  activeChildren.clear();
  childRecords.clear();
};

/**
 * Cleanup handler for active child processes on process shutdown.
 * Sends SIGTERM, awaits event-driven settlement (or up to 200ms deadline),
 * and sends SIGKILL to any remaining active processes.
 */
export const execShutdownHandler = async (options?: ExecOptions): Promise<void> => {
  if (activeChildren.size === 0) return;
  const clock = options?.clock ?? nativeClock;
  const childrenToClose = Array.from(activeChildren);

  const closePromises = childrenToClose.map((child) => {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }

    if (!activeChildren.has(child)) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      let deadlineTimer: TimeoutHandle | null = null;

      const cleanup = () => {
        if (deadlineTimer !== null) {
          clock.clearTimeout(deadlineTimer);
          deadlineTimer = null;
        }
        if (typeof (child as any).removeListener === 'function') {
          (child as any).removeListener('close', onClose);
          (child as any).removeListener('error', onClose);
        } else if (typeof (child as any).off === 'function') {
          (child as any).off('close', onClose);
          (child as any).off('error', onClose);
        }
      };

      const onClose = () => {
        cleanup();
        activeChildren.delete(child);
        childRecords.delete(child);
        resolve();
      };

      if (typeof (child as any).once === 'function') {
        (child as any).once('close', onClose);
        (child as any).once('error', onClose);
      } else {
        child.on('close', onClose);
        child.on('error', onClose);
      }

      deadlineTimer = clock.setTimeout(() => {
        cleanup();
        if (activeChildren.has(child)) {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
        resolve();
      }, 200);

      if (typeof (deadlineTimer as any)?.unref === 'function') {
        (deadlineTimer as any).unref();
      }
    });
  });

  await Promise.all(closePromises);
};

registerShutdownHandler(() => execShutdownHandler());

const runScript = (entry: ExecEntry | string, options?: ExecOptions): Promise<number> => {
  const clock = options?.clock ?? nativeClock;
  const scriptPath = typeof entry === 'string' ? entry : entry.script;
  const entryObj = typeof entry === 'string' ? { script: entry } : entry;

  const start = performance.now();
  console.log(`(started) exec: ${scriptPath}`);

  const cwd = entryObj.cwd ? resolve(process.cwd(), entryObj.cwd) : process.cwd();
  const args = entryObj.args ?? [];
  const timeoutMs = entryObj.timeout ?? 60_000;

  const siteUrl = getSiteUrl() ?? '';
  const pagesDir = resolve(process.cwd(), BascikConfig.directory?.pages ?? 'src/pages');
  const componentRoots = (BascikConfig.directory?.components ?? ['src/components'])
    .map((root) => resolve(process.cwd(), root));

  const resolvedScript = resolve(cwd, scriptPath);
  const isInside = (dir: string): boolean => resolvedScript === dir || resolvedScript.startsWith(dir + sep);
  if (isInside(pagesDir) || componentRoots.some(isInside)) {
    console.warn(`[bascik] warning: exec script "${scriptPath}" is located inside source directories (pages/components). Keep exec scripts in scripts/ or project root.`);
  }

  const childEnv: Record<string, string> = {
    ...process.env,
    BASCIK_BUILD: BascikConfig.isBuild ? '1' : '0',
    BASCIK_PAGES_DIR: pagesDir,
    BASCIK_BASE: BascikConfig.base ?? '/',
    ...(siteUrl ? { BASCIK_SITE_URL: siteUrl } : {}),
    ...(entryObj.env ?? {}),
  };

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: 'inherit',
      cwd,
      env: childEnv,
    });

    const record: ChildExecutionRecord = {
      child,
      timeoutTimer: null,
      escalationTimer: null,
      settled: false,
    };

    activeChildren.add(child);
    childRecords.set(child, record);

    const cleanupRecord = () => {
      activeChildren.delete(child);
      childRecords.delete(child);
      if (record.timeoutTimer !== null) {
        clock.clearTimeout(record.timeoutTimer);
        record.timeoutTimer = null;
      }
      if (record.escalationTimer !== null) {
        clock.clearTimeout(record.escalationTimer);
        record.escalationTimer = null;
      }
    };

    if (timeoutMs > 0) {
      record.timeoutTimer = clock.setTimeout(() => {
        record.timeoutTimer = null;
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }

        record.escalationTimer = clock.setTimeout(() => {
          record.escalationTimer = null;
          if (activeChildren.has(child)) {
            try {
              child.kill('SIGKILL');
            } catch {
              // ignore
            }
          }
        }, 500);

        if (typeof (record.escalationTimer as any)?.unref === 'function') {
          (record.escalationTimer as any).unref();
        }

        if (!record.settled) {
          record.settled = true;
          rejectPromise(new Error(`[bascik] exec "${scriptPath}" timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
    }

    child.on('close', (code) => {
      cleanupRecord();
      if (record.settled) return;
      record.settled = true;
      const elapsed = performance.now() - start;
      if (code === 0) {
        console.log(`(completed) exec: ${scriptPath} in ${formatDuration(elapsed)}`);
        resolvePromise(elapsed);
      } else {
        rejectPromise(new Error(`[bascik] exec "${scriptPath}" exited with code ${code}`));
      }
    });

    child.on('error', (err) => {
      cleanupRecord();
      if (record.settled) return;
      record.settled = true;
      rejectPromise(err);
    });
  });
};

/** Run exec entries matching the specified phase sequentially in array order. */
export const runExecPhase = async (phase: ExecPhase, options?: ExecOptions): Promise<{ count: number; totalElapsed: number }> => {
  const entries = BascikConfig.pipeline?.exec;
  if (!entries?.length) return { count: 0, totalElapsed: 0 };
  const matching = entries.filter((e) => (e.phase ?? 'pre') === phase);
  if (!matching.length) return { count: 0, totalElapsed: 0 };

  const start = performance.now();
  for (const entry of matching) {
    await runScript(entry, options);
  }
  const totalElapsed = performance.now() - start;
  return { count: matching.length, totalElapsed };
};

/** Run parallel exec entries concurrently and await their completion before continuing. */
export const startExecParallel = async (options?: ExecOptions): Promise<void> => {
  const entries = BascikConfig.pipeline?.exec;
  if (!entries?.length) return;
  const matching = entries.filter((e) => e.phase === 'parallel');
  if (!matching.length) return;

  await Promise.all(
    matching.map(async (entry) => {
      await runScript(entry, options);
    }),
  );
};

/**
 * Fire watch-enabled exec entries async on dev startup and set up chokidar
 * re-run watchers with debounce. Build-only entries (no `watch`) are skipped.
 * Returns a Promise that resolves when initial watched exec tasks finish.
 */
export const startExecDev = (options?: ExecOptions): Promise<void> => {
  const clock = options?.clock ?? nativeClock;
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
      const lastChangedPath = { current: undefined as string | undefined };

      const debouncedAction = debounce(
        () => {
          if (running) {
            pending = true;
            return;
          }
          running = true;
          const targetPath = lastChangedPath.current;
          runScript(entry, options)
            .then(() => {
              eventEmitter.emit('exec-completed', { path: targetPath });
            })
            .catch((err) => console.error('[bascik] exec error:', err))
            .finally(() => {
              running = false;
              if (pending) {
                pending = false;
                debouncedAction();
              }
            });
        },
        50,
        { clock },
      );

      const triggerRun = (changedPath?: string) => {
        if (changedPath) lastChangedPath.current = changedPath;
        debouncedAction();
      };

      // Non-blocking startup run: no reload needed on first run
      running = true;
      const initialRun = runScript(entry, options)
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
        .on('all', (_event, changedPath) => {
          triggerRun(typeof changedPath === 'string' ? changedPath : undefined);
        });
      registerShutdownHandler(() => {
        debouncedAction.cancel();
        return watcher.close();
      });
    }

    return Promise.all(initialRuns).then(() => { });
  });
};
