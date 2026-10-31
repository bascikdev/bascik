import { AsyncLocalStorage } from "node:async_hooks";
import type { EventEmitter } from "node:events";
import { resolve } from "node:path";
import type { ExecEntry } from "./types.ts";
import { execWatchCoversPath } from "./exec.ts";
import { locateBuildError } from "./build-error.ts";
import {
  nativeClock,
  type FrameworkClock,
  type TimeoutHandle,
} from "./clock.ts";

export type PublishCompilation = (event: string, payload?: unknown) => void;

/**
 * The cycle whose work is running in the current async context. The shared
 * emitter also carries build-errors that are not a cycle's own: a parallel
 * script an earlier cycle started failing during a later compile, a startup
 * parallel script, a watcher error. A cycle fails only for a build-error
 * emitted from inside its own work (pre, parallel, compile, post), which
 * runs in this context; anything else is reported by its source and leaves
 * the cycle's publications and paths alone.
 */
const cycleScope = new AsyncLocalStorage<object>();

/** A source edit owns one pre -> (parallel + compile) -> post cycle.
 * No completion event can enqueue work. Edits received during work are retained.
 */
export const createSourceCycle = (options: {
  entries: ExecEntry[];
  run: (entry: ExecEntry) => Promise<unknown>;
  compile: (paths: string[], publish: PublishCompilation) => Promise<void>;
  emitter: EventEmitter;
  clock?: FrameworkClock;
  /** Called for every exec script failure after it was reported as a build-error. */
  onExecFailure?: (error: unknown, entry: ExecEntry) => void;
  /**
   * Decides whether a publication is emitted the moment compilation produces it instead of being held
   * until the whole cycle succeeds. Used only when no post script matches the edit, since a post script
   * is what the hold exists to wait for. A tab showing a page can then reload as soon as that page is ready.
   */
  publishEarly?: (event: string, payload: unknown) => boolean;
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
    console.error("[bascik] source cycle error:", error);
    // A failing exec script is named by its entry. A compile failure may carry the file and line of the
    // build script that threw, found through the wrappers the compile scope puts around it.
    const location = entry ? undefined : locateBuildError(error);
    options.emitter.emit("build-error", {
      message: error instanceof Error ? error.message : String(error),
      file: entry?.script,
      ...(location ?? {}),
    });
  };
  const runEntry = async (entry: ExecEntry) => {
    try {
      await options.run(entry);
    } catch (error) {
      report(error, entry);
      options.onExecFailure?.(error, entry);
      throw error;
    }
  };
  const schedule = () => {
    if (closed || running || timer !== undefined || !pending.size) return;
    timer = clock.setTimeout(() => {
      timer = undefined;
      running = flush().finally(() => {
        running = undefined;
        schedule();
      });
    }, 50);
  };
  const flush = async () => {
    const paths = [...new Set([...failed, ...pending])];
    pending.clear();
    failed.clear();
    const matching = options.entries.filter((entry) => {
      const patterns = entry.watch
        ? Array.isArray(entry.watch)
          ? entry.watch
          : [entry.watch]
        : [];
      return paths.some((path) => execWatchCoversPath(patterns, path));
    });
    const publications: [string, unknown][] = [];
    const hasPostScript = matching.some((entry) => entry.phase === "post");
    let hadError = false;
    const cycleToken = {};
    const onError = () => {
      if (cycleScope.getStore() === cycleToken) hadError = true;
    };
    options.emitter.on("build-error", onError);
    try {
      await cycleScope.run(cycleToken, async () => {
        for (const entry of matching.filter(
          (entry) => (entry.phase ?? "pre") === "pre",
        ))
          await runEntry(entry);
        if (closed) return;
        for (const entry of matching.filter(
          (entry) => entry.phase === "parallel",
        )) {
          // Serialize the same producer across edits without blocking compilation
          // or independent producers. Every queued invocation is retained.
          const previous = parallelTails.get(entry);
          const task = (
            previous ? previous.then(() => runEntry(entry)) : runEntry(entry)
          ).catch(() => undefined);
          parallelTails.set(entry, task);
          void task.then(() => {
            if (parallelTails.get(entry) === task) parallelTails.delete(entry);
          });
        }
        await options.compile(paths, (event, payload) => {
          if (
            !hasPostScript &&
            !closed &&
            options.publishEarly?.(event, payload)
          ) {
            options.emitter.emit(event, payload);
            return;
          }
          publications.push([event, payload]);
        });
        if (hadError) throw new Error("Source compilation failed");
        for (const entry of matching.filter((entry) => entry.phase === "post"))
          await runEntry(entry);
        if (!hadError && !closed) {
          for (const [event, payload] of publications) {
            heldPublications.set(`${event}:${JSON.stringify(payload)}`, [
              event,
              payload,
            ]);
          }
          if (pending.size === 0) {
            for (const [event, payload] of heldPublications.values())
              options.emitter.emit(event, payload);
            heldPublications.clear();
          }
        }
      });
    } catch (error) {
      for (const path of paths) failed.add(path);
      if (!hadError) report(error);
    } finally {
      options.emitter.removeListener("build-error", onError);
    }
  };
  return {
    enqueue(path: string) {
      if (closed) return;
      pending.add(resolve(process.cwd(), path.replace(/\\/g, "/")));
      schedule();
    },
    async idle() {
      await running;
    },
    close() {
      closed = true;
      if (timer !== undefined) clock.clearTimeout(timer);
      pending.clear();
    },
  };
};
