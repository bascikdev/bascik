/**
 * @module server-scripts
 *
 * Server-time Script Execution
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `<script data-bascik-server>` blocks are executed at request time as
 * Node.js ESM modules.  Whatever the script writes to stdout is injected into
 * the page in place of the script tag, on every request.
 *
 * This lets you personalize pages at the HTTP layer — reading session cookies,
 * querying a database, or rendering content based on query parameters — without
 * a full framework.
 *
 * @example
 * ```html
 * <script data-bascik-server>
 * const req = JSON.parse(process.env.BASCIK_REQUEST);
 * const name = req.headers['x-display-name'] ?? 'Guest';
 * console.log(`<p>Welcome, ${name}</p>`);
 * </script>
 * ```
 *
 * Rules
 * ─────────────────────────────────────────────────────────────────────────────
 * - The script body is written to a temp `.mjs` file and run with the same
 *   Node.js binary that is running Bascik.
 * - Top-level `import` statements and top-level `await` are both supported.
 * - `process.env.BASCIK_REQUEST` contains JSON with four keys:
 *     `{ path, method, headers, searchParams }`
 *   – `path`         — the requested URL path without the query string
 *   – `method`       — the HTTP method in uppercase (e.g. `"GET"`)
 *   – `headers`      — an object of request header name → value strings
 *                      (HTTP/2 pseudo-headers like `:path` are excluded)
 *   – `searchParams` — an object of query-param key → value strings
 * - The script's working directory is the project root (`process.cwd()`).
 * - Use `console.log()` or `process.stdout.write()` to emit the HTML to
 *   inject.  Anything written to stderr is forwarded to the server's stderr.
 * - The script tag (including attributes and closing tag) is completely
 *   replaced by the stdout output.  Empty stdout → replaced with `""`.
 * - On execution error, Bascik logs a warning and removes the tag from the
 *   response rather than aborting the request.
 * - Unlike `data-bascik-build`, server scripts run on every request and are
 *   never cached.  They are NOT executed during `bascik --build`.
 */

import { execFile } from "node:child_process";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import os from "node:os";
import { BascikConfig } from "./config.ts";
import { cleanStackTrace } from "./stack-trace.ts";

export { cleanStackTrace };

/** Request context passed to every `data-bascik-server` script. */
export interface ServerRequest {
  /** URL path without the query string, e.g. `"/about"`. */
  path: string;
  /** HTTP method in uppercase, e.g. `"GET"`. */
  method: string;
  /**
   * Request headers as a plain object.
   * HTTP/2 pseudo-headers (`:path`, `:method`, etc.) are excluded.
   */
  headers: Record<string, string>;
  /** Parsed query parameters as a plain string-to-string object. */
  searchParams: Record<string, string>;
}

// Match <script data-bascik-server …> … </script> (captures inner content).
// The attribute section uses an alternation that consumes either a complete
// double-quoted value, a single-quoted value, or any non-quote, non->
// character — this prevents a match when "data-bascik-server" appears only
// inside an attribute value such as title="run data-bascik-server later".
const createServerScriptRegex = (): RegExp =>
  /<script\b(?:[^>"']|"[^"]*"|'[^']*')*\sdata-bascik-server\b(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/script>/gi;

// Strip ANSI terminal color sequences so server-side HTML injection never leaks
// terminal formatting from CI or Netlify build environments into the page output.
const stripAnsiEscapeCodes = (value: string): string =>
  value.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B[@-Z\\-_]/g, "");

const BARE_TOKEN = String.raw`[^\s"'=<>\`]+`;
const ATTR_VALUE = String.raw`(?:"[^"]*"|'[^']*'|${BARE_TOKEN})`;
const ATTR = String.raw`${BARE_TOKEN}(?:\s*=\s*${ATTR_VALUE})?`;
const BUILD_FLAG = String.raw`data-bascik-build(?:\s*=\s*${ATTR_VALUE})?`;
const ROUTES_FLAG = String.raw`data-bascik-routes(?:\s*=\s*${ATTR_VALUE})?`;

const SERVER_BUILD_CONFLICT_RE = new RegExp(
  String.raw`<script\b(?:\s+${ATTR})*\s+${BUILD_FLAG}(?:\s+${ATTR})*\s*>`,
  "i",
);

const SERVER_ROUTES_CONFLICT_RE = new RegExp(
  String.raw`<script\b(?:\s+${ATTR})*\s+${ROUTES_FLAG}(?:\s+${ATTR})*\s*>`,
  "i",
);

/** Return `true` if `html` contains at least one `data-bascik-server` block. */
export const htmlHasServerScripts = (html: string): boolean => {
  return createServerScriptRegex().test(html);
};

/** Default execution timeout per server-script child process (ms). */
export const DEFAULT_SCRIPT_TIMEOUT_MS = 30_000;

/**
 * Maximum number of server-script child processes that may run concurrently
 * per request.  Prevents a single page with many server blocks from spawning
 * an unbounded number of child processes at once.
 */
const MAX_CONCURRENT_SCRIPTS = Math.max(4, os.availableParallelism?.() ?? os.cpus().length);

// Manual promise wrapper keeps the same shape as the one in build-scripts.ts
// so tests can mock execFile with a plain vi.fn() without simulating
// Node's promisify.custom symbol.
const runModule = (
  path: string,
  request: ServerRequest,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path],
      {
        cwd: process.cwd(),
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        env: {
          ...process.env,
          BASCIK_REQUEST: JSON.stringify(request),
          FORCE_COLOR: "0",
          NO_COLOR: "1",
        },
      },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stdout, stderr }));
        else resolve({ stdout, stderr });
      },
    );
  });

/**
 * Find every `<script data-bascik-server>` block in `html`, execute each as a
 * Node.js ESM module with the supplied request context, and replace the tag
 * with the script's stdout output.
 *
 * @param timeoutMs - Per-script execution deadline in milliseconds.
 *   Defaults to {@link DEFAULT_SCRIPT_TIMEOUT_MS}.  Scripts that exceed the
 *   deadline are killed (SIGKILL) and their block is removed from the output.
 */
export const executeServerScripts = async (
  html: string,
  request: ServerRequest,
  timeoutMs: number = DEFAULT_SCRIPT_TIMEOUT_MS,
  filePath?: string,
): Promise<string> => {
  const matches = [...html.matchAll(createServerScriptRegex())];
  if (matches.length === 0) return html;

  // Same temp-dir convention as build-scripts.ts: keeps script files inside
  // the project tree so ESM resolution can find the project's node_modules.
  const tempDir = join(process.cwd(), "node_modules", ".cache", "bascik");
  await mkdir(tempDir, { recursive: true });

  // Run at most MAX_CONCURRENT_SCRIPTS child processes at a time.
  interface ScriptJob {
    fullTag: string;
    scriptContent: string;
    openTag: string;
    index: number;
    length: number;
    startLine: number;
    output?: string;
  }

  const scriptJobs: ScriptJob[] = matches.map((match) => {
    const fullTag = match[0];
    const scriptContent = match[1];
    const index = match.index!;
    const length = fullTag.length;

    const prefix = html.slice(0, index);
    const lines = prefix.split(/\r?\n/);
    const lineOffset = lines.length;

    // Server-script open tag
    const openTag = fullTag.slice(0, fullTag.length - scriptContent.length - "</script>".length);
    if (SERVER_BUILD_CONFLICT_RE.test(openTag)) {
      let errorMsg = `[bascik] error: <script> tag has both data-bascik-server and data-bascik-build`;
      if (filePath) {
        errorMsg += ` in "${filePath}"`;
      }
      throw new Error(`${errorMsg}. A script can only run at build time or at request time — not both. Remove one of the attributes.`);
    }
    if (SERVER_ROUTES_CONFLICT_RE.test(openTag)) {
      let errorMsg = `[bascik] error: <script> tag has both data-bascik-server and data-bascik-routes`;
      if (filePath) {
        errorMsg += ` in "${filePath}"`;
      }
      throw new Error(`${errorMsg}. A script cannot be both a server script and a routes script. Remove one of the attributes.`);
    }
    const openTagLines = openTag.split(/\r?\n/).length - 1;
    const startLine = lineOffset + openTagLines;

    return {
      fullTag,
      scriptContent,
      openTag,
      index,
      length,
      startLine,
    };
  });

  for (let i = 0; i < scriptJobs.length; i += MAX_CONCURRENT_SCRIPTS) {
    const batch = scriptJobs.slice(i, i + MAX_CONCURRENT_SCRIPTS);
    await Promise.all(
      batch.map(async (job) => {
        const tmpPath = join(
          tempDir,
          `server-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
        );

        let codeToExecute = job.scriptContent.trim();
        if (!codeToExecute) {
          const srcMatch = job.openTag.match(/\bsrc=["']([^"']+)["']/i);
          if (srcMatch) {
            const srcPath = srcMatch[1];
            const resolvedPath = filePath ? resolve(dirname(filePath), srcPath) : resolve(process.cwd(), srcPath);
            try {
              codeToExecute = await readFile(resolvedPath, "utf8");
            } catch (err) {
              console.warn(`[bascik] warning: Failed to read server script src "${srcPath}":`, err);
            }
          }
        }

        let sourceUrlComment = "";
        if (filePath) {
          const relPath = relative(process.cwd(), filePath).replace(/\\/g, "/");
          sourceUrlComment = `\n//# sourceURL=${relPath}`;
        } else {
          sourceUrlComment = `\n//# sourceURL=${request.path}`;
        }

        try {
          await writeFile(tmpPath, codeToExecute + sourceUrlComment, "utf8");
          const { stdout, stderr } = await runModule(tmpPath, request, timeoutMs);
          if (stderr) process.stderr.write(stderr);
          job.output = stripAnsiEscapeCodes(stdout);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const relPath = filePath ? relative(process.cwd(), filePath).replace(/\\/g, "/") : request.path;
          const cleanedMsg = cleanStackTrace(msg, tmpPath, relPath, job.startLine);
          const errorMsg = `[bascik] server script error at "${request.path}":\n${cleanedMsg}`;
          const behavior = BascikConfig.onScriptError ?? "error";
          if (behavior === "halt" || behavior === "error") {
            console.error(errorMsg);
            throw new Error(errorMsg);
          } else {
            console.warn(errorMsg);
          }
          job.output = "";
        } finally {
          await unlink(tmpPath).catch(() => { });
        }
      }),
    );
  }

  let result = html;
  // Sort from last match to first match so earlier string indices remain valid
  const sortedJobs = scriptJobs.slice().sort((a, b) => b.index - a.index);
  for (const job of sortedJobs) {
    result =
      result.slice(0, job.index) +
      (job.output ?? "") +
      result.slice(job.index + job.length);
  }
  return result;
};
