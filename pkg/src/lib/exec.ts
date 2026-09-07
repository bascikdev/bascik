import { spawn, type ChildProcess } from 'node:child_process';
import { matchesGlob, resolve, sep } from 'node:path';
import { BascikConfig } from './config.ts';
import { eventEmitter, registerShutdownHandler } from './events.ts';
import { formatDuration } from './format.ts';
import { getSiteUrl } from './environment.ts';
import { nativeClock, type FrameworkClock, type TimeoutHandle } from './clock.ts';
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
const entryExecutions = new Map<ExecEntry, Promise<number>>();

export const getActiveExecChildrenCount = (): number => activeChildren.size;

export const resetActiveExecChildrenForTests = (): void => {
  activeChildren.clear();
  childRecords.clear();
  entryExecutions.clear();
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

export const runScript = (entry: ExecEntry | string, options?: ExecOptions): Promise<number> => {
  if (typeof entry === 'string') return spawnScript(entry, options);
  const previous = entryExecutions.get(entry);
  const execution = previous
    ? previous.catch(() => undefined).then(() => spawnScript(entry, options))
    : spawnScript(entry, options);
  entryExecutions.set(entry, execution);
  const cleanup = () => { if (entryExecutions.get(entry) === execution) entryExecutions.delete(entry); };
  void execution.then(cleanup, cleanup);
  return execution;
};

const spawnScript = (entry: ExecEntry | string, options?: ExecOptions): Promise<number> => {
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

/** One started parallel entry and the promise that settles when its child exits. */
export interface ParallelExecTask {
  entry: ExecEntry;
  promise: Promise<number>;
}

/**
 * The parallel phase as a whole: a promise that joins every parallel entry
 * (build awaits it before writing `dist/`) plus the individual tasks so the
 * dev lifecycle owner can publish each outcome as it arrives instead of
 * waiting for the join.
 */
export type ParallelExecHandle = Promise<void> & { tasks: ParallelExecTask[] };

/**
 * Start every `phase: 'parallel'` entry concurrently.
 *
 * The returned handle joins all settlements and aggregates failures. It also carries `tasks`, one per
 * entry. Build awaits the join before `dist/` finalization. Dev does not
 * await it: the server binds and pages compile while the entries run, and
 * `startExecDev` observes each settlement and reports failures without
 * scheduling compilation.
 */
export const startExecParallel = (options?: ExecOptions): ParallelExecHandle => {
  const entries = BascikConfig.pipeline?.exec;
  const matching = entries?.length ? entries.filter((e) => e.phase === 'parallel') : [];
  const tasks: ParallelExecTask[] = matching.map((entry) => ({
    entry,
    promise: runScript(entry, options),
  }));
  const joined = Promise.allSettled(tasks.map((task) => task.promise)).then(results => {
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), `Parallel exec failed: ${failures.map(result => String(result.reason)).join('; ')}`);
  });
  // Observe immediately across the lazy dev-server import gap. Keep the
  // original rejected handle for build callers and per-task dev reporting.
  void joined.catch(() => undefined);
  return Object.assign(joined, { tasks });
};

/**
 * Publish each parallel task's outcome through the same events the watched
 * script path uses. The dev lifecycle owner reports build-error on failure.
 * Success never invalidates caches, compiles pages, or sends a reload.
 * Every task is observed independently as it settles. Startup has no source
 * edits, so `paths` is empty.
 *
 * The joined handle is marked observed here because each rejection it adopts
 * is published individually below; nothing is swallowed.
 */
const publishParallelOutcomes = (handle: ParallelExecHandle): void => {
  handle.then(
    () => undefined,
    () => undefined,
  );
  for (const { entry, promise } of handle.tasks) {
    const paths: string[] = [];
    promise
      .then(() => {
        eventEmitter.emit('exec-completed', { entry, paths });
      })
      .catch((err) => {
        // Single stderr report per failure. The `exec-failed` -> `build-error`
        // path only broadcasts an SSE frame to browser overlays (sse.ts); it
        // does not write to stderr, so this is the one terminal line.
        console.error('[bascik] exec error:', err);
        eventEmitter.emit('exec-failed', { entry, paths, error: err });
      });
  }
};

export interface ExecDevOptions extends ExecOptions {
  /**
   * The parallel phase handle returned by `startExecParallel`, retained (not
   * awaited) by the dev branch of `transpile.ts`. Its outcomes are registered
   * synchronously before any watcher work so no settlement can be missed.
   */
  parallel?: ParallelExecHandle;
}

/**
 * Observe startup parallel outcomes without running scripts a second time.
 * Source watcher registration and edit phases belong to watch-source.ts.
 * Registration is synchronous so settlements cannot be lost during boot.
 */
export const startExecDev = (options?: ExecDevOptions): Promise<void> => {
  if (options?.parallel) publishParallelOutcomes(options.parallel);
  // watch.ts owns a single source watcher and phase queue. Registering a
  // second exec watcher here would race it and compile the same edit twice.
  return Promise.resolve();
};

/** Glob metacharacters recognized by `path.matchesGlob` (minimatch syntax). */
const GLOB_META = /[?*[\]{}()!+@]/;

/** Resolve a path or glob against cwd and normalize separators to `/`. */
const toAbsolutePosix = (p: string): string =>
  resolve(process.cwd(), p).replace(/\\/g, "/");

/**
 * True when `changedPath` (relative or absolute) is covered by an exec watch
 * pattern, ignoring the producer's own script so a generator does not
 * re-trigger itself (cyclic self-watch).
 *
 * Both sides are resolved against cwd first, so `./content`, `content/`,
 * `/abs/content`, and chokidar's absolute or relative report paths all
 * compare on the same footing. Glob patterns (`content/*.md`,
 * `content/**\/*.md`, `src/data/*.json`) use a real matcher; a non-glob
 * pattern is a directory or file base that matches itself and every
 * descendant, so `watch: ['content']` behaves like `'content/'` and
 * `'content/**'`. This gate sits in front of the exec re-run, so a false
 * negative here drops a required edit; a false positive only over-watches.
 */
export const execWatchCoversPath = (
  patterns: string[],
  changedPath: string,
  script?: string,
): boolean => {
  const abs = toAbsolutePosix(changedPath);

  if (script) {
    const absScript = toAbsolutePosix(script);
    if (abs === absScript || abs.startsWith(`${absScript}/`)) return false;
  }

  return patterns.some((pattern) => {
    const pat = pattern.replace(/\\/g, "/");
    if (GLOB_META.test(pat)) {
      return matchesGlob(abs, toAbsolutePosix(pat));
    }
    const base = toAbsolutePosix(pat.endsWith("/") ? pat.slice(0, -1) : pat);
    return abs === base || abs.startsWith(`${base}/`);
  });
};
