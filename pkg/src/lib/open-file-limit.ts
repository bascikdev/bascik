/**
 * A process-wide bound on files a build opens at once.
 *
 * A build reads or copies whole folders at a time (every page source, every
 * static asset), beside the page lanes. Started with one `Promise.all`, a
 * site of a few hundred files opened them all at once and failed with
 * `EMFILE: too many open files` under a low open-file limit (`ulimit -n 64`,
 * common in containers and on older macOS shells). Each call here holds one
 * slot while its task runs; the rest wait in order.
 *
 * Wrap only leaf I/O (a read, a copy, a hash of one file): a task that
 * waited for another slot while holding one could stall once every slot is
 * taken.
 */

/** Files opened at once through this module: well under the lowest common limit (64). */
export const OPEN_FILE_SLOTS = 16;

export interface OpenFileLimiter {
  <T>(task: () => Promise<T>): Promise<T>;
  /** Tasks running now (for tests). */
  readonly active: number;
}

export const createOpenFileLimiter = (slots: number): OpenFileLimiter => {
  let active = 0;
  const waiting: (() => void)[] = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
  const limit = async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < slots) active++;
    // The slot passes straight from `release` to the next waiter.
    else await new Promise<void>((take) => waiting.push(take));
    try {
      return await task();
    } finally {
      release();
    }
  };
  Object.defineProperty(limit, "active", { get: () => active });
  return limit as OpenFileLimiter;
};

/** `EMFILE` (this process) or `ENFILE` (the whole system) is out of file handles. */
export const isOpenFileLimitError = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EMFILE" || code === "ENFILE";
};

/** What to do about it, for a message that names the file. */
export const OPEN_FILE_LIMIT_FIX =
  "Too many files are open: raise the open-file limit (`ulimit -n 4096`) and run again.";

/** The build's shared limiter. */
export const withOpenFileSlot = createOpenFileLimiter(OPEN_FILE_SLOTS);
