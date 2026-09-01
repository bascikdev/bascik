/**
 * @module build-scripts
 *
 * Build-time Script Execution
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `<script data-bascik-build>` blocks are executed at transpile time as
 * Node.js ESM modules.  Whatever the script writes to stdout is injected into
 * the page in place of the script tag.
 *
 * This lets you pull in external data — markdown files, JSON, API responses —
 * at build time and inline the generated HTML directly into the page.
 *
 * @example
 * ```html
 * <!-- src/components/blog-post.html -->
 * <script data-bascik-build>
 * import { readFile } from 'node:fs/promises';
 * import { marked }   from 'marked';
 * const md = await readFile('./content/posts/intro.md', 'utf8');
 * console.log(marked(md));
 * </script>
 * ```
 *
 * Rules
 * ──────────────────────────────────────────────────────────────────────────────
 * - The script is written to a temporary `.mjs` file and executed with the
 *   same Node.js binary that is running Bascik.
 * - Top-level `import` statements and top-level `await` are supported.
 * - The script's working directory is the project root (`process.cwd()`).
 * - Use `console.log()` or `process.stdout.write()` to output the HTML to
 *   inject.  Anything written to stderr is forwarded to Bascik's own stderr.
 * - The script tag (including its attributes and closing tag) is completely
 *   replaced by the stdout output.  If the script produces no output, the tag
 *   is replaced with an empty string.
 * - On execution error, Bascik logs a warning and removes the script tag from
 *   the output rather than aborting the build.
 * - Scripts run during both `bascik` (dev) and `bascik --build` (production).
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { freemem, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getRelativePath } from "./file-system.ts";
import { BascikConfig } from "./config.ts";
import { getSiteUrl } from "./environment.ts";
import { cleanStackTrace } from "./stack-trace.ts";
import { computePagePath } from "./routes.ts";
import type { RouteEntry } from "./types.ts";

export { cleanStackTrace };

// Limits concurrent child-process spawns based on available memory.
// Initialized lazily on first use so freemem() reflects the live state at startup.
class Semaphore {
  private slots: number;
  private readonly queue: Array<() => void> = [];
  constructor(limit: number) { this.slots = limit; }
  acquire(): Promise<void> {
    if (this.slots > 0) { this.slots--; return Promise.resolve(); }
    return new Promise(resolve => this.queue.push(resolve));
  }
  release(): void {
    const next = this.queue.shift();
    if (next) next(); else this.slots++;
  }
}

const MEM_PER_CHILD = 100 * 1024 * 1024; // ~100 MB per Node child process
let _sem: Semaphore | undefined;
const childSemaphore = () => _sem ??= new Semaphore(
  // freemem() is near-zero on macOS (compressed/inactive memory isn't "free"),
  // so floor at 25% of total RAM to avoid artificially serializing on dev machines.
  Math.max(1, Math.floor(Math.max(freemem() * 0.6, totalmem() * 0.25) / MEM_PER_CHILD))
);

// Manual promise wrapper so tests can mock execFile with a plain vi.fn()
// without needing to simulate Node's promisify.custom symbol.
const runModule = async (
  path: string,
  extraEnv: Record<string, string> = {},
  args: string[] = [],
): Promise<{ stdout: string; stderr: string }> => {
  const sem = childSemaphore();
  await sem.acquire();
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    BASCIK_BUILD: BascikConfig.isBuild ? "1" : "0",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    ...extraEnv,
  };
  if (!extraEnv.BASCIK_ROUTE) {
    delete childEnv.BASCIK_ROUTE;
  }
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path, ...args],
      {
        cwd: process.cwd(),
        env: childEnv as Record<string, string>,
        timeout: BUILD_SCRIPT_TIMEOUT,
        killSignal: "SIGTERM",
      },
      (err, stdout, stderr) => {
        sem.release();
        if (err) reject(Object.assign(err, { stdout, stderr }));
        else resolve({ stdout, stderr });
      },
    );
  });
};

// Quote-aware open-tag scanning.  An attribute is a bare name with an
// optional `="..."`/`='...'`/`=bare` value; `>` inside a quoted value must
// not terminate the open tag, and `data-bascik-build` must be an actual
// attribute name — never a substring of another attribute's value.
const BARE_TOKEN = String.raw`[^\s"'=<>\`]+`;
const ATTR_VALUE = String.raw`(?:"[^"]*"|'[^']*'|${BARE_TOKEN})`;
const ATTR = String.raw`${BARE_TOKEN}(?:\s*=\s*${ATTR_VALUE})?`;
const FLAG = String.raw`data-bascik-build(?:\s*=\s*${ATTR_VALUE})?`;
const SERVER_FLAG = String.raw`data-bascik-server(?:\s*=\s*${ATTR_VALUE})?`;
const ROUTES_FLAG = String.raw`data-bascik-routes(?:\s*=\s*${ATTR_VALUE})?`;

const SCRIPT_TAG_PREFIX = "<script\\b";

// Match <script data-bascik-build …> … </script> (captures inner content).
const BUILD_SCRIPT_RE = new RegExp(
  `${SCRIPT_TAG_PREFIX}(?:\\s+${ATTR})*\\s+${FLAG}(?:\\s+${ATTR})*\\s*>([\\s\\S]*?)<\\/script>`,
  "gi",
);

const BUILD_SERVER_CONFLICT_RE = new RegExp(
  `${SCRIPT_TAG_PREFIX}(?:\\s+${ATTR})*\\s+${SERVER_FLAG}(?:\\s+${ATTR})*\\s*>`,
  "i",
);

const BUILD_ROUTES_CONFLICT_RE = new RegExp(
  `${SCRIPT_TAG_PREFIX}(?:\\s+${ATTR})*\\s+${ROUTES_FLAG}(?:\\s+${ATTR})*\\s*>`,
  "i",
);

// Strip ANSI terminal color sequences so build-time HTML injection never leaks
// Netlify/CI color escapes (e.g. FORCE_COLOR=1) into the final page markup.
const stripAnsiEscapeCodes = (value: string): string =>
  value.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B[@-Z\\-_]/g, "");

/** Per-build-script execution timeout (ms). Keeps a hung script from hanging the build forever. */
const BUILD_SCRIPT_TIMEOUT = 60_000;

// ─── Build-script output cache ───────────────────────────────────────────────
// Caches child-process output on disk, keyed by a SHA-256 hash of the script
// content plus the content of any local files it references. Subsequent builds
// skip the Node.js child-process spawn entirely for unchanged scripts.

// Bump to invalidate all existing disk cache entries (e.g. when key composition changes).
export const SCRIPT_CACHE_VERSION = 5;

// In-memory cache for dependency file contents during a build run and in-memory cache for outputs.
const depContentCache = new Map<string, string>();
const inMemoryScriptOutputCache = new Map<string, string>();

/** Clear in-memory caches (called on watch change or between test runs). */
export const clearBuildScriptCaches = (filePath?: string): void => {
  if (filePath) {
    const absPath = resolve(process.cwd(), filePath);
    const relKey = relative(process.cwd(), absPath).replace(/\\/g, "/");
    depContentCache.delete(relKey);
  } else {
    depContentCache.clear();
  }
  inMemoryScriptOutputCache.clear();
};

const readCachedFile = async (absPath: string, relKey: string): Promise<string> => {
  const cached = depContentCache.get(relKey);
  if (cached !== undefined) return cached;
  const content = await readFile(absPath, "utf8");
  depContentCache.set(relKey, content);
  return content;
};

const ALL_PAGE_SCRIPTS_RE = new RegExp(
  `${SCRIPT_TAG_PREFIX}(?:\\s+${ATTR})*\\s+(?:${FLAG}|${ROUTES_FLAG})(?:\\s+${ATTR})*\\s*>([\\s\\S]*?)<\\/script>`,
  "gi",
);

/**
 * Extract all local file dependencies referenced by `<script data-bascik-build>`
 * and `<script data-bascik-routes>` blocks in `html`, recursively scanning
 * referenced local JS/TS/MJS files.
 */
export const collectAllScriptDeps = async (html: string): Promise<string[]> => {
  const matches = [...html.matchAll(new RegExp(ALL_PAGE_SCRIPTS_RE.source, "gi"))];
  if (matches.length === 0) return [];

  const visited = new Set<string>();
  const queue: string[] = [];

  for (const match of matches) {
    const script = match[1];
    const deps = extractScriptDeps(script);
    for (const d of deps) queue.push(d);
  }

  while (queue.length > 0) {
    const rawDep = queue.shift()!;
    const absPath = resolve(process.cwd(), rawDep);
    const relKey = relative(process.cwd(), absPath).replace(/\\/g, "/");

    if (visited.has(relKey)) continue;
    visited.add(relKey);

    try {
      const content = await readCachedFile(absPath, relKey);
      const fileDir = dirname(absPath);
      const nested = extractScriptDeps(content, fileDir);
      for (const n of nested) {
        if (!visited.has(n)) queue.push(n);
      }
    } catch {
      // ignore missing files or read errors
    }
  }

  return [...visited];
};

// Extract relative paths the script depends on from quoted string literals:
//   './content/foo.md', 'scripts/md-renderer.mjs', './data/items.json'
export const extractScriptDeps = (script: string, baseDir: string = process.cwd()): string[] => {
  const seen = new Set<string>();
  for (const m of script.matchAll(
    /['`"]((?:\.{1,2}\/|[a-zA-Z0-9_$-]+\/)[^'`"\n:]+\.(?:md|mjs|js|jsx|ts|tsx|json|yaml|yml|css|html|txt|csv|svg))['`"]/g,
  )) {
    const specifier = m[1];
    if (specifier.includes("://")) continue;
    if (baseDir === process.cwd()) {
      seen.add(specifier);
    } else {
      const absPath = resolve(baseDir, specifier);
      const relPath = relative(process.cwd(), absPath).replace(/\\/g, "/");
      seen.add(relPath);
    }
  }
  return [...seen];
};

const computeScriptCacheKey = async (
  script: string,
  isBuild: boolean,
  filePath: string,
  siteUrl: string,
  routeStr: string = "",
  pageFile: string = "",
  pagePath: string = "",
): Promise<string> => {
  const hash = createHash("sha256");
  hash.update(String(SCRIPT_CACHE_VERSION));
  hash.update(script);
  hash.update(isBuild ? "1" : "0");
  hash.update(filePath);   // BASCIK_TEMPLATE_FILE
  hash.update(pageFile);   // BASCIK_PAGE_FILE
  hash.update(pagePath);   // BASCIK_PAGE_PATH — varies per page for page-aware scripts
  hash.update(siteUrl);    // BASCIK_SITE_URL  — can affect script output
  hash.update(routeStr);   // BASCIK_ROUTE     — varies per dynamic route

  const visited = new Set<string>();
  const queue = extractScriptDeps(script);

  while (queue.length > 0) {
    const rawDep = queue.shift()!;
    const absPath = resolve(process.cwd(), rawDep);
    const relKey = relative(process.cwd(), absPath).replace(/\\/g, "/");

    if (visited.has(relKey)) continue;
    visited.add(relKey);

    try {
      const content = await readCachedFile(absPath, relKey);
      hash.update(relKey);
      hash.update(content);

      // Scan file content for nested dependencies relative to the file's directory
      const fileDir = dirname(absPath);
      const nested = extractScriptDeps(content, fileDir);
      for (const n of nested) {
        if (!visited.has(n)) queue.push(n);
      }
    } catch {
      hash.update(relKey);
      hash.update("MISSING");
    }
  }

  return hash.digest("hex");
};

const readScriptCache = async (
  cacheDir: string,
  key: string,
): Promise<string | null> => {
  const memCached = inMemoryScriptOutputCache.get(key);
  if (memCached !== undefined) return memCached;
  try {
    const raw = await readFile(join(cacheDir, `${key}.json`), "utf8");
    const entry = JSON.parse(raw) as { v?: number; output?: string };
    if (typeof entry === "object" && entry !== null && entry.v === SCRIPT_CACHE_VERSION && typeof entry.output === "string") {
      inMemoryScriptOutputCache.set(key, entry.output);
      return entry.output;
    }
  } catch { /* cache miss */ }
  return null;
};

const writeScriptCache = async (
  cacheDir: string,
  key: string,
  output: string,
): Promise<void> => {
  inMemoryScriptOutputCache.set(key, output);
  // Best-effort: don't let a cache write failure abort the build.
  await writeFile(
    join(cacheDir, `${key}.json`),
    JSON.stringify({ v: SCRIPT_CACHE_VERSION, output }),
    "utf8",
  ).catch(() => { });
};

export interface ExecuteBuildScriptOptions {
  pageFile?: string;
  pagePath?: string;
  sourceFile?: string;
}

/**
 * Find every `<script data-bascik-build>` block in `html`, execute each as a
 * Node.js ESM module, and replace the tag with the script's stdout output.
 */
export const executeBuildScripts = async (
  html: string,
  filePath?: string,
  route?: RouteEntry | null,
  options?: ExecuteBuildScriptOptions,
): Promise<string> => {
  const matches = [...html.matchAll(BUILD_SCRIPT_RE)];
  if (matches.length === 0) return html;

  let result = html;

  // Ensure a temp directory exists for writing ephemeral build scripts.
  // Using node_modules/.cache keeps temp files within the project tree so
  // that Node.js ESM resolution can walk up and find the project's own
  // node_modules when build scripts import third-party packages (e.g. marked).
  const tempDir = join(process.cwd(), "node_modules", ".cache", "bascik");
  const cacheDir = join(tempDir, "script-cache");
  await Promise.all([
    mkdir(tempDir, { recursive: true }),
    mkdir(cacheDir, { recursive: true }),
  ]);

  const useCache = BascikConfig.scripts?.cache?.enabled !== false;
  const sourceFile = options?.sourceFile ?? filePath ?? "";
  const pageFile = options?.pageFile ?? filePath ?? "";
  const resolvedSiteUrl = getSiteUrl();
  const siteUrl = resolvedSiteUrl ?? "";
  const routeStr = route ? JSON.stringify(route) : "";
  const pagePath = options?.pagePath ?? (pageFile ? computePagePath(pageFile, BascikConfig.directory?.pages ?? "src/pages", route) : "");

  interface ScriptTask {
    fullTag: string;
    index: number;
    openTag: string;
    trimmedScript: string;
    cacheKey: string | null;
    startLine: number;
    tmpPath: string;
    output?: string;
  }

  const tasks: ScriptTask[] = [];

  for (const match of matches) {
    const [fullTag, scriptContent] = match;
    const index = match.index ?? 0;

    const openTag = fullTag.slice(0, fullTag.length - scriptContent.length - "</script>".length);
    if (BUILD_SERVER_CONFLICT_RE.test(openTag)) {
      let errorMsg = `[bascik] error: <script> tag has both data-bascik-build and data-bascik-server`;
      if (filePath) {
        const prefix = html.slice(0, index);
        const prefixLines = prefix.split(/\r?\n/);
        errorMsg += ` in "${getRelativePath(filePath, "pages")}" at (line ${prefixLines.length}, column ${prefixLines[prefixLines.length - 1].length + 1})`;
      }
      throw new Error(`${errorMsg}. A script can only run at build time or at request time — not both. Remove one of the attributes.`);
    }

    if (BUILD_ROUTES_CONFLICT_RE.test(openTag)) {
      let errorMsg = `[bascik] error: <script> tag has both data-bascik-build and data-bascik-routes`;
      if (filePath) {
        const prefix = html.slice(0, index);
        const prefixLines = prefix.split(/\r?\n/);
        errorMsg += ` in "${getRelativePath(filePath, "pages")}" at (line ${prefixLines.length}, column ${prefixLines[prefixLines.length - 1].length + 1})`;
      }
      throw new Error(`${errorMsg}. A script cannot be both a build script and a routes script. Remove one of the attributes.`);
    }

    let trimmedScript = scriptContent.trim();
    if (!trimmedScript) {
      const srcMatch = openTag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      if (srcMatch) {
        const srcPath = srcMatch[1] ?? srcMatch[2] ?? srcMatch[3];
        const resolvedPath = sourceFile ? resolve(dirname(sourceFile), srcPath) : (filePath ? resolve(dirname(filePath), srcPath) : resolve(process.cwd(), srcPath));
        try {
          trimmedScript = await readFile(resolvedPath, "utf8");
        } catch (err) {
          console.warn('[bascik] warning: Failed to read build script src "%s":', srcPath, err);
        }
      }
    }

    const cacheKey = useCache
      ? await computeScriptCacheKey(trimmedScript, BascikConfig.isBuild ?? false, sourceFile, siteUrl, routeStr, pageFile, pagePath)
      : null;

    const prefix = html.slice(0, index);
    const lines = prefix.split(/\r?\n/);
    const lineOffset = lines.length;
    const openTagLines = openTag.split(/\r?\n/).length - 1;
    const startLine = lineOffset + openTagLines;

    const tmpPath = join(
      tempDir,
      `build-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
    );

    tasks.push({
      fullTag,
      index,
      openTag,
      trimmedScript,
      cacheKey,
      startLine,
      tmpPath,
    });
  }

  // Check cache for all tasks
  const uncachedTasks: ScriptTask[] = [];
  for (const task of tasks) {
    if (task.cacheKey !== null) {
      const cached = await readScriptCache(cacheDir, task.cacheKey);
      if (cached !== null) {
        task.output = cached;
        continue;
      }
    }
    uncachedTasks.push(task);
  }

  if (uncachedTasks.length > 0) {
    let sourceUrlComment = "";
    const activeFile = sourceFile || filePath;
    if (activeFile) {
      const relPath = relative(process.cwd(), activeFile).replace(/\\/g, "/");
      sourceUrlComment = `\n//# sourceURL=${relPath}`;
    }

    const relPath = activeFile ? relative(process.cwd(), activeFile).replace(/\\/g, "/") : "unknown";
    const extraEnv: Record<string, string> = {
      BASCIK_TEMPLATE_FILE: sourceFile,
      BASCIK_PAGE_FILE: pageFile,
      BASCIK_PAGE_PATH: pagePath,
      BASCIK_PAGES_DIR: resolve(process.cwd(), BascikConfig.directory.pages),
    };
    // Only set BASCIK_SITE_URL when a value exists: an absent key lets scripts
    // distinguish "unset" from "empty".
    if (resolvedSiteUrl !== undefined) {
      extraEnv.BASCIK_SITE_URL = resolvedSiteUrl;
    }
    if (route) {
      extraEnv.BASCIK_ROUTE = JSON.stringify(route);
    }

    if (uncachedTasks.length === 1) {
      const task = uncachedTasks[0];
      try {
        await writeFile(task.tmpPath, task.trimmedScript + sourceUrlComment, "utf8");
        const { stdout, stderr } = await runModule(task.tmpPath, extraEnv);
        if (stderr) process.stderr.write(stderr);
        const output = stripAnsiEscapeCodes(stdout);
        if (task.cacheKey !== null) await writeScriptCache(cacheDir, task.cacheKey, output);
        task.output = output;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        let errorMsg = `[bascik] build script error`;
        const cleanedMsg = cleanStackTrace(msg, task.tmpPath, relPath, task.startLine);
        if (filePath) {
          const prefix = html.slice(0, task.index);
          const lines = prefix.split(/\r?\n/);
          errorMsg += ` in "${getRelativePath(filePath, "pages")}" at (line ${lines.length}, column ${lines[lines.length - 1].length + 1})`;
        }
        const behavior = BascikConfig.scripts?.onBuildScriptError ?? "error";
        if (behavior === "error") {
          console.error(`${errorMsg}:\n${cleanedMsg}`);
          throw new Error(`${errorMsg}:\n${cleanedMsg}`);
        } else {
          console.warn(`${errorMsg}:\n${cleanedMsg}`);
        }
        task.output = "";
      } finally {
        await unlink(task.tmpPath).catch(() => { });
      }
    } else {
      // Batch execution of multiple uncached scripts in a single child process
      const runnerExt = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
      const runnerUrl = new URL(`./build-script-runner${runnerExt}`, import.meta.url);
      const runnerPath = fileURLToPath(runnerUrl);

      try {
        await Promise.all(
          uncachedTasks.map((task) =>
            writeFile(task.tmpPath, task.trimmedScript + sourceUrlComment, "utf8")
          ),
        );

        const { stdout, stderr } = await runModule(
          runnerPath,
          extraEnv,
          uncachedTasks.map((task) => task.tmpPath),
        );
        if (stderr) process.stderr.write(stderr);

        let parsedResults: Array<{ id: number; ok: boolean; stdout?: string; stderr?: string; error?: string }> | null = null;
        try {
          const trimmed = stdout.trim();
          if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
            parsedResults = JSON.parse(trimmed);
          }
        } catch {
          parsedResults = null;
        }

        if (Array.isArray(parsedResults)) {
          for (const res of parsedResults) {
            const task = uncachedTasks[res.id];
            if (!task) continue;
            if (res.stderr) process.stderr.write(res.stderr);
            if (res.ok) {
              const output = stripAnsiEscapeCodes(res.stdout ?? "");
              if (task.cacheKey !== null) await writeScriptCache(cacheDir, task.cacheKey, output);
              task.output = output;
            } else {
              const msg = res.error ?? "unknown error";
              let errorMsg = `[bascik] build script error`;
              const cleanedMsg = cleanStackTrace(msg, task.tmpPath, relPath, task.startLine);
              if (filePath) {
                const prefix = html.slice(0, task.index);
                const lines = prefix.split(/\r?\n/);
                errorMsg += ` in "${getRelativePath(filePath, "pages")}" at (line ${lines.length}, column ${lines[lines.length - 1].length + 1})`;
              }
              const behavior = BascikConfig.scripts?.onBuildScriptError ?? "error";
              if (behavior === "error") {
                console.error(`${errorMsg}:\n${cleanedMsg}`);
                throw new Error(`${errorMsg}:\n${cleanedMsg}`);
              } else {
                console.warn(`${errorMsg}:\n${cleanedMsg}`);
              }
              task.output = "";
            }
          }
        } else {
          // Fallback if runner did not produce JSON (e.g. mocked execFile in tests)
          for (const task of uncachedTasks) {
            try {
              const { stdout: singleStdout, stderr: singleStderr } = await runModule(task.tmpPath, extraEnv);
              if (singleStderr) process.stderr.write(singleStderr);
              const output = stripAnsiEscapeCodes(singleStdout);
              if (task.cacheKey !== null) await writeScriptCache(cacheDir, task.cacheKey, output);
              task.output = output;
            } catch (singleErr) {
              const msg = singleErr instanceof Error ? singleErr.message : String(singleErr);
              let errorMsg = `[bascik] build script error`;
              const cleanedMsg = cleanStackTrace(msg, task.tmpPath, relPath, task.startLine);
              if (filePath) {
                const prefix = html.slice(0, task.index);
                const lines = prefix.split(/\r?\n/);
                errorMsg += ` in "${getRelativePath(filePath, "pages")}" at (line ${lines.length}, column ${lines[lines.length - 1].length + 1})`;
              }
              const behavior = BascikConfig.scripts?.onBuildScriptError ?? "error";
              if (behavior === "error") {
                console.error(`${errorMsg}:\n${cleanedMsg}`);
                throw new Error(`${errorMsg}:\n${cleanedMsg}`);
              } else {
                console.warn(`${errorMsg}:\n${cleanedMsg}`);
              }
              task.output = "";
            }
          }
        }
      } catch (err) {
        // Fallback or runner failure handling
        const msg = err instanceof Error ? err.message : String(err);
        for (const task of uncachedTasks) {
          let errorMsg = `[bascik] build script error`;
          const cleanedMsg = cleanStackTrace(msg, task.tmpPath, relPath, task.startLine);
          if (filePath) {
            const prefix = html.slice(0, task.index);
            const lines = prefix.split(/\r?\n/);
            errorMsg += ` in "${getRelativePath(filePath, "pages")}" at (line ${lines.length}, column ${lines[lines.length - 1].length + 1})`;
          }
          const behavior = BascikConfig.scripts?.onBuildScriptError ?? "error";
          if (behavior === "error") {
            console.error(`${errorMsg}:\n${cleanedMsg}`);
            throw new Error(`${errorMsg}:\n${cleanedMsg}`);
          } else {
            console.warn(`${errorMsg}:\n${cleanedMsg}`);
          }
          task.output = "";
        }
      } finally {
        await Promise.all(
          uncachedTasks.map((t) => unlink(t.tmpPath).catch(() => { })),
        );
      }
    }
  }

  // Splice each script's output in at its own match index, from right to left
  // so earlier indices stay valid. Index splicing is inherently safe against
  // `$`-style replacement patterns and against duplicate identical tags.
  tasks.sort((a, b) => b.index - a.index);
  for (const { fullTag, index, output } of tasks) {
    result = result.slice(0, index) + (output ?? "") + result.slice(index + fullTag.length);
  }

  return result;
};
