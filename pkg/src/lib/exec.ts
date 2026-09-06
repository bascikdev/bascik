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

/** Normalized watch glob list for an exec entry. */
const watcherPatterns = (entry: ExecEntry): string[] =>
  Array.isArray(entry.watch) ? entry.watch : [entry.watch as string];

/**
 * Fire watch-enabled exec entries in dev mode and set up chokidar re-run
 * watchers with debounce.
 *
 * Startup execution is OWNED by the phase runner (`runExecPhase("pre")`,
 * `startExecParallel`, `runExecPhase("post")`), which has already executed a
 * watched entry before this function is called. Registering watch behavior
 * therefore must NOT rerun that already-completed pre/parallel/post work:
 * this function only registers event-driven watchers. Each started producer
 * task is observed, and its outcome reaches the exec publication coordinator
 * (a listener installed by the dev lifecycle owner), never silently dropped.
 */
export const startExecDev = (options?: ExecOptions): Promise<void> => {
  const clock = options?.clock ?? nativeClock;
  const entries = BascikConfig.pipeline?.exec;
  if (!entries?.length) return Promise.resolve();
  const watchedEntries = entries.filter((entry) => !!entry.watch);
  if (watchedEntries.length === 0) return Promise.resolve();

  return import('chokidar').then(({ default: chokidar }) => {
    for (const entry of watchedEntries) {
      if (!entry.watch) continue;
      let running = false;
      let pending = false;
      // Retain every changed path in a pending batch, not just the last
      // filename, so the coordinator can route all of a generation's source
      // and output edits to the affected consumers exactly once.
      const pendingPaths: string[] = [];

      const debouncedAction = debounce(
        () => {
          if (running) {
            pending = true;
            return;
          }
          running = true;
          const batch = [...pendingPaths];
          pendingPaths.length = 0;
          runScript(entry, options)
            .then(() => {
              // The producer lifecycle coordinator flushes consumers after
              // this completion. All started tasks are observed; a genuine
              // failure publishes an honest build-error below.
              eventEmitter.emit('exec-completed', { entry, paths: batch });
            })
            .catch((err) => {
              console.error('[bascik] exec error:', err);
              eventEmitter.emit('exec-failed', { entry, paths: batch, error: err });
            })
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

      const patterns = watcherPatterns(entry);
      const watcher = chokidar
        .watch(patterns, { ignoreInitial: true, persistent: true })
        .on('all', (_event, changedPath) => {
          // Avoid cyclic self-watch: a producer writing its own script or a
          // path it alone owns must not re-trigger itself.
          if (typeof changedPath === 'string') {
            if (!execWatchCoversPath(patterns, changedPath, entry.script)) return;
            pendingPaths.push(changedPath);
          }
          debouncedAction();
        });
      registerShutdownHandler(() => {
        debouncedAction.cancel();
        return watcher.close();
      });
    }
    return Promise.resolve();
  });
};

/**
 * True when `changedPath` (relative or absolute) is covered by an exec watch
 * glob, ignoring the producer's own script so a generator does not re-trigger
 * itself (cyclic self-watch). Conservative overlap only over-watches a
 * generation; it never drops a required edit.
 */
export const execWatchCoversPath = (
  patterns: string[],
  changedPath: string,
  script?: string,
): boolean => {
  const cwdPrefix = `${process.cwd()}/`.replace(/\\/g, "/");
  const normalized = changedPath.replace(/\\/g, "/");
  const rel = normalized.startsWith(cwdPrefix)
    ? normalized.slice(cwdPrefix.length)
    : normalized;

  if (script) {
    const resolvedScript = resolve(process.cwd(), script).replace(/\\/g, "/");
    const relScript = resolvedScript.startsWith(cwdPrefix)
      ? resolvedScript.slice(cwdPrefix.length)
      : resolvedScript;
    if (rel === relScript || rel.startsWith(`${relScript}/`)) return false;
  }

  return patterns.some((pattern) => {
    const pat = pattern.replace(/\\/g, "/");
    if (pat.endsWith("/")) {
      return rel === pat.slice(0, -1) || rel.startsWith(pat);
    }
    if (!/[?*[\]{}()!+@]/.test(pat)) {
      // A literal path pattern serves as a directory base: it matches the path
      // or any descendant, so `watch: ['src/content/docs']` overlaps edits
      // inside that directory exactly as `'src/content/docs/'` would.
      return pat === rel || rel.startsWith(`${pat}/`);
    }
    const base = pat.replace(/[?*[\]{}()!+@]/g, "").replace(/\/\*+/g, "/");
    return rel.startsWith(base) || pat === rel;
  });
};
