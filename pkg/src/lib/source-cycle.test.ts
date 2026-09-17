import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createSourceCycle } from './source-cycle.ts';

const gate = () => Promise.withResolvers<void>();
afterEach(() => vi.useRealTimers());

const assertNoListenerLeak = (target: EventEmitter, expectedBaseline: ReturnType<EventEmitter['rawListeners']>) => {
  expect(target.rawListeners('build-error')).toEqual(expectedBaseline);
};

describe('source-owned phase cycles', () => {
  it('retains earlier page reloads when another source edit arrives during compilation', async () => {
    vi.useFakeTimers();
    const first = gate();
    const emitter = new EventEmitter();
    const reload = vi.fn();
    emitter.on('transpiled', reload);
    let count = 0;
    const cycle = createSourceCycle({
      entries: [], run: vi.fn(), emitter,
      compile: async (_paths, publish) => {
        publish('transpiled', { relativePagePath: `${++count}.html` });
        if (count === 1) await first.promise;
      },
    });
    cycle.enqueue('src/pages/a.html');
    await vi.advanceTimersByTimeAsync(50);
    cycle.enqueue('src/pages/b.html');
    first.resolve();
    await vi.advanceTimersByTimeAsync(50);
    expect(reload.mock.calls).toEqual([[{ relativePagePath: '1.html' }], [{ relativePagePath: '2.html' }]]);
    cycle.close();
  });

  it('reruns a script when its own explicitly watched source is edited', async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockResolvedValue(undefined);
    const cycle = createSourceCycle({ entries: [{ script: 'scripts/pre.ts', watch: ['scripts/*.ts'] }], run, compile: vi.fn().mockResolvedValue(undefined), emitter: new EventEmitter() });
    cycle.enqueue('scripts/pre.ts');
    await vi.advanceTimersByTimeAsync(50);
    expect(run).toHaveBeenCalledTimes(1);
    cycle.close();
  });
  it('coalesces overlap, awaits pre, starts parallel alongside compile, then post', async () => {
    vi.useFakeTimers();
    const pre = gate();
    const parallel = gate();
    const order: string[] = [];
    const compile = vi.fn(async () => { order.push('compile'); });
    const cycle = createSourceCycle({
      entries: [
        { script: 'pre.ts', watch: ['content/'] },
        { script: 'parallel.ts', phase: 'parallel', watch: ['content/'] },
        { script: 'post.ts', phase: 'post', watch: ['content/'] },
        { script: 'unmatched.ts', watch: ['other/'] },
      ],
      run: async (entry) => {
        order.push(entry.script);
        if (entry.script === 'pre.ts') await pre.promise;
        if (entry.script === 'parallel.ts') await parallel.promise;
      },
      compile,
      emitter: new EventEmitter(),
    });
    cycle.enqueue('content/a.md');
    cycle.enqueue(`${process.cwd()}/content/a.md`);
    await vi.advanceTimersByTimeAsync(50);
    expect(order).toEqual(['pre.ts']);
    pre.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['pre.ts', 'parallel.ts', 'compile', 'post.ts']);
    expect(compile).toHaveBeenCalledTimes(1);
    parallel.resolve();
    await cycle.idle();
    expect(compile).toHaveBeenCalledTimes(1);
    cycle.close();
  });

  it('retains edits during pre and compilation and retries after a failed pre', async () => {
    vi.useFakeTimers();
    const pre = gate();
    const compileGate = gate();
    const emitter = new EventEmitter();
    const errors: unknown[] = [];
    emitter.on('build-error', error => errors.push(error));
    const run = vi.fn().mockImplementationOnce(() => pre.promise).mockResolvedValue(undefined);
    const compile = vi.fn().mockImplementationOnce(() => compileGate.promise).mockResolvedValue(undefined);
    const cycle = createSourceCycle({ entries: [{ script: 'pre.ts', watch: ['content/'] }], run, compile, emitter });
    cycle.enqueue('content/a.md');
    await vi.advanceTimersByTimeAsync(50);
    cycle.enqueue('content/b.md');
    pre.reject(new Error('pre failed'));
    await vi.advanceTimersByTimeAsync(50);
    expect(errors).toHaveLength(1);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(compile.mock.calls[0][0]).toEqual(expect.arrayContaining([
      `${process.cwd()}/content/a.md`, `${process.cwd()}/content/b.md`,
    ]));
    cycle.enqueue('content/c.md');
    compileGate.resolve();
    await vi.advanceTimersByTimeAsync(50);
    await cycle.idle();
    expect(compile).toHaveBeenCalledTimes(2);
    cycle.close();
  });

  it('does not serialize later page edits behind parallel scripts or rerun unmatched scripts', async () => {
    vi.useFakeTimers();
    const parallel = gate();
    const run = vi.fn(() => parallel.promise);
    const compile = vi.fn().mockResolvedValue(undefined);
    const cycle = createSourceCycle({ entries: [{ script: 'p.ts', phase: 'parallel', watch: ['content/'] }], run, compile, emitter: new EventEmitter() });
    cycle.enqueue('content/a.md');
    await vi.advanceTimersByTimeAsync(50);
    cycle.enqueue('src/pages/index.html');
    await vi.advanceTimersByTimeAsync(50);
    expect(compile).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(1);
    parallel.resolve();
    await cycle.idle();
    cycle.close();
  });

  it('holds success publication through post, discards it on failure, and never publishes parallel completion', async () => {
    vi.useFakeTimers();
    const emitter = new EventEmitter();
    const reload = vi.fn();
    emitter.on('transpiled', reload);
    const post = gate();
    const cycle = createSourceCycle({
      entries: [{ script: 'post.ts', phase: 'post', watch: ['content/'] }],
      run: () => post.promise,
      compile: async (_paths, publish) => { publish('transpiled', { relativePagePath: 'index.html' }); },
      emitter,
    });
    cycle.enqueue('content/a.md');
    await vi.advanceTimersByTimeAsync(50);
    expect(reload).not.toHaveBeenCalled();
    post.reject(new Error('post failed'));
    await cycle.idle();
    expect(reload).not.toHaveBeenCalled();
    cycle.close();
  });

  it('rejects a retained error listener using the workload settlement oracle', () => {
    const emitter = new EventEmitter();
    const baseline = emitter.rawListeners('build-error');
    const leak = () => {};
    emitter.on('build-error', leak);
    try {
      expect(() => assertNoListenerLeak(emitter, baseline)).toThrow();
    } finally {
      emitter.removeListener('build-error', leak);
    }
    assertNoListenerLeak(emitter, baseline);
  });

  it('settles 100 repeated same-two-path cycles with exact publications, paths, baseline listeners, recovery, and zero timers', async () => {
    vi.useFakeTimers();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const emitter = new EventEmitter();
    const testErrorListener = vi.fn();
    emitter.on('build-error', testErrorListener);
    const baseline = emitter.rawListeners('build-error');
    expect(baseline).toHaveLength(1);
    expect(baseline[0]).toBe(testErrorListener);

    const emittedPublications: [string, unknown][] = [];
    const transpiledListener = (payload: unknown) => {
      emittedPublications.push(['transpiled', payload]);
    };
    emitter.on('transpiled', transpiledListener);

    const pathA = `${process.cwd()}/src/pages/a.html`;
    const pathB = `${process.cwd()}/src/pages/b.html`;
    const expectedPaths = [pathA, pathB].sort();

    const makeAttempt = (index: number) => ({
      index,
      compile: gate(),
      post: gate(),
      parallel: gate(),
      compileEntered: gate(),
      postEntered: gate(),
      postStarted: false,
      parallelSettled: false,
    });
    let current = makeAttempt(0);
    const parallelTasks: Promise<void>[] = [];
    const compilePaths: string[][] = [];

    const cycle = createSourceCycle({
      entries: [
        {
          script: 'parallel.ts',
          phase: 'parallel',
          watch: ['src/pages/'],
        },
        {
          script: 'post.ts',
          phase: 'post',
          watch: ['src/pages/'],
        },
      ],
      run: (entry) => {
        const state = current;
        if (entry.phase === 'parallel') {
          const task = state.parallel.promise.then(() => { state.parallelSettled = true; });
          parallelTasks.push(task);
          return task;
        }
        if (entry.phase === 'post') {
          state.postStarted = true;
          state.postEntered.resolve();
          return state.post.promise;
        }
        throw new Error(`Unexpected source-cycle phase: ${entry.phase}`);
      },
      compile: async (paths, publish) => {
        const state = current;
        compilePaths.push([...paths].sort());
        publish('transpiled', { cyclePaths: [...paths].sort(), attempt: state.index });
        state.compileEntered.resolve();
        await state.compile.promise;
      },
      emitter,
    });

    const failureIndex = 42;
    const failure = new Error(`compile failure at attempt ${failureIndex}`);
    const expectedPublications: [string, unknown][] = [];

    try {
      for (let attempt = 0; attempt <= 100; attempt++) {
        current = makeAttempt(attempt);

        if (attempt === failureIndex + 1) {
          // Only re-enqueue a: recovery must also retain failed path b.
          cycle.enqueue('src/pages/a.html');
        } else {
          cycle.enqueue('src/pages/a.html');
          cycle.enqueue('src/pages/b.html');
        }

        await vi.advanceTimersByTimeAsync(50);
        await current.compileEntered.promise;

        expect(compilePaths).toHaveLength(attempt + 1);
        expect(compilePaths[attempt]).toEqual(expectedPaths);
        expect(parallelTasks).toHaveLength(attempt + 1);
        expect(current.postStarted).toBe(false);
        expect(emittedPublications).toEqual(expectedPublications);

        if (attempt === failureIndex) {
          current.compile.reject(failure);
          await cycle.idle();
          expect(current.postStarted).toBe(false);
          expect(testErrorListener.mock.calls).toEqual([[{ message: failure.message, file: undefined }]]);
          expect(emittedPublications).toEqual(expectedPublications);
        } else {
          current.compile.resolve();
          await current.postEntered.promise;
          expect(emittedPublications).toEqual(expectedPublications);
          current.post.resolve();
          await cycle.idle();
          expectedPublications.push(['transpiled', { cyclePaths: expectedPaths, attempt }]);
          expect(emittedPublications).toEqual(expectedPublications);
        }

        // idle joins compilation/post, not this still-held parallel task.
        expect(current.parallelSettled).toBe(false);
        current.parallel.resolve();
        await Promise.all(parallelTasks);
        expect(current.parallelSettled).toBe(true);
        assertNoListenerLeak(emitter, baseline);
        expect(vi.getTimerCount()).toBe(0);
      }

      expect(compilePaths).toHaveLength(101);
      expect(parallelTasks).toHaveLength(101);
      expect(emittedPublications).toHaveLength(100);
      expect(testErrorListener.mock.calls).toEqual([[{ message: failure.message, file: undefined }]]);
      expect(consoleSpy.mock.calls).toEqual([['[bascik] source cycle error:', failure]]);
    } finally {
      cycle.close();
      current.compile.resolve();
      current.post.resolve();
      current.parallel.resolve();
      try {
        await Promise.all([cycle.idle(), ...parallelTasks]);
      } finally {
        emitter.removeListener('build-error', testErrorListener);
        emitter.removeListener('transpiled', transpiledListener);
        consoleSpy.mockRestore();
      }
    }
  });
});