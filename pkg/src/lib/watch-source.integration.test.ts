import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';

const mocks = vi.hoisted(() => ({
  watch: vi.fn(), run: vi.fn(), batch: vi.fn(), all: vi.fn(), remove: vi.fn(),
  deps: vi.fn(), components: vi.fn(), clear: vi.fn(), copy: vi.fn(),
  shutdown: [] as (() => Promise<void>)[],
  config: { directory: { pages: 'src/pages', components: ['src/components'], out: 'dist' }, pipeline: { watchPaths: ['content/*.md'], exec: [{ script: 'scripts/pre.ts', watch: ['content/*.md'] }] } },
}));
vi.mock('chokidar', () => ({ default: { watch: mocks.watch } }));
vi.mock('./config.ts', () => ({ BascikConfig: mocks.config }));
vi.mock('./events.ts', async () => {
  const { EventEmitter } = await import('node:events');
  return { eventEmitter: new EventEmitter(), registerShutdownHandler: (fn: () => Promise<void>) => mocks.shutdown.push(fn) };
});
vi.mock('./exec.ts', async importOriginal => ({ ...await importOriginal<typeof import('./exec.ts')>(), runScript: mocks.run }));
vi.mock('./processing.ts', () => ({ processAllPages: mocks.all, processPageBatch: mocks.batch, removePage: mocks.remove }));
vi.mock('./mem.ts', () => ({ mem: { pagesDependentOnFile: mocks.deps, pagesThisComponentIsUsedOn: mocks.components } }));
vi.mock('./components.ts', () => ({ invalidateComponentListCache: vi.fn() }));
vi.mock('./build-scripts.ts', () => ({ clearBuildScriptCaches: mocks.clear }));
vi.mock('./file-system.ts', () => ({ copyStaticAssets: mocks.copy, copyReplicatePath: mocks.copy, deleteDistFile: mocks.remove, deleteDistDir: mocks.remove }));
vi.mock('./asset-filter.ts', () => ({ isInlineStylesheet: () => false, isStaticAssetPath: () => false }));

import { watchSourceCycles } from './watch-source.ts';
import { eventEmitter } from './events.ts';

let watcher: EventEmitter & { close: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.useFakeTimers();
  for (const mock of [mocks.run, mocks.batch, mocks.all, mocks.remove, mocks.copy]) mock.mockReset().mockResolvedValue(undefined);
  mocks.clear.mockReset();
  mocks.deps.mockReset().mockReturnValue(['src/pages/consumer.html']);
  mocks.components.mockReset().mockReturnValue([]);
  mocks.config.pipeline.watchPaths = ['content/*.md'];
  watcher = Object.assign(new EventEmitter(), { close: vi.fn().mockResolvedValue(undefined) });
  mocks.watch.mockReset().mockImplementation(() => { queueMicrotask(() => watcher.emit('ready')); return watcher; });
});
afterEach(async () => {
  for (const close of mocks.shutdown.splice(0)) await close();
  eventEmitter.removeAllListeners();
  vi.useRealTimers();
});

describe('source observer and phase queue integration', () => {
  it('deduplicates a directly edited page also found under a relative dependency alias', async () => {
    mocks.deps.mockReturnValue(['src/pages/index.html']);
    await watchSourceCycles(vi.fn());
    eventEmitter.emit('boot-done');
    watcher.emit('all', 'change', 'src/pages/index.html');
    await vi.advanceTimersByTimeAsync(50);
    expect(mocks.batch).toHaveBeenCalledExactlyOnceWith([resolve('src/pages/index.html')]);
  });
  it('watches glob roots once, filters nonmatches and output writes, and compiles one associated batch', async () => {
    const pre = Promise.withResolvers<void>();
    mocks.run.mockReturnValueOnce(pre.promise);
    await watchSourceCycles(vi.fn());
    eventEmitter.emit('boot-done');
    expect(mocks.watch).toHaveBeenCalledTimes(1);
    const [roots, options] = mocks.watch.mock.calls[0];
    expect(roots.filter((root: string) => root === 'content')).toHaveLength(1);
    expect(options.ignored(resolve('dist/generated.json'))).toBe(true);
    watcher.emit('all', 'change', 'content/ignored.txt');
    await vi.advanceTimersByTimeAsync(50);
    expect(mocks.run).not.toHaveBeenCalled();
    watcher.emit('all', 'change', 'content/doc.md');
    await vi.advanceTimersByTimeAsync(50);
    expect(mocks.batch).not.toHaveBeenCalled();
    pre.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.batch).toHaveBeenCalledExactlyOnceWith([resolve('src/pages/consumer.html')]);
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it('exec-only source changes rebuild dependents and edits during boot are retained', async () => {
    mocks.config.pipeline.watchPaths = [];
    await watchSourceCycles(vi.fn());
    watcher.emit('all', 'change', 'content/doc.md');
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.run).not.toHaveBeenCalled();
    eventEmitter.emit('boot-done');
    await vi.advanceTimersByTimeAsync(50);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.batch).toHaveBeenCalledExactlyOnceWith([resolve('src/pages/consumer.html')]);
  });

  it('page edits do not rerun unmatched scripts and unknown source dependencies fall back to pages', async () => {
    mocks.deps.mockReturnValue([]);
    await watchSourceCycles(vi.fn());
    eventEmitter.emit('boot-done');
    mocks.all.mockClear();
    watcher.emit('all', 'change', 'src/pages/index.html');
    await vi.advanceTimersByTimeAsync(50);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.batch).toHaveBeenCalledExactlyOnceWith([resolve('src/pages/index.html')]);
    watcher.emit('all', 'change', 'content/doc.md');
    await vi.advanceTimersByTimeAsync(50);
    expect(mocks.all).toHaveBeenCalledTimes(1);
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it('runs the boot compile hook only after the source watcher is ready', async () => {
    const ready = Promise.withResolvers<void>();
    mocks.watch.mockReset().mockImplementation(() => {
      queueMicrotask(() => ready.promise.then(() => watcher.emit('ready')));
      return watcher;
    });
    const bootCompile = vi.fn(async (compileInitialSources: () => Promise<void>) => {
      expect(mocks.copy).not.toHaveBeenCalled();
      expect(mocks.all).not.toHaveBeenCalled();
      await compileInitialSources();
    });

    const watchPromise = watchSourceCycles(vi.fn(), bootCompile);

    expect(bootCompile).not.toHaveBeenCalled();
    ready.resolve();
    await watchPromise;

    expect(bootCompile).toHaveBeenCalledOnce();
    expect(mocks.copy).toHaveBeenCalledTimes(1);
    expect(mocks.all).toHaveBeenCalledTimes(1);
  });
});