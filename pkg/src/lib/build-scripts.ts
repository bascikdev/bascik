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

import { createHash } from "node:crypto";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getRelativePath } from "./file-system.ts";
import { BascikConfig } from "./config.ts";
import { getSiteUrl } from "./environment.ts";
import { cleanStackTrace } from "./stack-trace.ts";
import { computePagePath } from "./routes.ts";
import { runModule, stripAnsiEscapeCodes } from "./script-runner.ts";
import {
  findCallArgumentStringLiterals,
  findModuleSpecifiers,
  rewriteRelativeModuleSpecifiers,
} from "./module-specifiers.ts";
import { isScriptCacheEnabledForPath, pruneScriptCache } from "./script-cache.ts";
import {
  ATTR,
  BUILD_FLAG,
  SERVER_FLAG,
  ROUTES_FLAG,
  SCRIPT_TAG_PREFIX,
  getHtmlAttributeValue,
} from "./html-patterns.ts";
import type { RouteEntry } from "./types.ts";

// Match <script data-bascik-build …> … </script> (captures inner content).
const BUILD_SCRIPT_RE = new RegExp(
  `${SCRIPT_TAG_PREFIX}(?:\\s+${ATTR})*\\s+${BUILD_FLAG}(?:\\s+${ATTR})*\\s*>([\\s\\S]*?)<\\/script>`,
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

// ─── Build-script output cache ───────────────────────────────────────────────
// Caches child-process output on disk, keyed by a SHA-256 hash of the script
// content plus the content of any local files it references. Subsequent builds
// skip the Node.js child-process spawn entirely for unchanged scripts.

// Bump to invalidate all existing disk cache entries (e.g. when key composition changes).
export const SCRIPT_CACHE_VERSION = 7;

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
  `${SCRIPT_TAG_PREFIX}(?:\\s+${ATTR})*\\s+(?:${BUILD_FLAG}|${ROUTES_FLAG})(?:\\s+${ATTR})*\\s*>([\\s\\S]*?)<\\/script>`,
  "gi",
);

/**
 * Extract all local file dependencies referenced by `<script data-bascik-build>`
 * and `<script data-bascik-routes>` blocks in `html`, recursively scanning
 * referenced local JS/TS/MJS files.
 */
export const collectAllScriptDeps = async (html: string, sourceFile?: string): Promise<string[]> => {
  const matches = [...html.matchAll(new RegExp(ALL_PAGE_SCRIPTS_RE.source, "gi"))];
  if (matches.length === 0) return [];

  const scriptBaseDir = sourceFile
    ? dirname(resolve(process.cwd(), sourceFile))
    : process.cwd();

  const visited = new Set<string>();
  const queue: string[] = [];

  for (const match of matches) {
    const script = match[1];
    const srcPath = getHtmlAttributeValue(match[0], "src");
    if (srcPath) {
      const absPath = resolve(scriptBaseDir, srcPath);
      queue.push(relative(process.cwd(), absPath).replace(/\\/g, "/"));
    }
    const deps = extractScriptDeps(script, scriptBaseDir);
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
export const extractScriptDeps = (script: string, esmBaseDir: string = process.cwd()): string[] => {
  const seen = new Set<string>();

  const moduleSpecifiers = findModuleSpecifiers(script);
  const moduleRanges = new Set(moduleSpecifiers.map(({ start, end }) => `${start}:${end}`));
  for (const { value: specifier } of moduleSpecifiers) {
    if (!(specifier.startsWith("./") || specifier.startsWith("../"))) continue;
    const absPath = resolve(esmBaseDir, specifier);
    seen.add(relative(process.cwd(), absPath).replace(/\\/g, "/"));
  }

  for (const { start, end, value: specifier } of findCallArgumentStringLiterals(script)) {
    if (!/(?:\.{1,2}\/|[a-zA-Z0-9_$-]+\/)[^\n:]+\.(?:md|mjs|js|jsx|ts|tsx|json|yaml|yml|css|html|txt|csv|svg)$/.test(specifier)) continue;
    if (specifier.includes("://")) continue;
    if (moduleRanges.has(`${start}:${end}`)) continue;
    seen.add(specifier);
  }
  return [...seen];
};

export const resolveBuildScriptImports = rewriteRelativeModuleSpecifiers;

const computeScriptCacheKey = async (
  script: string,
  baseDir: string,
  isBuild: boolean,
  filePath: string,
  siteUrl: string,
  base: string,
  routeStr: string = "",
  pageFile: string = "",
  pagePath: string = "",
): Promise<string> => {
  const hash = createHash("sha256");
  hash.update(String(SCRIPT_CACHE_VERSION));
  hash.update(script);
  hash.update(isBuild ? "1" : "0");
  hash.update(filePath);   // BASCIK_SOURCE_FILE
  hash.update(pageFile);   // BASCIK_PAGE_FILE
  hash.update(pagePath);   // BASCIK_PAGE_PATH — varies per page for page-aware scripts
  hash.update(siteUrl);    // BASCIK_SITE_URL  — can affect script output
  hash.update(base);       // BASCIK_BASE      — can affect script output
  hash.update(routeStr);   // BASCIK_ROUTE     — varies per dynamic route

  const visited = new Set<string>();
  const queue = [...extractScriptDeps(script, baseDir)];

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
  await pruneScriptCache(cacheDir);

  const defaultSourceFile = options?.sourceFile ?? filePath ?? "";
  const pageFile = options?.pageFile ?? filePath ?? "";
  const resolvedSiteUrl = getSiteUrl();
  const siteUrl = resolvedSiteUrl ?? "";
  const routeStr = route ? JSON.stringify(route) : "";
  const pagePath = options?.pagePath ?? (pageFile ? computePagePath(pageFile, BascikConfig.directory?.pages ?? "src/pages", route) : "");

  interface ScriptTask {
    fullTag: string;
    index: number;
    openTag: string;
    preparedScript: string;
    cacheKey: string | null;
    startLine: number;
    tmpPath: string;
    sourceFile: string;
    output?: string;
  }

  const tasks: ScriptTask[] = [];

  for (const match of matches) {
    const [fullTag, scriptContent] = match;
    const index = match.index ?? 0;

    const openTag = fullTag.slice(0, fullTag.length - scriptContent.length - "</script>".length);
    const annotatedSourceFile = getHtmlAttributeValue(openTag, "data-bascik-source-file");
    const sourceFile = annotatedSourceFile
      ? decodeURIComponent(annotatedSourceFile)
      : defaultSourceFile;
    const useCache = isScriptCacheEnabledForPath(sourceFile || filePath);
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
      const srcPath = getHtmlAttributeValue(openTag, "src");
      if (srcPath) {
        const resolvedPath = sourceFile ? resolve(dirname(sourceFile), srcPath) : (filePath ? resolve(dirname(filePath), srcPath) : resolve(process.cwd(), srcPath));
        try {
          trimmedScript = await readFile(resolvedPath, "utf8");
        } catch (err) {
          console.warn('[bascik] warning: Failed to read build script src "%s":', srcPath, err);
        }
      }
    }

    let scriptBaseDir = sourceFile
      ? dirname(resolve(process.cwd(), sourceFile))
      : filePath
        ? dirname(resolve(process.cwd(), filePath))
        : process.cwd();

    if (!scriptContent.trim()) {
      const srcPath = getHtmlAttributeValue(openTag, "src");
      if (srcPath) {
        scriptBaseDir = sourceFile
          ? dirname(resolve(dirname(sourceFile), srcPath))
          : filePath
            ? dirname(resolve(dirname(filePath), srcPath))
            : dirname(resolve(process.cwd(), srcPath));
      }
    }

    const preparedScript = resolveBuildScriptImports(trimmedScript, scriptBaseDir);

    const cacheKey = useCache
      ? await computeScriptCacheKey(trimmedScript, scriptBaseDir, BascikConfig.isBuild ?? false, sourceFile, siteUrl, BascikConfig.base ?? "/", routeStr, pageFile, pagePath)
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
      preparedScript,
      cacheKey,
      startLine,
      tmpPath,
      sourceFile,
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
    const extraEnv: Record<string, string> = {
      BASCIK_SOURCE_FILE: defaultSourceFile,
      BASCIK_PAGE_FILE: pageFile,
      BASCIK_PAGE_PATH: pagePath,
      BASCIK_PAGES_DIR: resolve(process.cwd(), BascikConfig.directory.pages),
      BASCIK_BASE: BascikConfig.base ?? "/",
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
      const taskActiveFile = task.sourceFile || filePath;
      const taskRelPath = taskActiveFile
        ? relative(process.cwd(), taskActiveFile).replace(/\\/g, "/")
        : "unknown";
      const taskSourceUrlComment = taskActiveFile ? `\n//# sourceURL=${taskRelPath}` : "";
      const taskEnv = {
        ...extraEnv,
        BASCIK_SOURCE_FILE: task.sourceFile,
      };
      try {
        await writeFile(task.tmpPath, task.preparedScript + taskSourceUrlComment, "utf8");
        const { stdout, stderr } = await runModule(task.tmpPath, taskEnv);
        if (stderr) process.stderr.write(stderr);
        const output = stripAnsiEscapeCodes(stdout);
        if (task.cacheKey !== null) await writeScriptCache(cacheDir, task.cacheKey, output);
        task.output = output;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        let errorMsg = `[bascik] build script error`;
        const cleanedMsg = cleanStackTrace(msg, task.tmpPath, taskRelPath, task.startLine);
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
          uncachedTasks.map((task) => {
            const taskActiveFile = task.sourceFile || filePath;
            const taskRelPath = taskActiveFile
              ? relative(process.cwd(), taskActiveFile).replace(/\\/g, "/")
              : "unknown";
            const taskSourceUrlComment = taskActiveFile ? `\n//# sourceURL=${taskRelPath}` : "";
            return writeFile(
              task.tmpPath,
              task.preparedScript + taskSourceUrlComment,
              "utf8",
            );
          }),
        );

        const { stdout, stderr } = await runModule(
          runnerPath,
          extraEnv,
          uncachedTasks.map((task) => JSON.stringify({
            file: task.tmpPath,
            sourceFile: task.sourceFile,
          })),
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
              const taskActiveFile = task.sourceFile || filePath;
              const taskRelPath = taskActiveFile
                ? relative(process.cwd(), taskActiveFile).replace(/\\/g, "/")
                : "unknown";
              const cleanedMsg = cleanStackTrace(msg, task.tmpPath, taskRelPath, task.startLine);
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
          // If the runner process failed or output envelope was corrupted, fail loudly without re-executing
          const errorMsg = `[bascik] build script runner failed to return valid JSON results.\nStdout: ${stdout}\nStderr: ${stderr}`;
          console.error(errorMsg);
          throw new Error(errorMsg);
        }
      } catch (err) {
        // Runner failure handling: report error per failing script without double wrapping
        const behavior = BascikConfig.scripts?.onBuildScriptError ?? "error";
        if (behavior === "error") {
          throw err;
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(msg);
          for (const task of uncachedTasks) {
            if (task.output === undefined) task.output = "";
          }
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
