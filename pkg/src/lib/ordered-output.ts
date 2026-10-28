/**
 * Run tasks concurrently and print as a one-at-a-time loop would.
 *
 * Each task runs in its own `AsyncLocalStorage` slot. Console calls and
 * stdout/stderr writes made inside a slot are held while the slot is not
 * the turn, and replayed in task order. The turn is the first task whose
 * output has not all been written. It prints live, so a long first task
 * shows its progress as it happens, and an interrupt loses only what a loop
 * would not have printed yet either.
 *
 * Limits:
 * - Only this process's `console.*` and `process.stdout/stderr.write` are
 *   held. A child spawned with `stdio: "inherit"` writes straight to file
 *   descriptor 1 or 2, so its output comes out when it is written, ahead of
 *   held output of earlier tasks. Build scripts are not affected: their
 *   output is piped back and written through the held stream.
 * - A held write is accepted at once: its callback runs on the next tick,
 *   not when the bytes reach the terminal.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { formatWithOptions } from "node:util";

interface Slot {
  writes: Array<() => void>;
  /** Writes go straight through: the slot is the turn, or already written. */
  live: boolean;
  /** The task's output will never be printed (a loop would not have run it). */
  discarded: boolean;
}

const heldOutput = new AsyncLocalStorage<Slot>();
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;
const STDERR_METHODS = new Set<string>(["warn", "error"]);

/** Every run with held output, so a fatal exit can write it all. */
const activeRuns = new Set<{ writeAll: () => void }>();
let holdDepth = 0;

let replayReporter: (error: unknown) => void = (error) =>
  console.error("[bascik] held output could not be written:", error);

/** Run one held write; a failure is reported, and the rest are still written. */
const replay = (write: () => void, reportError: (error: unknown) => void) => {
  try {
    write();
  } catch (error) {
    reportError(error);
  }
};

/**
 * Write every held slot of every run, in task order, and stop holding. For
 * the fatal paths (a crash handler, `process.exit`) that start inside a
 * task: what the task and the tasks before it printed would otherwise be
 * lost with the process, and the fatal message itself must reach the
 * terminal. Outside a task nothing is held back from the caller, so this
 * does nothing and the held output is left as a loop that never reached
 * those tasks would leave it.
 */
export const flushHeldOutputForExit = (): void => {
  if (heldOutput.getStore() === undefined) return;
  // Every run, not only this task's: an earlier run's held text predates it.
  for (const run of activeRuns) run.writeAll();
};

const colorsFor = (stream: NodeJS.WriteStream): boolean =>
  Boolean(stream.isTTY && stream.hasColors?.());

/** The wrappers this module installed, so one is never wrapped twice. */
const wrappers = new WeakSet<object>();

const holdConsoleMethod = (
  method: (typeof CONSOLE_METHODS)[number],
): (() => void) => {
  const original = console[method];
  const stream = STDERR_METHODS.has(method) ? process.stderr : process.stdout;
  const held = (...args: unknown[]) => {
    const slot = heldOutput.getStore();
    if (!slot || slot.live) return original.apply(console, args);
    if (slot.discarded) return;
    // Formatted now, as an unheld call would be: an object the caller
    // changes afterwards prints as it was when it was logged.
    const snapshot = args.every(
      (arg) =>
        arg === null || (typeof arg !== "object" && typeof arg !== "function"),
    )
      ? args
      : [formatWithOptions({ colors: colorsFor(stream) }, ...args)];
    slot.writes.push(() => original.apply(console, snapshot));
  };
  wrappers.add(held);
  console[method] = held;
  return () => {
    if (console[method] === held) console[method] = original;
  };
};

const holdStream = (stream: NodeJS.WriteStream): (() => void) => {
  const original = stream.write as (...args: unknown[]) => boolean;
  const held = function (this: unknown, ...args: unknown[]) {
    const slot = heldOutput.getStore();
    if (!slot || slot.live) return original.apply(this, args);
    const [chunk, encoding, callback] = args;
    // A chunk or encoding the stream refuses throws inside the task, as an
    // unheld write would, never later when it is replayed.
    if (
      (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) ||
      (typeof encoding === "string" && !Buffer.isEncoding(encoding))
    )
      return original.apply(this, args);
    const done =
      typeof encoding === "function"
        ? (encoding as () => void)
        : typeof callback === "function"
          ? (callback as () => void)
          : undefined;
    if (!slot.discarded) {
      // Copied: a caller may reuse its buffer once the write returns.
      const data = typeof chunk === "string" ? chunk : Buffer.from(chunk);
      const enc = typeof encoding === "string" ? encoding : undefined;
      slot.writes.push(() => {
        if (enc === undefined) original.call(stream, data);
        else original.call(stream, data, enc);
      });
    }
    // The write is accepted: code that waits for its callback goes on, so
    // the task can settle and its turn can come.
    if (done) process.nextTick(done);
    return true;
  } as typeof stream.write;
  wrappers.add(held);
  stream.write = held;
  return () => {
    if (stream.write === held) stream.write = original as typeof held;
  };
};

const restores: Array<() => void> = [];

/**
 * Route console calls and stdout/stderr writes made inside a held slot that
 * is not live into that slot; everything else passes straight through.
 * Checked on every run however many overlap: a method something else
 * replaced since (a logger, a test spy) is wrapped again, so no run's output
 * escapes. Put back once the last run is done, only where nothing replaced
 * the wrapper since.
 */
const holdOutput = (): (() => void) => {
  if (holdDepth++ === 0) {
    const originalError = console.error;
    replayReporter = (error: unknown) =>
      originalError.call(
        console,
        "[bascik] held output could not be written:",
        error,
      );
    // `process.exit` inside a task (a minifier giving up, a crash handler)
    // runs this in the task's context: write what is held before the
    // process goes.
    const onExit = () => flushHeldOutputForExit();
    process.on("exit", onExit);
    restores.push(() => process.off("exit", onExit));
  }
  for (const method of CONSOLE_METHODS)
    if (!wrappers.has(console[method]))
      restores.push(holdConsoleMethod(method));
  for (const stream of [process.stdout, process.stderr])
    if (!wrappers.has(stream.write)) restores.push(holdStream(stream));
  return () => {
    if (--holdDepth === 0) {
      // Newest first, so a method wrapped twice ends at its first original.
      for (const restore of restores.splice(0).reverse()) restore();
    }
  };
};

export interface InOrderOptions {
  /** How many tasks run at once. */
  concurrency: number;
  /**
   * Nothing is printed until this settles: the tasks may start early, and
   * their output comes out where the caller would have run them.
   */
  gate?: Promise<unknown>;
}

/**
 * Run `task(0..count-1)`, at most `concurrency` at once, and return the
 * results in index order, printing as a one-at-a-time loop would (see the
 * module comment).
 *
 * When a task fails, no further task starts. Once every task before it has
 * settled, its output and theirs is written and its error is thrown, without
 * waiting for the later tasks that are still running: a loop would never
 * have started them, so their output is dropped. What is printed and thrown
 * is what the loop would print and throw.
 */
export const inOrder = async <T>(
  count: number,
  task: (index: number) => Promise<T>,
  { concurrency, gate }: InOrderOptions,
): Promise<T[]> => {
  if (count === 0) {
    await gate;
    return [];
  }
  const results: T[] = new Array(count);
  const slots: Slot[] = [];
  const settled: boolean[] = [];
  let failed: { index: number; error: unknown } | null = null;
  let gateOpen = gate === undefined;
  let next = 0;
  let turn = 0;
  let finished = false;
  const outcome = Promise.withResolvers<T[]>();

  const writeSlot = (slot: Slot) => {
    const writes = slot.writes;
    slot.writes = [];
    for (const write of writes) replay(write, replayReporter);
  };
  // Once a fatal path wrote everything, nothing in this run is held again.
  let unheld = false;
  const run = {
    writeAll: () => {
      unheld = true;
      for (const slot of slots) {
        if (!slot) continue;
        // A dropped slot's earlier text stays dropped, but what it prints
        // from here on (its own fatal message) goes straight through.
        slot.live = true;
        if (!slot.discarded) writeSlot(slot);
      }
    },
  };

  /** Write what is due, make the turn live, and settle when done. */
  const advance = () => {
    if (finished || !gateOpen) return;
    const limit = failed === null ? count : failed.index + 1;
    while (turn < limit) {
      const slot = slots[turn];
      // Not started yet: it starts live once it does.
      if (!slot) return;
      if (!slot.live) {
        slot.live = true;
        writeSlot(slot);
      }
      if (!settled[turn]) return;
      turn++;
    }
    finished = true;
    if (failed === null) {
      outcome.resolve(results);
      return;
    }
    for (let index = failed.index + 1; index < slots.length; index++) {
      const slot = slots[index];
      if (!slot) continue;
      slot.discarded = true;
      slot.writes = [];
    }
    outcome.reject(failed.error);
  };

  const release = holdOutput();
  activeRuns.add(run);
  const worker = async () => {
    while (failed === null && next < count) {
      const index = next++;
      const slot: Slot = { writes: [], live: unheld, discarded: false };
      slots[index] = slot;
      advance();
      try {
        results[index] = await heldOutput.run(slot, () => task(index));
      } catch (error) {
        // Read afresh: another worker may have failed during the await.
        const prior = failed as { index: number } | null;
        if (prior === null || index < prior.index) failed = { index, error };
      }
      settled[index] = true;
      advance();
    }
  };
  const workers = Promise.all(
    Array.from({ length: Math.min(concurrency, count) }, worker),
  );
  // The hold stays until the last running task is done, so a task left
  // running after an early failure stays held (and dropped).
  const done = () => {
    activeRuns.delete(run);
    release();
  };
  void workers.then(done, done);
  if (gate !== undefined) {
    // Settling either way opens it: a gate is a signal, not a result.
    const open = () => {
      gateOpen = true;
      advance();
    };
    void Promise.resolve(gate).then(open, open);
  }
  return outcome.promise;
};
