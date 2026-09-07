import type { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import type { ExecEntry } from './types.ts';
import { execWatchCoversPath } from './exec.ts';
import { nativeClock, type FrameworkClock, type TimeoutHandle } from './clock.ts';

export type PublishCompilation = (event: string, payload?: unknown) => void;

/** A source edit owns one pre -> (parallel + compile) -> post cycle.
 * No completion event can enqueue work. Edits received during work are retained.
 */
export const createSourceCycle = (options: {
  entries: ExecEntry[];
  run: (entry: ExecEntry) => Promise<unknown>;
  compile: (paths: string[], publish: PublishCompilation) => Promise<void>;
  emitter: EventEmitter;
  clock?: FrameworkClock;
}) => {
  const clock = options.clock ?? nativeClock;
  const pending = new Set<string>();
  const failed = new Set<string>();
  const heldPublications = new Map<string, [string, unknown]>();
  const parallelTails = new Map<ExecEntry, Promise<void>>();
  let timer: TimeoutHandle | undefined;
  let running: Promise<void> | undefined;
  let closed = false;

  const report = (error: unknown, entry?: ExecEntry) => {
    console.error('[bascik] source cycle error:', error);
    options.emitter.emit('build-error', {
      message: error instanceof Error ? error.message : String(error),
      file: entry?.script,
    });
  };
  const runEntry = async (entry: ExecEntry) => {
    try { await options.run(entry); }
    catch (error) { report(error, entry); throw error; }
  };
  const schedule = () => {
    if (closed || running || timer !== undefined || !pending.size) return;
    timer = clock.setTimeout(() => {
      timer = undefined;
      running = flush().finally(() => { running = undefined; schedule(); });
    }, 50);
  };
  const flush = async () => {
    const paths = [...new Set([...failed, ...pending])];
    pending.clear();
    failed.clear();
    const matching = options.entries.filter(entry => {
      const patterns = entry.watch ? Array.isArray(entry.watch) ? entry.watch : [entry.watch] : [];
      return paths.some(path => execWatchCoversPath(patterns, path));
    });
    const publications: [string, unknown][] = [];
    let hadError = false;
    const onError = () => { hadError = true; };
    options.emitter.on('build-error', onError);
    try {
      for (const entry of matching.filter(entry => (entry.phase ?? 'pre') === 'pre')) await runEntry(entry);
      if (closed) return;
      for (const entry of matching.filter(entry => entry.phase === 'parallel')) {
        // Serialize the same producer across edits without blocking compilation
        // or independent producers. Every queued invocation is retained.
        const previous = parallelTails.get(entry);
        const task = (previous ? previous.then(() => runEntry(entry)) : runEntry(entry))
          .catch(() => undefined);
        parallelTails.set(entry, task);
        void task.then(() => { if (parallelTails.get(entry) === task) parallelTails.delete(entry); });
      }
      await options.compile(paths, (event, payload) => publications.push([event, payload]));
      if (hadError) throw new Error('Source compilation failed');
      for (const entry of matching.filter(entry => entry.phase === 'post')) await runEntry(entry);
      if (!hadError && !closed) {
        for (const [event, payload] of publications) {
          heldPublications.set(`${event}:${JSON.stringify(payload)}`, [event, payload]);
        }
        if (pending.size === 0) {
          for (const [event, payload] of heldPublications.values()) options.emitter.emit(event, payload);
          heldPublications.clear();
        }
      }
    } catch (error) {
      for (const path of paths) failed.add(path);
      if (!hadError) report(error);
    } finally {
      options.emitter.removeListener('build-error', onError);
    }
  };
  return {
    enqueue(path: string) {
      if (closed) return;
      pending.add(resolve(process.cwd(), path.replace(/\\/g, '/')));
      schedule();
    },
    async idle() { await running; },
    close() {
      closed = true;
      if (timer !== undefined) clock.clearTimeout(timer);
      pending.clear();
    },
  };
};