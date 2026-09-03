import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { BascikConfig } from './config.ts';
import { eventEmitter, registerShutdownHandler } from './events.ts';
import { formatDuration } from './format.ts';
import { getSiteUrl } from './environment.ts';
import type { ExecEntry, ExecPhase } from './types.ts';

const activeChildren = new Set<ChildProcess>();

registerShutdownHandler(async () => {
  if (activeChildren.size === 0) return;
  for (const child of activeChildren) {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
  await new Promise((r) => setTimeout(r, 200));
  for (const child of activeChildren) {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }
});

const runScript = (entry: ExecEntry | string): Promise<number> => {
  const scriptPath = typeof entry === 'string' ? entry : entry.script;
  const entryObj = typeof entry === 'string' ? { script: entry } : entry;

  const start = performance.now();
  console.log(`(started) exec: ${scriptPath}`);

  const cwd = entryObj.cwd ? resolve(process.cwd(), entryObj.cwd) : process.cwd();
  const args = entryObj.args ?? [];
  const timeoutMs = entryObj.timeout ?? 60_000;

  const siteUrl = getSiteUrl() ?? '';
  const pagesDir = resolve(process.cwd(), BascikConfig.directory?.pages ?? 'src/pages');
  const componentsDir = resolve(process.cwd(), BascikConfig.directory?.components ?? 'src/components');

  const resolvedScript = resolve(cwd, scriptPath);
  if (resolvedScript.startsWith(pagesDir) || resolvedScript.startsWith(componentsDir)) {
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
    let timer: NodeJS.Timeout | null = null;
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: 'inherit',
      cwd,
      env: childEnv,
    });

    activeChildren.add(child);

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (activeChildren.has(child)) {
            child.kill('SIGKILL');
          }
        }, 500).unref();
        rejectPromise(new Error(`[bascik] exec "${scriptPath}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    child.on('close', (code) => {
      activeChildren.delete(child);
      if (timer) clearTimeout(timer);
      const elapsed = performance.now() - start;
      if (code === 0) {
        console.log(`(completed) exec: ${scriptPath} in ${formatDuration(elapsed)}`);
        resolvePromise(elapsed);
      } else {
        rejectPromise(new Error(`[bascik] exec "${scriptPath}" exited with code ${code}`));
      }
    });

    child.on('error', (err) => {
      activeChildren.delete(child);
      if (timer) clearTimeout(timer);
      rejectPromise(err);
    });
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
    await runScript(entry);
  }
  const totalElapsed = performance.now() - start;
  return { count: matching.length, totalElapsed };
};

/** Run parallel exec entries concurrently and await their completion before continuing. */
export const startExecParallel = async (): Promise<void> => {
  const entries = BascikConfig.pipeline?.exec;
  if (!entries?.length) return;
  const matching = entries.filter((e) => e.phase === 'parallel');
  if (!matching.length) return;

  await Promise.all(
    matching.map(async (entry) => {
      await runScript(entry);
    }),
  );
};

/**
 * Fire watch-enabled exec entries async on dev startup and set up chokidar
 * re-run watchers with debounce. Build-only entries (no `watch`) are skipped.
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
      let debounceTimer: NodeJS.Timeout | null = null;

      const lastChangedPath = { current: undefined as string | undefined };

      const triggerRun = (changedPath?: string) => {
        if (changedPath) lastChangedPath.current = changedPath;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (running) {
            pending = true;
            return;
          }
          running = true;
          const targetPath = lastChangedPath.current;
          runScript(entry)
            .then(() => {
              eventEmitter.emit('exec-completed', { path: targetPath });
            })
            .catch((err) => console.error('[bascik] exec error:', err))
            .finally(() => {
              running = false;
              if (pending) {
                pending = false;
                triggerRun();
              }
            });
        }, 50);
      };

      // Non-blocking startup run: no reload needed on first run
      running = true;
      const initialRun = runScript(entry)
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
        if (debounceTimer) clearTimeout(debounceTimer);
        return watcher.close();
      });
    }

    return Promise.all(initialRuns).then(() => { });
  });
};
