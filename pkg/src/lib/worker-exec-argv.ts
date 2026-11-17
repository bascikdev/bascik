import { Worker, type WorkerOptions } from "node:worker_threads";

/**
 * The Node options a Bascik worker thread starts with.
 *
 * A worker gets this thread's `process.execArgv`, so a loader, an
 * `--import` or `--require` preload, `--conditions`, `--enable-source-maps`
 * or an `--experimental-*` flag the user started Bascik with applies in
 * every thread. Two kinds of flag cannot be passed on as they are:
 *
 * - `--input-type` (any spelling: `--input-type=module`, `--input_type=...`,
 *   `--input-type module`). Bascik run from `node --input-type=module -e`
 *   would hand it to a worker that loads a file, and Node fails that worker
 *   with `ERR_INPUT_TYPE_NOT_ALLOWED`. It is always dropped, together with
 *   its value when that is a separate argument: Node stops reading options
 *   at the first argument that is not one, so a stray `module` would
 *   silently drop every flag after it.
 * - Flags Node allows only once per process: V8 flags
 *   (`--max-old-space-size`, `--stack-size`, `--expose-gc`, `--jitless`)
 *   and per-process Node options (`--title`, `--disable-proto`,
 *   `--secure-heap`, `--abort-on-uncaught-exception`). They apply to the
 *   whole process, workers included, but naming one in an explicit
 *   `execArgv` makes `new Worker` throw `ERR_WORKER_INVALID_EXEC_ARGV`,
 *   which used to leave a pool with no viable workers. Which flags those
 *   are depends on the Node version, so Bascik keeps no list of its own:
 *   Node's error names the refused flags, and `startWorker` starts the
 *   worker again without exactly those and their separate values
 *   (remembering the result, so only the first worker pays for the retry).
 *
 * Leaving `execArgv` out is not the same. With an explicit `env` (the page
 * pool passes one), Node 24 and 26 parse this thread's `execArgv` again
 * for the worker and stop at the separate value of a per-process flag:
 * under `--title x --import ./preload.mjs` the worker starts with only
 * `--title`, without the preload. It also inherits `--input-type`.
 *
 * Flags set through `NODE_OPTIONS` are not in `process.execArgv`; a worker
 * reads them from its environment, where Node allows per-process flags.
 */

const INVALID_EXEC_ARGV = "ERR_WORKER_INVALID_EXEC_ARGV";

/** The option an argument names, with `_` read as `-` the way Node does:
 * `--input_type=module` names `--input-type`. */
const optionName = (arg: string): string => {
  const equals = arg.indexOf("=");
  return (equals === -1 ? arg : arg.slice(0, equals)).replaceAll("_", "-");
};

/** An argument after an option without `=` is that option's value when it
 * is not an option itself (`process.execArgv` holds no script arguments). */
const isSeparateValue = (next: string | undefined): boolean =>
  next !== undefined && !next.startsWith("-");

/** Remove every argument `drop` matches, with its separate value. */
const withoutArgs = (
  execArgv: readonly string[],
  drop: (arg: string) => boolean,
): string[] => {
  const kept: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i];
    if (!drop(arg)) {
      kept.push(arg);
      continue;
    }
    if (!arg.includes("=") && isSeparateValue(execArgv[i + 1])) i++;
  }
  return kept;
};

/** `execArgv` without `--input-type`, in any spelling, and its value. */
export const withoutInputType = (execArgv: readonly string[]): string[] =>
  withoutArgs(execArgv, (arg) => optionName(arg) === "--input-type");

/**
 * The arguments of `execArgv` that `ERR_WORKER_INVALID_EXEC_ARGV`'s message
 * names ("Initiated Worker with invalid execArgv flags: --title=x,
 * --expose-gc"). Each named flag is matched as a whole argument, so a
 * value that contains ", " (`--title=a, b`) is still found. Empty when the
 * error is another one, or the message does not name any of them.
 */
export const rejectedExecArgv = (
  error: unknown,
  execArgv: readonly string[],
): string[] => {
  if ((error as { code?: unknown } | null)?.code !== INVALID_EXEC_ARGV) {
    return [];
  }
  const message = String((error as { message?: unknown }).message ?? "");
  const marker = "execArgv flags: ";
  const start = message.indexOf(marker);
  if (start === -1) return [];
  const named = `, ${message.slice(start + marker.length)}, `;
  return execArgv.filter((arg) => named.includes(`, ${arg}, `));
};

/** `execArgv` without the `rejected` arguments and their separate values. */
export const withoutRejected = (
  execArgv: readonly string[],
  rejected: readonly string[],
): string[] => {
  const drop = new Set(rejected);
  return withoutArgs(execArgv, (arg) => drop.has(arg));
};

/** The last `execArgv` worked out, so later workers skip the retry. */
let resolved: { from: string; execArgv: string[] | undefined } | undefined;

type CreateWorker = (script: string, options: WorkerOptions) => Worker;

const createWorker: CreateWorker = (script, options) =>
  new Worker(script, options);

/**
 * Start a worker with this thread's Node options (see the module comment).
 * When Node rejects some of them, the worker is started again without
 * exactly those, as often as Node names more: it does not always name them
 * all at once (`--max-old-space-size --title x --expose-gc` is refused for
 * the first two, then for `--expose-gc`), and every round removes at least
 * one argument, so the retries end. When Node's error names no flag Bascik
 * passed (a message format it does not know), the worker is started with
 * `execArgv` left out, Node's own inheritance, unless `--input-type` is
 * among the flags: then the error is thrown. Any other error is thrown as
 * is.
 */
export const startWorker = (
  script: string,
  options: Omit<WorkerOptions, "execArgv">,
  {
    execArgv = process.execArgv,
    create = createWorker,
  }: { execArgv?: readonly string[]; create?: CreateWorker } = {},
): Worker => {
  const from = JSON.stringify(execArgv);
  if (resolved?.from === from) {
    return create(script, withExecArgv(options, resolved.execArgv));
  }
  let current: string[] | undefined = withoutInputType(execArgv);
  const hadInputType = current.length !== execArgv.length;
  for (;;) {
    try {
      const worker = create(script, withExecArgv(options, current));
      resolved = { from, execArgv: current };
      return worker;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code !== INVALID_EXEC_ARGV || current === undefined) throw error;
      const rejected = rejectedExecArgv(error, current);
      if (rejected.length > 0) {
        current = withoutRejected(current, rejected);
      } else if (hadInputType) {
        throw error;
      } else {
        current = undefined;
      }
    }
  }
};

const withExecArgv = (
  options: Omit<WorkerOptions, "execArgv">,
  execArgv: string[] | undefined,
): WorkerOptions => (execArgv ? { ...options, execArgv } : { ...options });

/** Forget the remembered `execArgv`, for tests. */
export const resetWorkerExecArgvForTests = (): void => {
  resolved = undefined;
};
