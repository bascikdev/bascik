import chokidar from 'chokidar';
import { basename, resolve, sep } from 'node:path';
import { BascikConfig } from './config.ts';
import { eventEmitter, registerShutdownHandler } from './events.ts';
import { createSourceCycle } from './source-cycle.ts';
import { execWatchCoversPath, runScript } from './exec.ts';
import { withCompilationPublisher } from './compilation-events.ts';
import { clearBuildScriptCaches } from './build-scripts.ts';
import { invalidateComponentListCache } from './components.ts';
import { mem } from './mem.ts';
import { processAllPages, processPageBatch, removePage } from './processing.ts';
import { copyStaticAssets, copyReplicatePath, deleteDistFile, deleteDistDir } from './file-system.ts';
import { isInlineStylesheet, isStaticAssetPath } from './asset-filter.ts';

/** Watch glob roots, not literal globs: Chokidar 5 no longer expands globs. */
export const sourceWatchRoot = (pattern: string): string => {
  const parts = pattern.replace(/\\/g, '/').split('/');
  const index = parts.findIndex(part => /[?*[\]{}()!+@]/.test(part));
  return index < 0 ? pattern : parts.slice(0, index).join('/') || (pattern.startsWith('/') ? '/' : '.');
};

/** One filesystem observer owns source/exec overlap, including page edits.
 * Outputs are ignored unconditionally. No timestamp or self-write heuristic
 * suppresses legitimate source edits, including edits to a watched script.
 */
export const watchSourceCycles = async (
  invalidateRuntimeModule: (path: string) => void,
  bootCompile?: (compileInitialSources: () => Promise<void>) => Promise<void>,
): Promise<void> => {
  const entries = BascikConfig.pipeline?.exec ?? [];
  const watchPaths = BascikConfig.pipeline?.watchPaths ?? [];
  const execPatterns = entries.flatMap(entry => entry.watch ? Array.isArray(entry.watch) ? entry.watch : [entry.watch] : []);
  const pagesRoot = resolve(BascikConfig.directory.pages);
  const componentRoots = BascikConfig.directory.components.map(root => resolve(root));
  const outRoot = resolve(BascikConfig.directory.out);
  const inside = (path: string, root: string) => path === root || path.startsWith(root + sep);
  const changes = new Map<string, string>();
  const deferred = new Set<string>();
  let booted = false;
  const cycle = createSourceCycle({
    entries,
    run: runScript,
    emitter: eventEmitter,
    compile: async (paths, publish) => withCompilationPublisher(publish, async () => {
      const batchChanges = new Map(paths.map(path => [path, changes.get(path) ?? 'change']));
      for (const path of paths) changes.delete(path);
      const pages = new Set<string>();
      let all = false;
      // Invalidate input-content memoization once after pre writes. Script
      // result caching remains enabled and rechecks the actual dependency bytes.
      clearBuildScriptCaches();
      invalidateComponentListCache();
      for (const path of paths) {
        const kind = batchChanges.get(path)!;
        invalidateRuntimeModule(path);
        const inPages = inside(path, pagesRoot);
        const inComponents = componentRoots.some(root => inside(path, root));
        const extra = execWatchCoversPath(watchPaths, path) || execWatchCoversPath(execPatterns, path);
        const dependents = mem.pagesDependentOnFile(path);
        for (const page of dependents) pages.add(resolve(page));
        if (kind === 'unlinkDir') {
          if (inPages) await deleteDistDir(path);
          all = true;
        } else if (inPages && path.endsWith('.html')) {
          if (kind === 'unlink') { await removePage(path); all = true; }
          else if (kind === 'add') all = true;
          else pages.add(path);
        } else if (inPages && isInlineStylesheet(path)) {
          all = true;
        } else if (inComponents) {
          if (kind === 'add') all = true;
          for (const page of mem.pagesThisComponentIsUsedOn(basename(path).split('.')[0].toLowerCase())) pages.add(resolve(page));
        } else if (extra && dependents.length === 0) {
          // External input or watched script with no known page dependencies:
          // conservatively rebuild pages, but never rerun unmatched exec entries.
          all = true;
        }
        if (inPages && isStaticAssetPath(path) && !isInlineStylesheet(path) && kind !== 'unlinkDir') {
          if (kind === 'unlink') await deleteDistFile(path);
          else await copyReplicatePath(path, BascikConfig.directory.out);
          publish('asset-changed');
        }
      }
      if (all) await processAllPages();
      else if (pages.size) await processPageBatch([...pages]);
    }, { onPageErrors: 'throw' }),
  });
  const onBoot = () => {
    booted = true;
    for (const path of deferred) cycle.enqueue(path);
    deferred.clear();
  };
  eventEmitter.once('boot-done', onBoot);
  const watcher = chokidar.watch([...new Set([
    pagesRoot, ...componentRoots, ...watchPaths.map(sourceWatchRoot), ...execPatterns.map(sourceWatchRoot),
  ])], {
    ignoreInitial: true,
    followSymlinks: true,
    atomic: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
    ignored: path => inside(resolve(path), outRoot),
  });
  watcher.on('all', (kind, changed) => {
    if (!['add', 'change', 'unlink', 'unlinkDir'].includes(kind)) return;
    const path = resolve(changed);
    const owned = inside(path, pagesRoot) || componentRoots.some(root => inside(path, root));
    if (!owned && !execWatchCoversPath([...watchPaths, ...execPatterns], path)) return;
    changes.set(path, kind);
    if (booted) cycle.enqueue(path);
    else deferred.add(path);
  });
  registerShutdownHandler(async () => {
    cycle.close();
    eventEmitter.removeListener('boot-done', onBoot);
    await watcher.close();
    await cycle.idle();
  });
  await new Promise<void>((resolveReady, reject) => {
    watcher.once('ready', resolveReady);
    watcher.once('error', reject);
  });
  watcher.on('error', error => eventEmitter.emit('build-error', { message: error instanceof Error ? error.message : String(error) }));
  const compileInitialSources = async (): Promise<void> => {
    await Promise.all([copyStaticAssets(), processAllPages()]);
  };
  if (bootCompile) {
    await bootCompile(compileInitialSources);
  } else {
    await compileInitialSources();
  }
};