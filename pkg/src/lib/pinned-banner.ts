/**
 * Pins one line to the top row of the terminal while the dev server runs, so the server URL stays visible
 * above the scrolling log.
 *
 * It uses a terminal scroll region (DECSTBM): rows 2 to the bottom scroll, row 1 never does. Writing to row
 * 1 once is not enough, because the first screenful of output would scroll it away.
 *
 * Everything already on screen stays where the user can see it. One blank line is inserted at the top, which moves
 * the screen down a row, and the banner goes into that line. Only a completely full screen loses a line, exactly
 * one, to make room.
 *
 * VS Code's integrated terminal needs one more step. With shell integration on, it draws the command line of
 * whichever command owns the top visible row as a sticky overlay across that row, as soon as that command's line
 * has scrolled out of view. Any scrollback above the screen belongs to earlier commands, so their lines would be
 * drawn over the banner. The overlay stays hidden only while nothing above the screen can own the top row, so in
 * that terminal the scrollback is erased (`ESC [ 3 J`, the part of `clear` that matters). What is on screen is kept.
 * Other terminals keep their scrollback.
 *
 * The terminal is asked where the cursor is (`ESC [ 6 n`) so the cursor can be put back on the same line, now one
 * row lower, and so a full screen is told from one with room. A terminal that does not answer within a moment is
 * treated as full, which is always safe: it costs one scrolled line and puts the cursor on the last row.
 *
 * A scroll region left behind by a run that was killed changes what a newline does, so it is reset first.
 *
 * Only a color-capable interactive terminal gets it. Piped output, CI, `TERM=dumb`, and terminals too short to
 * spare a row are left alone, and callers fall back to a normal log line. Terminals do not keep lines that
 * scroll inside a region that starts below row 1 in their scrollback, so users who want to scroll back through
 * dev output, or keep their scrollback, can turn this off with `--no-pin` or `BASCIK_PIN_SERVER_URL=0`. It is not a
 * config key: it describes one person's terminal, and the config file is shared by everyone on the project.
 *
 * The region is reset on process exit. A process killed with SIGKILL cannot do that, and `reset` clears it.
 */
import { stdout as colorOut } from "./colors.ts";

const ESC = "\u001B";
const SAVE_CURSOR = `${ESC}7`;
const RESTORE_CURSOR = `${ESC}8`;
const CLEAR_LINE = `${ESC}[2K`;
const RESET_SCROLL_REGION = `${ESC}[r`;
const RESET_ORIGIN_MODE = `${ESC}[?6l`;
const INSERT_LINE = `${ESC}[L`;
const ERASE_SCROLLBACK = `${ESC}[3J`;
const MIN_ROWS = 6;
const LABEL = "Server running at";

export interface PinnedBannerStream {
  isTTY?: boolean;
  rows?: number;
  columns?: number;
  write(chunk: string): unknown;
  on(event: "resize", listener: () => void): unknown;
  off(event: "resize", listener: () => void): unknown;
}

/** The part of stdin used to ask the terminal where the cursor is. */
export interface PinnedBannerInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

export type PinnedBannerEnvironment = Record<string, string | undefined>;

const CURSOR_POSITION_REQUEST = `${ESC}[6n`;
const CURSOR_POSITION_REPLY = /\u001B\[(\d+);(\d+)R/;
/** Long enough for a slow SSH link, short enough that a terminal that never answers costs nothing noticeable. */
const CURSOR_QUERY_TIMEOUT_MS = 250;

/** Where the cursor is, counted from 1. */
export interface CursorPosition {
  row: number;
  column: number;
}

/**
 * Asks the terminal where the cursor is, or resolves `undefined` when it does not say.
 *
 * A reply arrives on stdin, so stdin is switched to raw mode to read it without waiting for Enter, and put back
 * exactly as it was. Raw mode left on would stop Ctrl+C from sending SIGINT, so it is restored on every path.
 */
export const readCursorPosition = (
  stream: Pick<PinnedBannerStream, "write">,
  input: PinnedBannerInput | undefined,
  timeoutMs: number = CURSOR_QUERY_TIMEOUT_MS,
): Promise<CursorPosition | undefined> =>
  new Promise((resolve) => {
    if (!input || input.isTTY !== true || typeof input.setRawMode !== "function") {
      resolve(undefined);
      return;
    }
    const wasRaw = input.isRaw === true;
    let reply = "";
    let settled = false;
    const finish = (position: CursorPosition | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Cleanup must not throw, and one step failing must not skip the others. A terminal that refused raw mode may
      // refuse to leave it too, and a banner is not worth failing the server over.
      for (const step of [() => input.off("data", onData), () => input.setRawMode?.(wasRaw), () => input.pause()]) {
        try {
          step();
        } catch {
          // Nothing more can be done for this step.
        }
      }
      resolve(position);
    };
    const onData = (chunk: Buffer | string) => {
      reply += String(chunk);
      const match = CURSOR_POSITION_REPLY.exec(reply);
      if (match) finish({ row: Number(match[1]), column: Number(match[2]) });
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    try {
      input.setRawMode(true);
      input.on("data", onData);
      input.resume();
      stream.write(CURSOR_POSITION_REQUEST);
    } catch {
      finish(undefined);
    }
  });

/** The environment variable that turns pinning off. `--no-pin` sets it to `0` so workers and children see it too. */
export const PIN_SERVER_URL_ENV_VAR = "BASCIK_PIN_SERVER_URL";

/** Whether the user turned pinning off: `0`, `false`, `off`, or `no` (any case). Any other value leaves it on. */
export const isPinningDisabled = (env: PinnedBannerEnvironment = process.env): boolean =>
  /^(?:0|false|off|no)$/i.test((env[PIN_SERVER_URL_ENV_VAR] ?? "").trim());

/** Whether the stream is an interactive terminal tall enough to give up its first row. */
export const canPinBanner = (
  stream: PinnedBannerStream = process.stdout,
  env: PinnedBannerEnvironment = process.env,
): boolean =>
  stream.isTTY === true &&
  (stream.rows ?? 0) >= MIN_ROWS &&
  (stream.columns ?? 0) > LABEL.length + 4 &&
  !env.CI &&
  env.TERM !== "dumb";

/**
 * Whether the scrollback has to be emptied for the banner to stay visible: VS Code's terminal (and editors built
 * on it) with shell integration on, which is what turns on the sticky scroll overlay.
 */
export const needsEmptyScrollback = (env: PinnedBannerEnvironment = process.env): boolean =>
  env.TERM_PROGRAM === "vscode" && Boolean(env.VSCODE_INJECTION || env.VSCODE_SHELL_INTEGRATION);

/** The banner text, with the URL shortened so it never wraps onto row 2. */
export const formatBanner = (url: string, columns: number): string => {
  const room = Math.max(1, columns - LABEL.length - 2);
  const shown = url.length > room ? `${url.slice(0, Math.max(0, room - 1))}…` : url;
  return `${colorOut.green(LABEL)} ${colorOut.cyan(shown)}`;
};

export interface PinnedBanner {
  /** Resets the scroll region and removes the exit and resize handlers. Safe to call twice. */
  release(): void;
}

/**
 * Pins `Server running at <url>` to row 1 and returns a handle that releases it, or `undefined` when the
 * terminal cannot take it. Whatever was on screen moves down one row and stays visible. In VS Code's terminal the
 * scrollback is erased too, see the top of this file.
 */
export const pinServerUrl = async (
  url: string,
  stream: PinnedBannerStream = process.stdout,
  env: PinnedBannerEnvironment = process.env,
  input: PinnedBannerInput | undefined = process.stdin,
): Promise<PinnedBanner | undefined> => {
  if (isPinningDisabled(env) || !canPinBanner(stream, env)) return undefined;

  const rows = () => stream.rows ?? MIN_ROWS;
  // Row 1 holds the banner. Setting the region homes the cursor, so callers put it where they want it afterwards.
  const drawBanner = () =>
    `${ESC}[1;1H${CLEAR_LINE}${formatBanner(url, stream.columns ?? 80)}${ESC}[2;${rows()}r`;

  // This must be asked BEFORE the region is reset: setting or resetting a region moves the cursor to the top left,
  // so asking afterwards always answers "row 1". Unknown means the screen is full, which is always safe.
  const position = await readCursorPosition(stream, input);
  const total = rows();
  const cursorRow = Math.min(Math.max(position?.row ?? total, 1), total);
  const cursorColumn = Math.max(position?.column ?? 1, 1);
  const full = cursorRow >= total;
  const emptyScrollback = needsEmptyScrollback(env);

  // 1. Forget any region a previous run left behind, and origin mode with it, so a newline scrolls the whole
  //    screen and a row number means the same as it does on the glass.
  // 2. A full screen has no row to spare, so scroll exactly one line away. The cursor line moves up one row and
  //    the last row is empty. A screen with room needs nothing here.
  // 3. In VS Code's terminal, erase the scrollback. This comes AFTER the scroll in step 2, so the line that
  //    scroll pushed up goes with the rest and nothing is left above the screen to own the top row.
  // 4. Insert a blank line at the top. Everything moves down one row, the empty row at the bottom is the one that
  //    falls off, and the command's line is still on screen.
  // 5. Draw the banner on the new top row and set the region below it. Setting the region homes the cursor.
  // 6. Put the cursor back on the line it was on, which is one row lower, or still the last row when the screen
  //    was full, in the column it was in.
  const resumeRow = full ? total : cursorRow + 1;
  stream.write(
    `${RESET_SCROLL_REGION}${RESET_ORIGIN_MODE}${full ? `${ESC}[${total};1H\n` : ""}${emptyScrollback ? ERASE_SCROLLBACK : ""}` +
    `${ESC}[1;1H${INSERT_LINE}${drawBanner()}${ESC}[${resumeRow};${cursorColumn}H`,
  );

  // A resize can reset the region and reflow the text, and shrinking the window pushes the top rows, banner
  // included, into the scrollback. Redraw both without moving the cursor, and empty the scrollback again where
  // that is needed so the pushed rows cannot own the top row.
  const onResize = () => {
    if (!canPinBanner(stream, env)) return;
    stream.write(`${SAVE_CURSOR}${emptyScrollback ? ERASE_SCROLLBACK : ""}${drawBanner()}${RESTORE_CURSOR}`);
  };
  const onExit = () => {
    stream.write(`${RESET_SCROLL_REGION}${ESC}[${stream.rows ?? 1};1H\n`);
  };

  stream.on("resize", onResize);
  process.once("exit", onExit);

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      stream.off("resize", onResize);
      process.off("exit", onExit);
      stream.write(`${SAVE_CURSOR}${RESET_SCROLL_REGION}${RESTORE_CURSOR}`);
    },
  };
};
