import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { matchesGlob, resolve, sep } from "node:path";
import { BascikConfig } from "./config.ts";
import { eventEmitter } from "./events.ts";
import { registerExitStopper } from "./exit-stoppers.ts";
import { formatDuration } from "./format.ts";
import { logInfo } from "./log.ts";
import { stdout as colorOut } from "./colors.ts";
import { getSiteUrl } from "./environment.ts";
import {
  nativeClock,
  type FrameworkClock,
  type TimeoutHandle,
} from "./clock.ts";
import { getExecErrorAction, stopAfterExecFailure } from "./exec-policy.ts";
import type { ExecEntry, ExecPhase } from "./types.ts";
import { GLOB_META } from "./watch-root.ts";

export interface ExecOptions {
  clock?: FrameworkClock;
}

interface ChildExecutionRecord {
  child: ChildProcess;
  timeoutTimer: TimeoutHandle | null;
  escalationTimer: TimeoutHandle | null;
  settled: boolean;
  /** Set once the timeout fired; the promise rejects when the child is gone. */
  timedOut: boolean;
  /** The processes the script started, listed when it was first signaled. */
  descendants: ListedProcess[];
  /** The entry's `script`, as written, for warnings. */
  script: string;
}

/** How long a timed-out child gets after SIGKILL before the run is given up on. */
const KILL_GRACE_MS = 500;

/** A process from a `ps` snapshot; `started` tells a reused pid apart. */
interface ListedProcess {
  pid: number;
  /** The parent pid when the snapshot was taken. */
  ppid: number;
  /** The start time `ps` reports (`lstart`), or "" where ps has no such column. */
  started: string;
}

/**
 * Every process `ps` lists, by pid, or undefined when it cannot list them.
 * Tried in order: with start times, without them, and the plain POSIX form.
 */
const listProcesses = ():
  Map<number, { ppid: number; started: string }> | undefined => {
  if (process.platform === "win32") return undefined;
  for (const args of [
    ["-A", "-o", "pid=", "-o", "ppid=", "-o", "lstart="],
    ["-A", "-o", "pid=", "-o", "ppid="],
    ["-o", "pid,ppid"],
  ]) {
    let listed: ReturnType<typeof spawnSync>;
    try {
      listed = spawnSync("ps", args, { encoding: "utf8" });
    } catch {
      return undefined;
    }
    if (listed.status !== 0 || typeof listed.stdout !== "string") continue;
    const processes = new Map<number, { ppid: number; started: string }>();
    for (const line of listed.stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)(?:\s+(\S.*?))?\s*$/.exec(line);
      if (!match) continue;
      processes.set(Number(match[1]), {
        ppid: Number(match[2]),
        started: match[3] ?? "",
      });
    }
    return processes;
  }
  return undefined;
};

/**
 * Every process below `roots` in one `ps` snapshot, by root pid. Listed
 * before the root is signaled: once it dies its children are re-parented
 * and can no longer be found. POSIX only; a missing `ps` yields no
 * descendants, and the direct child is still signaled.
 */
const listDescendants = (roots: number[]): Map<number, ListedProcess[]> => {
  const byRoot = new Map<number, ListedProcess[]>(
    roots.map((pid) => [pid, []]),
  );
  if (roots.length === 0) return byRoot;
  const processes = listProcesses();
  if (!processes) return byRoot;
  const children = new Map<number, number[]>();
  for (const [pid, { ppid }] of processes) {
    const siblings = children.get(ppid);
    if (siblings) siblings.push(pid);
    else children.set(ppid, [pid]);
  }
  for (const root of roots) {
    const found: ListedProcess[] = [];
    const queue = [...(children.get(root) ?? [])];
    while (queue.length > 0) {
      const pid = queue.shift()!;
      if (pid === process.pid || found.some((entry) => entry.pid === pid))
        continue;
      const listed = processes.get(pid);
      found.push({
        pid,
        ppid: listed?.ppid ?? root,
        started: listed?.started ?? "",
      });
      queue.push(...(children.get(pid) ?? []));
    }
    byRoot.set(root, found);
  }
  return byRoot;
};

/** The exec script a set of listed processes belongs to, for a re-check. */
interface TreeRoot {
  /** The script's own pid, the top of every listed parent chain. */
  pid: number | undefined;
  /** Whether the script itself is still running, so its pid is still its own. */
  running: boolean;
  /** The entry's `script`, as written, for the warning. */
  script: string;
}

/** Set once the no-start-time warning has been printed. */
let warnedNoStartTime = false;

/**
 * The listed processes that are still the same processes: SIGKILL comes
 * hundreds of milliseconds after the snapshot, and a pid that exited on
 * SIGTERM may belong to another program by then. Matched by start time, not
 * parent, since a descendant whose parent died has been re-parented. When
 * `ps` cannot list processes now, none is confirmed and none is signaled.
 *
 * A `ps` with no start time column (BusyBox `ps -o pid,ppid`) cannot tell a
 * reused pid apart, so there a process is confirmed only by an unchanged
 * parent chain up to the script, while the script itself still runs: no
 * other program can be a child of a live process the script started. A
 * process that cannot be confirmed is not signaled, and Bascik says so once.
 */
const stillRunning = (
  listed: ListedProcess[],
  root: TreeRoot,
): ListedProcess[] => {
  if (listed.length === 0) return listed;
  const processes = listProcesses();
  if (!processes) return [];
  const byPid = new Map(listed.map((entry) => [entry.pid, entry]));
  const chainUnchanged = (entry: ListedProcess): boolean => {
    let current: ListedProcess | undefined = entry;
    for (let depth = 0; current && depth <= listed.length; depth++) {
      if (processes.get(current.pid)?.ppid !== current.ppid) return false;
      if (current.ppid === root.pid) return root.running;
      current = byPid.get(current.ppid);
    }
    return false;
  };
  const unconfirmed: number[] = [];
  const confirmed = listed.filter((entry) => {
    const now = processes.get(entry.pid);
    if (!now) return false;
    if (entry.started !== "") return now.started === entry.started;
    if (chainUnchanged(entry)) return true;
    unconfirmed.push(entry.pid);
    return false;
  });
  if (unconfirmed.length > 0 && !warnedNoStartTime) {
    warnedNoStartTime = true;
    const count =
      unconfirmed.length === 1
        ? "1 process the script started"
        : `${unconfirmed.length} processes the script started`;
    console.warn(
      `[bascik] warning: exec "${root.script}": ps on this system reports no process start times, so ${count} (pid ${unconfirmed.join(", ")}) could not be confirmed as the same process and was not sent SIGKILL. Stop it by hand if it is still running.`,
    );
  }
  return confirmed;
};

/** True while the child has not exited, so its pid cannot belong to anything else. */
const isRunning = (child: ChildProcess): boolean =>
  activeChildren.has(child) &&
  child.exitCode == null &&
  child.signalCode == null;

/** SIGKILL each listed process (already confirmed by stillRunning). */
const killListed = (listed: ListedProcess[]): void => {
  for (const { pid } of listed) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
};

/**
 * Processes a timed-out script left behind, waiting for their SIGKILL, with
 * the timer that sends it. An exit before then sends it at once.
 */
const pendingLeftovers = new Map<
  ListedProcess[],
  { timer: TimeoutHandle; root: TreeRoot }
>();

/**
 * After a timed-out script exits, SIGKILL whatever it started that is still
 * running KILL_GRACE_MS later: a watcher that ignored SIGTERM outlives its
 * parent, and nothing else would stop it once the run has settled.
 */
const killLeftovers = (
  descendants: ListedProcess[],
  root: TreeRoot,
  clock: FrameworkClock,
): void => {
  if (descendants.length === 0) return;
  const timer = clock.setTimeout(() => {
    pendingLeftovers.delete(descendants);
    killListed(stillRunning(descendants, root));
  }, KILL_GRACE_MS);
  if (typeof (timer as any)?.unref === "function") (timer as any).unref();
  pendingLeftovers.set(descendants, { timer, root });
};

/** Send the pending leftover SIGKILLs now (Bascik is exiting). */
const killPendingLeftovers = (clock: FrameworkClock): void => {
  for (const [descendants, { timer, root }] of pendingLeftovers) {
    clock.clearTimeout(timer);
    killListed(stillRunning(descendants, root));
  }
  pendingLeftovers.clear();
};

/** Set once the taskkill warning has been printed. */
let warnedTaskkill = false;

/**
 * Signal an exec child and the processes it started (a watcher a wrapper
 * script spawned, a shell), so none outlives a timeout or Bascik's exit.
 * Windows has no signals: `taskkill /T /F` ends the whole tree, run only
 * while the child has not exited (its pid could name another tree after).
 * A taskkill that cannot run is a warning: the direct child is still
 * stopped. A non-zero exit (128: the process is already gone) is not.
 */
const signalTree = (
  child: ChildProcess,
  signal: NodeJS.Signals,
  descendants: ListedProcess[],
  script: string,
): void => {
  if (
    process.platform === "win32" &&
    child.pid !== undefined &&
    child.exitCode == null &&
    child.signalCode == null
  ) {
    let failure: unknown;
    try {
      failure = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      }).error;
    } catch (error) {
      failure = error;
    }
    if (failure !== undefined && !warnedTaskkill) {
      warnedTaskkill = true;
      const reason =
        failure instanceof Error ? failure.message : String(failure);
      console.warn(
        `[bascik] warning: exec "${script}": could not run taskkill (${reason}), so only the script itself was stopped; processes it started may still be running.`,
      );
    }
  }
  for (const { pid } of descendants) {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
  try {
    child.kill(signal);
  } catch {
    // ignore
  }
};

/** The record's descendants, listed on first use (while the child still holds them). */
const descendantsOf = (record: ChildExecutionRecord): ListedProcess[] => {
  if (record.descendants.length === 0 && record.child.pid !== undefined)
    record.descendants =
      listDescendants([record.child.pid]).get(record.child.pid) ?? [];
  return record.descendants;
};

const activeChildren = new Set<ChildProcess>();
const childRecords = new Map<ChildProcess, ChildExecutionRecord>();
const entryExecutions = new Map<ExecEntry, Promise<number>>();

export const getActiveExecChildrenCount = (): number => activeChildren.size;

export const resetActiveExecChildrenForTests = (): void => {
  for (const { timer } of pendingLeftovers.values())
    nativeClock.clearTimeout(timer);
  pendingLeftovers.clear();
  warnedNoStartTime = false;
  warnedTaskkill = false;
  activeChildren.clear();
  childRecords.clear();
  entryExecutions.clear();
};

/**
 * Cleanup handler for active child processes on process shutdown.
 * Sends SIGTERM, awaits event-driven settlement (or up to 200ms deadline),
 * and sends SIGKILL to any remaining active processes.
 */
export const execShutdownHandler = async (
  options?: ExecOptions,
): Promise<void> => {
  const clock = options?.clock ?? nativeClock;
  killPendingLeftovers(clock);
  if (activeChildren.size === 0) return;
  const childrenToClose = Array.from(activeChildren);
  // One `ps` snapshot for every child, taken before any of them is signaled.
  const trees = listDescendants(
    childrenToClose
      .map((child) => child.pid)
      .filter((pid): pid is number => pid !== undefined),
  );
  const treeOf = (child: ChildProcess): ListedProcess[] => {
    const record = childRecords.get(child);
    const listed = child.pid !== undefined ? (trees.get(child.pid) ?? []) : [];
    if (record) {
      const known = new Set(record.descendants.map((entry) => entry.pid));
      record.descendants = [
        ...record.descendants,
        ...listed.filter((entry) => !known.has(entry.pid)),
      ];
      return record.descendants;
    }
    return listed;
  };

  const closePromises = childrenToClose.map((child) => {
    const script = childRecords.get(child)?.script ?? "";
    const descendants = treeOf(child);
    signalTree(child, "SIGTERM", descendants, script);

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
        removeListeners();
      };

      const removeListeners = () => {
        if (typeof (child as any).removeListener === "function") {
          (child as any).removeListener("close", onClose);
          (child as any).removeListener("error", onClose);
        } else if (typeof (child as any).off === "function") {
          (child as any).off("close", onClose);
          (child as any).off("error", onClose);
        }
      };

      const onClose = () => {
        activeChildren.delete(child);
        childRecords.delete(child);
        // A process the script started may have ignored SIGTERM and outlived
        // it; keep the deadline so SIGKILL still reaches it before exit. The
        // timer now holds the event loop open: with the child gone nothing
        // else may, and the caller's exit must wait for this stop to finish.
        if (descendants.length > 0) {
          removeListeners();
          if (typeof (deadlineTimer as any)?.ref === "function")
            (deadlineTimer as any).ref();
          return;
        }
        cleanup();
        resolve();
      };

      if (typeof (child as any).once === "function") {
        (child as any).once("close", onClose);
        (child as any).once("error", onClose);
      } else {
        child.on("close", onClose);
        child.on("error", onClose);
      }

      deadlineTimer = clock.setTimeout(() => {
        cleanup();
        const confirmed = stillRunning(descendants, {
          pid: child.pid,
          running: isRunning(child),
          script,
        });
        if (activeChildren.has(child))
          signalTree(child, "SIGKILL", confirmed, script);
        else killListed(confirmed);
        resolve();
      }, 200);

      if (typeof (deadlineTimer as any)?.unref === "function") {
        (deadlineTimer as any).unref();
      }
    });
  });

  await Promise.all(closePromises);
};

// An exit stopper, not only a shutdown handler: every exit path runs the
// stoppers (`exitAfterStopping` for CLI failures, a dev bind failure and the
// crash net; `runShutdownHandlers` for SIGINT / SIGTERM and exec-failure
// stops), so no exit leaves a parallel script running in the terminal.
registerExitStopper(() =>
  activeChildren.size > 0 || pendingLeftovers.size > 0
    ? execShutdownHandler()
    : null,
);

export const runScript = (
  entry: ExecEntry,
  options?: ExecOptions,
): Promise<number> => {
  const previous = entryExecutions.get(entry);
  const execution = previous
    ? previous.catch(() => undefined).then(() => spawnScript(entry, options))
    : spawnScript(entry, options);
  entryExecutions.set(entry, execution);
  const cleanup = () => {
    if (entryExecutions.get(entry) === execution) entryExecutions.delete(entry);
  };
  void execution.then(cleanup, cleanup);
  return execution;
};

const spawnScript = (
  entry: ExecEntry,
  options?: ExecOptions,
): Promise<number> => {
  const clock = options?.clock ?? nativeClock;
  const scriptPath = entry.script;
  const entryObj = entry;

  const start = performance.now();
  logInfo(`${colorOut.dim("(started)")} exec: ${scriptPath}`);

  const cwd = entryObj.cwd
    ? resolve(process.cwd(), entryObj.cwd)
    : process.cwd();
  const args = entryObj.args ?? [];
  const timeoutMs = entryObj.timeout ?? 60_000;

  const siteUrl = getSiteUrl() ?? "";
  const pagesDir = resolve(
    process.cwd(),
    BascikConfig.directory?.pages ?? "src/pages",
  );
  const componentRoots = (
    BascikConfig.directory?.components ?? ["src/components"]
  ).map((root) => resolve(process.cwd(), root));

  // `script` is a project path, like every other path in the config (and as
  // config validation checks it); `cwd` only sets the child's working
  // directory. Passing the resolved path keeps Node from resolving a relative
  // script against `cwd`.
  const resolvedScript = resolve(process.cwd(), scriptPath);
  const isInside = (dir: string): boolean =>
    resolvedScript === dir || resolvedScript.startsWith(dir + sep);
  if (isInside(pagesDir) || componentRoots.some(isInside)) {
    console.warn(
      `[bascik] warning: exec script "${scriptPath}" is located inside source directories (pages/components). Keep exec scripts in scripts/ or project root.`,
    );
  }

  const childEnv: Record<string, string> = {
    ...process.env,
    BASCIK_BUILD: BascikConfig.isBuild ? "1" : "0",
    BASCIK_PAGES_DIR: pagesDir,
    BASCIK_OUT_DIR: resolve(
      process.cwd(),
      BascikConfig.directory?.out ?? "dist",
    ),
    BASCIK_BASE: BascikConfig.base ?? "/",
    ...(siteUrl ? { BASCIK_SITE_URL: siteUrl } : {}),
    ...(entryObj.env ?? {}),
  };

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [resolvedScript, ...args], {
      stdio: "inherit",
      cwd,
      env: childEnv,
    });

    const record: ChildExecutionRecord = {
      child,
      timeoutTimer: null,
      escalationTimer: null,
      settled: false,
      timedOut: false,
      descendants: [],
      script: scriptPath,
    };
    const timeoutError = (): Error =>
      new Error(`[bascik] exec "${scriptPath}" timed out after ${timeoutMs}ms`);

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

    // A timeout signals the script and every process it started, then
    // settles once the child has exited, so the next phase never overlaps a
    // dying script. SIGKILL follows 500 ms after SIGTERM; a child still not
    // gone 500 ms after that is given up on.
    if (timeoutMs > 0) {
      record.timeoutTimer = clock.setTimeout(() => {
        record.timeoutTimer = null;
        record.timedOut = true;
        signalTree(child, "SIGTERM", descendantsOf(record), scriptPath);

        record.escalationTimer = clock.setTimeout(() => {
          record.escalationTimer = null;
          if (activeChildren.has(child))
            signalTree(
              child,
              "SIGKILL",
              stillRunning(record.descendants, {
                pid: child.pid,
                running: isRunning(child),
                script: scriptPath,
              }),
              scriptPath,
            );
          record.escalationTimer = clock.setTimeout(() => {
            record.escalationTimer = null;
            if (record.settled) return;
            record.settled = true;
            rejectPromise(timeoutError());
          }, KILL_GRACE_MS);
          if (typeof (record.escalationTimer as any)?.unref === "function") {
            (record.escalationTimer as any).unref();
          }
        }, KILL_GRACE_MS);

        if (typeof (record.escalationTimer as any)?.unref === "function") {
          (record.escalationTimer as any).unref();
        }
      }, timeoutMs);
    }

    child.on("close", (code) => {
      cleanupRecord();
      if (record.settled) return;
      record.settled = true;
      if (record.timedOut) {
        killLeftovers(
          record.descendants,
          { pid: child.pid, running: false, script: scriptPath },
          clock,
        );
        rejectPromise(timeoutError());
        return;
      }
      const elapsed = performance.now() - start;
      if (code === 0) {
        logInfo(
          `${colorOut.green("(completed)")} exec: ${scriptPath} ${colorOut.dim(`in ${formatDuration(elapsed)}`)}`,
        );
        resolvePromise(elapsed);
      } else {
        rejectPromise(
          new Error(`[bascik] exec "${scriptPath}" exited with code ${code}`),
        );
      }
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      cleanupRecord();
      if (record.settled) return;
      record.settled = true;
      // Node reports a missing working directory as `spawn <node> ENOENT`,
      // which blames the Node binary. Name the directory instead.
      if (err?.code === "ENOENT" && entryObj.cwd && !existsSync(cwd)) {
        rejectPromise(
          new Error(
            `[bascik] exec "${scriptPath}": working directory "${entryObj.cwd}" does not exist (${cwd}).`,
            { cause: err },
          ),
        );
        return;
      }
      rejectPromise(err);
    });
  });
};

/** Run exec entries matching the specified phase sequentially in array order. */
export const runExecPhase = async (
  phase: ExecPhase,
  options?: ExecOptions,
): Promise<{ count: number; totalElapsed: number }> => {
  const entries = BascikConfig.pipeline?.exec;
  if (!entries?.length) return { count: 0, totalElapsed: 0 };
  const matching = entries.filter((e) => (e.phase ?? "pre") === phase);
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
export const startExecParallel = (
  options?: ExecOptions,
): ParallelExecHandle => {
  const entries = BascikConfig.pipeline?.exec;
  const matching = entries?.length
    ? entries.filter((e) => e.phase === "parallel")
    : [];
  const tasks: ParallelExecTask[] = matching.map((entry) => ({
    entry,
    promise: runScript(entry, options),
  }));
  const joined = Promise.allSettled(tasks.map((task) => task.promise)).then(
    (results) => {
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          `Parallel exec failed: ${failures.map((result) => String(result.reason)).join("; ")}`,
        );
    },
  );
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
        eventEmitter.emit("exec-completed", { entry, paths });
      })
      .catch((err) => {
        // Single stderr report per failure. The `exec-failed` -> `build-error`
        // path only broadcasts an SSE frame to browser overlays (sse.ts); it
        // does not write to stderr. Under `'error'` the stop message is that
        // one report.
        const stopping = getExecErrorAction() === "error";
        if (!stopping) console.error("[bascik] exec error:", err);
        eventEmitter.emit("exec-failed", { entry, paths, error: err });
        // A parallel script has no caller to reject to once boot has moved on,
        // so `pipeline.onExecError: 'error'` ends the dev session here.
        if (stopping) stopAfterExecFailure(err);
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
