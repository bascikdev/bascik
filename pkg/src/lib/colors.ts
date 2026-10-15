/**
 * Terminal colors for build and dev output.
 *
 * Built on `util.styleText` with stream validation, so color is added only when the stream is a color
 * capable terminal. Piped output, CI logs without a TTY, `NO_COLOR`, and `TERM=dumb` all get plain text,
 * and `FORCE_COLOR` turns it on. Output that other code matches against (tests, build log files) stays
 * byte-for-byte what it was before.
 *
 * Use `stdout` helpers for `console.log` and `stderr` helpers for `console.warn` and `console.error`,
 * since the two streams can differ in whether they are a terminal.
 */
import { styleText, stripVTControlCharacters } from "node:util";

type Format = Parameters<typeof styleText>[0];

const paint = (stream: NodeJS.WriteStream, format: Format, text: string): string =>
  styleText(format, text, { stream, validateStream: true });

const painter = (stream: () => NodeJS.WriteStream) => ({
  /** Success and completed work. */
  green: (text: string) => paint(stream(), "green", text),
  /** Warnings and slow or client-error results. */
  yellow: (text: string) => paint(stream(), "yellow", text),
  /** Errors and server-error results. */
  red: (text: string) => paint(stream(), "red", text),
  /** Paths, redirects, and other things to find quickly. */
  cyan: (text: string) => paint(stream(), "cyan", text),
  /** Labels, durations, and anything that should recede. */
  dim: (text: string) => paint(stream(), "dim", text),
  bold: (text: string) => paint(stream(), "bold", text),
  /** The `[bascik]` prefix, in the color of the message it introduces. */
  tag: (level: "info" | "warn" | "error", text = "[bascik]") =>
    paint(stream(), level === "error" ? ["bold", "red"] : level === "warn" ? ["bold", "yellow"] : ["bold", "cyan"], text),
});

/** Colors for `console.log` output. */
export const stdout = painter(() => process.stdout);

/** Colors for `console.warn` and `console.error` output. */
export const stderr = painter(() => process.stderr);

/** Colors an HTTP status by class: 2xx green, 3xx cyan, 4xx yellow, 5xx red. */
export const colorStatus = (status: number): string => {
  const text = String(status);
  if (status >= 500) return stdout.red(text);
  if (status >= 400) return stdout.yellow(text);
  if (status >= 300) return stdout.cyan(text);
  return stdout.green(text);
};

/** Whether Node would color text for this stream: a terminal, with `NO_COLOR`, `FORCE_COLOR` and `TERM=dumb` honored. */
const canColor = (stream: NodeJS.WriteStream): boolean => styleText("green", "x", { stream, validateStream: true }) !== "x";

/**
 * The environment to give a worker thread so its output is colored exactly when this thread's would be.
 *
 * A worker's `process.stdout` is never a terminal as far as Node can tell, so without help every line a worker
 * prints is plain even in a color terminal. The main thread knows better, and asks Node the same question it asks
 * for its own output: is the stream a color terminal, with `NO_COLOR`, `FORCE_COLOR` and `TERM=dumb` honored.
 * If so, the worker is told to color. Both streams must qualify, because the worker's output goes to wherever this
 * thread's goes, and `bascik > build.log` must never receive escape codes. Returns `undefined`, meaning "leave the
 * worker alone", when color is not allowed.
 *
 * Only the 16 basic ANSI colors are ever used, so the terminal's own theme decides what they look like.
 */
export const workerEnvironment = (
  streams: { stdout?: NodeJS.WriteStream; stderr?: NodeJS.WriteStream } = {},
): NodeJS.ProcessEnv | undefined => {
  const { stdout: out = process.stdout, stderr: err = process.stderr } = streams;
  if (!canColor(out) || !canColor(err)) return undefined;
  return { ...process.env, FORCE_COLOR: "1" };
};

/** Removes terminal control sequences, so log files never contain color codes. */
export const stripColors = (text: string): string => stripVTControlCharacters(text);
