/**
 * Records a real command and renders it as terminal frames.
 *
 * The command actually runs. Its stdout and stderr are captured with timestamps, then replayed with long
 * waits shortened, so the animation shows real output at a watchable pace. Nothing in the output is written by
 * hand. The shown command line can differ from the executed one (the docs say `bascik`, the script runs the
 * repo's own binary), but only in how the program is reached, never in what it prints.
 *
 * Programs that act differently on a terminal than in a pipe (the dev server colors its output and pins its address
 * to the top row) run in a real pseudo-terminal, and their output is replayed through a terminal emulator that
 * honors cursor movement and scroll regions, the way a real terminal does. Everything else stays a simple pipe.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { Browser } from 'playwright';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import { pushFrame, type Frame } from './frames.ts';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');

/**
 * node-pty's macOS prebuilds ship `spawn-helper` without its execute bit, and the package's build script is turned off
 * in docs/package.json (it would compile on Linux CI, where nothing records). Without the bit every spawn fails with
 * `posix_spawnp failed`, so it is set here, once, before the first terminal is opened.
 */
function loadNodePty(): typeof import('node-pty') {
  const root = dirname(require.resolve('node-pty/package.json'));
  for (const platform of ['darwin-arm64', 'darwin-x64']) {
    const helper = join(root, 'prebuilds', platform, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
  return require('node-pty') as typeof import('node-pty');
}

/** The size of a pseudo-terminal. */
export interface PtySize {
  rows: number;
  cols: number;
}

export interface RecordedChunk {
  /** Milliseconds since the command started. */
  at: number;
  text: string;
}

export interface Recording {
  chunks: RecordedChunk[];
  exitCode: number | null;
  /** Set when the command ran in a pseudo-terminal, so the replay must emulate one. */
  pty?: PtySize;
}

export interface RunOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /** Run in a pseudo-terminal of this size, so the program sees a terminal: colors, size, and cursor control. */
  pty?: PtySize;
  /** Stop the command this long after it started. Needed for servers, which never exit on their own. */
  stopAfterMs?: number;
  /** Stop the command once its output matches this. */
  stopWhen?: RegExp;
  /**
   * Actions to run when the output first matches a pattern, such as saving a file once a server reports that
   * it is ready. Each fires at most once.
   */
  triggers?: Array<{ when: RegExp; run: () => Promise<void> }>;
}

/** Runs a command and records everything it prints. Color is forced on in a pipe, and comes from the terminal in a pty. */
export function recordCommand({ command, args, cwd, env = {}, pty, stopAfterMs, stopWhen, triggers = [] }: RunOptions): Promise<Recording> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const chunks: RecordedChunk[] = [];
    // A reader's shell is interactive and not CI, so a pseudo-terminal must not inherit either from this script.
    const environment: NodeJS.ProcessEnv = { ...process.env, ...(pty ? { TERM: 'xterm-256color' } : { FORCE_COLOR: '1' }), ...env };
    // A reader's terminal sets none of these: color comes from the program seeing a terminal, which is what is
    // recorded. Node treats a CI variable as present even when it is empty, and turns color off, so it is removed.
    if (pty) {
      for (const name of ['NO_COLOR', 'FORCE_COLOR', 'CI']) delete environment[name];
    }
    let output = '';
    const pending = [...triggers];
    let stopping = false;
    // Whatever the program prints after this script tells it to stop (a shutdown message) is the script's doing,
    // not part of what a user would see, so it is not recorded.
    let interrupt = () => { };
    const stop = () => {
      stopping = true;
      interrupt();
    };
    const onData = (text: string) => {
      if (stopping) return;
      chunks.push({ at: Date.now() - start, text });
      // Patterns describe what the reader reads, so they are matched against the text without color or cursor codes.
      output = stripVTControlCharacters(output + text);
      for (const trigger of [...pending]) {
        if (!trigger.when.test(output)) continue;
        pending.splice(pending.indexOf(trigger), 1);
        trigger.run().catch(reject);
      }
      if (!stopping && stopWhen?.test(output)) setTimeout(stop, 1200);
    };
    if (stopAfterMs) setTimeout(stop, stopAfterMs);

    if (pty) {
      // One stream, as on a real terminal: the program's output and errors arrive interleaved.
      const terminal = loadNodePty().spawn(command, args, { cwd, env: environment as Record<string, string>, cols: pty.cols, rows: pty.rows, name: 'xterm-256color' });
      interrupt = () => terminal.kill('SIGINT');
      terminal.onData(onData);
      terminal.onExit(({ exitCode }) => resolve({ chunks, exitCode, pty }));
      return;
    }
    // codeql[js/shell-command-injection-from-environment] No shell: runs a recording scene's own command, with arguments as an array.
    const child = spawn(command, args, { cwd, env: environment });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    interrupt = () => child.kill('SIGINT');
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ chunks, exitCode }));
  });
}

interface Style {
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

const PALETTE: Record<number, string> = {
  30: '#6b7280', 31: '#ff6b6b', 32: '#8ee06a', 33: '#ffd166', 34: '#6cb6ff', 35: '#d6a0ff', 36: '#6be0d0', 37: '#e6e6e6',
  90: '#8b949e', 91: '#ff8e8e', 92: '#a8f08c', 93: '#ffe08a', 94: '#8ccaff', 95: '#e4bfff', 96: '#8ff0e3', 97: '#ffffff',
};

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Turns text with ANSI color codes into HTML spans. Only the codes real CLIs commonly use are handled. */
export function ansiToHtml(text: string): string {
  let html = '';
  let style: Style = {};
  const pattern = /\u001b\[([0-9;]*)m/g;
  let last = 0;
  const emit = (segment: string) => {
    if (!segment) return;
    const css = [
      style.color ? `color:${style.color}` : '',
      style.bold ? 'font-weight:700' : '',
      style.dim ? 'opacity:.65' : '',
    ].filter(Boolean).join(';');
    html += css ? `<span style="${css}">${escapeHtml(segment)}</span>` : escapeHtml(segment);
  };
  for (const match of text.matchAll(pattern)) {
    emit(text.slice(last, match.index));
    last = match.index + match[0].length;
    for (const code of (match[1] || '0').split(';').map(Number)) {
      if (code === 0) style = {};
      else if (code === 1) style.bold = true;
      else if (code === 2) style.dim = true;
      else if (code === 22) { style.bold = false; style.dim = false; }
      else if (code === 39) style.color = undefined;
      else if (PALETTE[code]) style.color = PALETTE[code];
    }
  }
  emit(text.slice(last));
  return html;
}

/** Drops cursor and erase sequences, which a plain replay cannot honor. */
const stripControl = (text: string) =>
  text.replace(/\u001b\[[0-9;?]*[ABCDEFGHJKSTfhlsu]/g, '').replace(/\r(?!\n)/g, '');

export interface TerminalOptions {
  /** The title in the window bar, usually the command the reader would type. */
  title: string;
  /** What the prompt looks like. */
  prompt?: string;
  /** Visible rows. Output past this scrolls, like a real terminal. */
  rows: number;
  /** CSS pixel width of the whole window. */
  width?: number;
}

export interface TerminalScript {
  /** The command as the reader would type it. */
  typed: string;
  recording: Recording;
  /** Longest gap between two output frames. Real waits are shortened to this. */
  maxGapMs?: number;
  /** How many recorded output chunks to show at once. Larger values mean fewer, bigger steps. */
  chunksPerFrame?: number;
  /** How long the last frame stays up before the loop restarts. */
  finalHoldMs?: number;
  /**
   * Whether the command finished, so a new prompt appears. Servers keep running, so their scene ends on the
   * output with no prompt. Defaults to true.
   */
  endsAtPrompt?: boolean;
}

const FONT_SIZE = 13;
const LINE_PX = 20;
const PAD = 16;
const BAR_PX = 38;

function documentHtml(options: TerminalOptions, bodyHtml: string): string {
  const { width = 760, rows, title } = options;
  return `<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent">
<div id="t" style="width:${width}px;border:1px solid rgba(255,255,255,.1);border-radius:10px;overflow:hidden;background:#16181a;font-family:Menlo,Monaco,'Courier New',monospace">
  <div style="height:${BAR_PX}px;box-sizing:border-box;display:flex;align-items:center;gap:8px;padding:0 14px;background:#1e2022;border-bottom:1px solid rgba(255,255,255,.08);font-size:12px;color:#9aa0a6">
    <span style="display:flex;gap:6px;margin-right:8px"><i style="width:10px;height:10px;border-radius:50%;background:#ff5f56"></i><i style="width:10px;height:10px;border-radius:50%;background:#ffbd2e"></i><i style="width:10px;height:10px;border-radius:50%;background:#27c93f"></i></span>${escapeHtml(title)}
  </div>
  <pre id="body" style="margin:0;padding:${PAD}px;box-sizing:border-box;height:${rows * LINE_PX + PAD * 2}px;overflow:hidden;font:${FONT_SIZE}px/${LINE_PX}px Menlo,Monaco,'Courier New',monospace;color:#e6e6e6;white-space:pre-wrap;word-break:break-word">${bodyHtml}</pre>
</div>`;
}

/**
 * Replays a recording as frames. The command is typed first, then the recorded output appears in order.
 * Returns frames sized to the terminal window, ready for `writeScene`.
 */
export async function renderTerminal(browser: Browser, options: TerminalOptions, script: TerminalScript): Promise<Frame[]> {
  if (script.recording.pty) return renderEmulatedTerminal(browser, options, script);
  const { prompt = '$ ', rows } = options;
  const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: (options.width ?? 760) + 40, height: 900 } });
  const page = await context.newPage();
  await page.setContent(documentHtml(options, ''));
  const frames: Frame[] = [];
  const cursor = '<span style="background:#e6e6e6;color:#16181a"> </span>';

  const visibleTail = (raw: string) => {
    // Keep the last `rows` visual lines so long output scrolls instead of being cut off.
    const lines = raw.split('\n');
    return lines.slice(-rows).join('\n');
  };
  const shoot = async (raw: string, hold: number, withCursor: boolean) => {
    const html = ansiToHtml(visibleTail(raw)) + (withCursor ? cursor : '');
    await page.evaluate((value) => { document.getElementById('body')!.innerHTML = value; }, html);
    const png = await page.locator('#t').screenshot({ omitBackground: true });
    pushFrame(frames, png, hold);
  };

  const promptText = `\u001b[32m${prompt}\u001b[0m`;
  await shoot(promptText, 900, true);

  // Type the command.
  const characters = Array.from(script.typed);
  for (let index = 0; index < characters.length; index += 3) {
    await shoot(promptText + characters.slice(0, index + 3).join(''), 3 * 55, true);
  }
  let shown = promptText + script.typed + '\n';
  await shoot(shown, 450, false);

  // Replay output. Real gaps are kept when short and shortened when long.
  // A frame stays up until the next output arrives, so its hold is the gap to the following group.
  const maxGap = script.maxGapMs ?? 700;
  const perFrame = script.chunksPerFrame ?? 1;
  const chunks = script.recording.chunks;
  const groups: RecordedChunk[][] = [];
  for (let index = 0; index < chunks.length; index += perFrame) groups.push(chunks.slice(index, index + perFrame));
  for (let index = 0; index < groups.length; index++) {
    for (const chunk of groups[index]) shown += stripControl(chunk.text);
    const thisAt = groups[index][groups[index].length - 1].at;
    const nextAt = groups[index + 1]?.[0].at;
    const hold = nextAt === undefined ? 500 : Math.min(Math.max(nextAt - thisAt, 60), maxGap);
    await shoot(shown, hold, false);
  }
  const endsAtPrompt = script.endsAtPrompt ?? true;
  // Like a real shell, start the prompt on its own line when the output did not end with a newline.
  const beforePrompt = shown.endsWith('\n') ? shown : shown + '\n';
  await shoot(endsAtPrompt ? beforePrompt + promptText : shown.replace(/\n+$/, ''), script.finalHoldMs ?? 4000, endsAtPrompt);
  await context.close();
  return frames;
}

/** The color of a palette index, for the 16 colors programs use. Extended palette colors are not used by any recorded CLI. */
const paletteColor = (index: number): string | undefined =>
  index < 8 ? PALETTE[30 + index] : index < 16 ? PALETTE[90 + index - 8] : undefined;

interface StyledCell {
  chars: string;
  css: string;
}

/** Draws the emulator's visible screen as HTML, one `<span>` per run of identically styled cells. */
function screenToHtml(terminal: HeadlessTerminal, cursor: boolean): string {
  const buffer = terminal.buffer.active;
  const scratch = buffer.getNullCell();
  const lines: string[] = [];
  for (let y = 0; y < terminal.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    const cells: StyledCell[] = [];
    for (let x = 0; x < terminal.cols; x++) {
      const cell = line?.getCell(x, scratch);
      if (!cell || cell.getWidth() === 0) continue;
      const color = cell.isFgPalette() ? paletteColor(cell.getFgColor()) : undefined;
      const css = [
        color ? `color:${color}` : '',
        cell.isBold() ? 'font-weight:700' : '',
        cell.isDim() ? 'opacity:.65' : '',
        cursor && y === buffer.cursorY && x === buffer.cursorX ? 'background:#e6e6e6;color:#16181a' : '',
      ].filter(Boolean).join(';');
      cells.push({ chars: cell.getChars() || ' ', css });
    }
    // Blank cells at the end of a line are not drawn, except the one holding the cursor.
    while (cells.length > 0 && cells.at(-1)!.chars === ' ' && !cells.at(-1)!.css.includes('background')) cells.pop();
    let html = '';
    for (let start = 0; start < cells.length;) {
      let end = start;
      while (end < cells.length && cells[end].css === cells[start].css) end++;
      const text = escapeHtml(cells.slice(start, end).map((cell) => cell.chars).join(''));
      html += cells[start].css ? `<span style="${cells[start].css}">${text}</span>` : text;
      start = end;
    }
    lines.push(html);
  }
  return lines.join('\n');
}

/**
 * Replays a pty recording through a terminal emulator, so cursor movement, scroll regions, and color behave as
 * they do in a real terminal. Same pacing and typing as the plain renderer.
 */
async function renderEmulatedTerminal(browser: Browser, options: TerminalOptions, script: TerminalScript): Promise<Frame[]> {
  const { prompt = '$ ', rows } = options;
  const pty = script.recording.pty!;
  if (pty.rows !== rows) throw new Error(`The command ran in ${pty.rows} rows but the window shows ${rows}`);
  const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: (options.width ?? 760) + 40, height: 900 } });
  const page = await context.newPage();
  await page.setContent(documentHtml(options, ''));
  const frames: Frame[] = [];
  const terminal = new Terminal({ rows: pty.rows, cols: pty.cols, scrollback: 0, allowProposedApi: true });
  const feed = (text: string) => new Promise<void>((done) => terminal.write(text, done));
  const shoot = async (hold: number, cursor: boolean) => {
    await page.evaluate((value) => { document.getElementById('body')!.innerHTML = value; }, screenToHtml(terminal, cursor));
    pushFrame(frames, await page.locator('#t').screenshot({ omitBackground: true }), hold);
  };

  const promptText = `\u001b[32m${prompt}\u001b[0m`;
  await feed(promptText);
  await shoot(900, true);
  const characters = Array.from(script.typed);
  for (let index = 0; index < characters.length; index += 3) {
    await feed(characters.slice(index, index + 3).join(''));
    await shoot(3 * 55, true);
  }
  await feed('\r\n');
  await shoot(450, false);

  const maxGap = script.maxGapMs ?? 700;
  const perFrame = script.chunksPerFrame ?? 1;
  const chunks = script.recording.chunks;
  const groups: RecordedChunk[][] = [];
  for (let index = 0; index < chunks.length; index += perFrame) groups.push(chunks.slice(index, index + perFrame));
  for (let index = 0; index < groups.length; index++) {
    await feed(groups[index].map((chunk) => chunk.text).join(''));
    const thisAt = groups[index][groups[index].length - 1].at;
    const nextAt = groups[index + 1]?.[0].at;
    const hold = nextAt === undefined ? 500 : Math.min(Math.max(nextAt - thisAt, 60), maxGap);
    await shoot(hold, false);
  }
  const endsAtPrompt = script.endsAtPrompt ?? true;
  if (endsAtPrompt) {
    // Like a real shell, start the prompt on its own line when the output did not end with a newline.
    if (terminal.buffer.active.cursorX !== 0) await feed('\r\n');
    await feed(promptText);
  }
  await shoot(script.finalHoldMs ?? 4000, endsAtPrompt);
  terminal.dispose();
  await context.close();
  return frames;
}
