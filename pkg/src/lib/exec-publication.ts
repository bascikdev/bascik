import type { ExecEntry } from './types.ts';
import type { EventEmitter } from 'node:events';

/**
 * Exec producer/consumer publication coordinator (prompt 109).
 *
 * A watched exec producer (e.g. a pre-phase generator) may produce output that
 * a page build script consumes. On a source edit covered by both the producer's
 * watch globs and `pipeline.watchPaths`, the producer must finish BEFORE the
 * affected pages re-transpile: otherwise the page compiles against the previous
 * generation, and a later edit can even compile before the producer completes
 * and never publish its finished output.
 *
 * This module gives that overlap contract one owner. It listens for
 * `exec-completed` / `exec-failed`, retains every changed path in a pending
 * generation, and routes the completion through:
 *
 *  1. prompt 98's monotonic publication owner (page re-transpilation and the
 *     `transpiled` SSE event carry a generation so a stale completion cannot
 *     overwrite a newer one),
 *  2. prompt 97's reload/error delivery (only a genuine acceptance emits a
 *     reload; a failed producer publishes an honest build-error and never a
 *     success reload),
 *  3. prompt 99's failed-dependency recovery (a failing consumer page that
 *     reads the produced output records its attempted dependency, so creating
 *     or repairing the producer recovers it through the next valid generation).
 *
 * Unrelated exec entries remain fully concurrent: only paths that a matching
 * producer covers are serialized in front of the consumer compile.
 *
 * The dev parallel phase (prompt 137) publishes through this same owner. In
 * dev `startExecParallel()` is not awaited, so the server binds and pages
 * compile while parallel entries run; `startExecDev` emits `exec-completed` /
 * `exec-failed` per task as it settles, and this coordinator flushes the
 * consumers (or surfaces a build-error) exactly once per generation.
 *
 * Each completion also carries what its producer declared it wrote
 * (`ExecEntry.outputs`, prompt 139). The generation retains the union of those
 * outputs next to the trigger paths and hands both to the consumer flush, which
 * can then recompile only the pages that read the produced files. A producer
 * that declares no outputs marks the generation unscoped and the flush keeps
 * its blanket behavior.
 *
 * Consumer compilation is late-bound: the event listeners are installed by the
 * dev lifecycle owner before `startExecDev`, but the actual recompile
 * function is registered by `watch.ts` during `watchFiles()` because the two
 * watcher fleets register in that order. A completion that lands in between
 * (a fast parallel entry) is retained in the pending generation and flushed
 * when the consumer registers, so it is never dropped and never consumes a
 * generation with nobody to publish to.
 */

/**
 * What the producers that completed in one generation declared they wrote
 * (prompt 139). `scoped` is true only when every completed producer declared
 * `outputs`; a single producer without them falls the whole generation back to
 * the blanket recompile, because its writes are unknown.
 */
export interface ExecFlushOutputs {
  outputs: string[];
  scoped: boolean;
}

export type ConsumerFlush = (paths: string[], declared: ExecFlushOutputs) => Promise<void> | void;

let eventEmitter: EventEmitter | null = null;
/** Late-bound consumer recompile, set by watch.ts. */
let consumerFlush: ConsumerFlush | undefined;

/** Every generator's set of watch globs, for overlap detection in watch.ts. */
let producerWatchGlobs: string[][] = [];

/** Pending overlapped paths awaiting producer completion (one generation). */
const pending = new Set<string>();
/** Union of declared outputs of the producers completed in the pending generation. */
const pendingOutputs = new Set<string>();
/** True once a producer without declared outputs completed in the pending generation. */
let pendingUnscoped = false;

/** Normalize an entry's `outputs` (string or array) to a list of non-empty paths. */
export const execEntryOutputs = (entry: ExecEntry | undefined): string[] => {
  const raw = entry?.outputs;
  if (raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((o): o is string => typeof o === 'string' && o.trim().length > 0);
};
/** Increments per accepted flush; strictly monotonic (prompt 98). */
let generation = 0;
/** True while a producer completion is being flushed. */
let coordinating = false;

/**
 * Register the consumer recompile function. Called by `watch.ts` after its
 * watch-path watchers are set up. Any path flushed by a producer completion is
 * handed to this function, which re-transpiles only the affected pages.
 */
export const registerExecConsumerFlush = (flush: ConsumerFlush): void => {
  consumerFlush = flush;
  // Publish any completion retained while no consumer existed (startup race
  // between a fast parallel entry and watch.ts registration).
  if (pending.size > 0) void flushPending();
};

/**
 * Provide the current pipeline's producer watch globs so `watch.ts` can decide
 * whether a watch-path edit is covered by a producer (and defer to it).
 */
export const setExecProducerWatchGlobs = (globs: string[][]): void => {
  producerWatchGlobs = globs;
};

/**
 * True when any exec producer's watch globs cover `relPath`. Used by watch.ts
 * to defer a watch-path edit until the matching producer(s) complete, so the
 * page never compiles against a not-yet-produced generation.
 */
export const execProducerCovers = (
  isCovered: (patterns: string[]) => boolean,
): boolean => producerWatchGlobs.some(isCovered);

const flushPending = async (): Promise<void> => {
  if (coordinating) return;
  // No consumer yet: hold the generation open. registerExecConsumerFlush
  // drains it the moment a consumer exists.
  if (!consumerFlush) return;
  coordinating = true;
  generation += 1;
  const snapshot = [...pending];
  const declared: ExecFlushOutputs = { outputs: [...pendingOutputs], scoped: !pendingUnscoped };
  pending.clear();
  pendingOutputs.clear();
  pendingUnscoped = false;
  try {
    await consumerFlush(snapshot, declared);
  } catch (err) {
    // Consumer failure was already surfaced by reportPageErrors / processing
    // (prompt 97). Never let it escape unobserved.
    console.error('[bascik] exec consumer flush error:', err);
  } finally {
    coordinating = false;
    if (pending.size > 0) {
      void flushPending();
    }
  }
};

const onExecCompleted = (payload: { entry: ExecEntry; paths: string[] }): void => {
  const paths = Array.isArray(payload.paths) ? payload.paths : [];
  if (paths.length === 0) return;
  for (const p of paths) pending.add(p);
  // Retain what this producer declared it wrote so the flush can target the
  // pages that read those files. A producer without `outputs` marks the
  // generation unscoped: its writes are unknown, so the flush stays blanket.
  const outputs = execEntryOutputs(payload.entry);
  if (outputs.length === 0) {
    pendingUnscoped = true;
  } else {
    for (const o of outputs) pendingOutputs.add(o);
  }
  void flushPending();
};

const onExecFailed = (payload: { entry: ExecEntry; paths: string[]; error: unknown }): void => {
  // Failed required producer work must be surfaced honestly and must never
  // issue a success reload (prompt 97). The consumer pages keep serving their
  // last-known-good representation; a later valid producer run publishes a
  // fresh generation and recovers them (prompt 99).
  for (const p of Array.isArray(payload.paths) ? payload.paths : []) pending.delete(p);
  if (eventEmitter) {
    const message =
      payload.error instanceof Error ? payload.error.message : String(payload.error);
    eventEmitter.emit('build-error', {
      message: `exec producer failed: ${message}`,
      file: payload.entry.script,
      line: undefined,
      column: undefined,
    });
  }
};

/** Install the single exec publication listener (dev lifecycle owner). */
export const installExecPublication = (emitter: EventEmitter): void => {
  if (eventEmitter) {
    eventEmitter.removeListener('exec-completed', onExecCompleted);
    eventEmitter.removeListener('exec-failed', onExecFailed);
  }
  eventEmitter = emitter;
  emitter.on('exec-completed', onExecCompleted);
  emitter.on('exec-failed', onExecFailed);
};

export const _execPublicationTestHooks = {
  get pendingPaths(): string[] {
    return [...pending];
  },
  get pendingOutputs(): string[] {
    return [...pendingOutputs];
  },
  get pendingUnscopedValue(): boolean {
    return pendingUnscoped;
  },
  get generationValue(): number {
    return generation;
  },
  get coordinatingValue(): boolean {
    return coordinating;
  },
  reset(): void {
    pending.clear();
    pendingOutputs.clear();
    pendingUnscoped = false;
    generation = 0;
    coordinating = false;
    producerWatchGlobs = [];
    consumerFlush = undefined;
    eventEmitter = null;
  },
  async flushNow(): Promise<void> {
    await flushPending();
  },
};