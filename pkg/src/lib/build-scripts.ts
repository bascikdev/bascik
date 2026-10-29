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
import { pathToFileURL } from "node:url";
import { getProjectPath, getRelativePath } from "./file-system.ts";
import { BuildScriptError, type BuildScriptLocation } from "./build-error.ts";
import type { BuildScriptStats } from "./build-script-stats.ts";
import {
  directiveSourcePosition,
  padToSourcePosition,
} from "./directive-source.ts";
import { BascikConfig } from "./config.ts";
import { getSiteUrl } from "./environment.ts";
import { cleanStackTrace, remapRewrittenColumns } from "./stack-trace.ts";
import { computePagePath } from "./routes.ts";
import { runDirectiveHandler } from "./script-runner.ts";
import {
  LeadingSlashSpecifierError,
  classifySpecifier,
  resolveScriptSrcPath,
  resolveSpecifierPath,
  rewriteModuleSpecifiers,
  rewriteModuleSpecifiersWithEdits,
  scanScript,
  type SpecifierEdit,
} from "./module-specifiers.ts";
import {
  isScriptCacheEnabledForPath,
  pruneScriptCache,
} from "./script-cache.ts";
import {
  computePackageIdentity,
  collectPackageSpecifiers,
  hasDynamicImport,
  clearPackageIdentityCache,
} from "./package-identity.ts";
import { getImportRoot } from "./import-root.ts";
import {
  applyOutputScope,
  decodeOutputScope,
  OUTPUT_SCOPE_ATTRIBUTE,
  type OutputScope,
} from "./output-scope.ts";
import { removeOutputDirectives } from "./output-directives.ts";
import {
  ATTR,
  ANY_BUILD_FLAG,
  BUILD_FLAG,
  BUILD_ONCE_FLAG,
  SERVER_FLAG,
  ROUTES_FLAG,
  STREAM_FLAG,
  SCRIPT_END_TAG,
  SCRIPT_TAG_PREFIX,
  browserTagSpace,
  getHtmlAttributeValue,
  scriptOpenTag,
} from "./html-patterns.ts";
import type { RouteEntry } from "./types.ts";

// Match <script data-bascik-build …> … </script> (captures inner content).
// Every open tag here is read as the browser reads it (`browserTagSpace`):
// `<script\u00a0data-bascik-build>` is no script, so it never runs.
const BUILD_SCRIPT_RE = new RegExp(
  `${browserTagSpace(`${SCRIPT_TAG_PREFIX}(?:\\s+${ATTR})*\\s+${BUILD_FLAG}(?:\\s+${ATTR})*\\s*>`)}([\\s\\S]*?)${SCRIPT_END_TAG}`,
  "gi",
);

const BUILD_ONCE_SCRIPT_RE = new RegExp(
  `${browserTagSpace(`${SCRIPT_TAG_PREFIX}(?:\\s+${ATTR})*\\s+${BUILD_ONCE_FLAG}(?:\\s+${ATTR})*\\s*>`)}([\\s\\S]*?)${SCRIPT_END_TAG}`,
  "gi",
);

const BUILD_ONCE_OPEN_TAG_RE = new RegExp(
  browserTagSpace(
    `${SCRIPT_TAG_PREFIX}(?:\\s+${ATTR})*\\s+${BUILD_ONCE_FLAG}(?:\\s+${ATTR})*\\s*>`,
  ),
  "i",
);

const BUILD_MODE_CONFLICT_RE = new RegExp(
  browserTagSpace(
    `${SCRIPT_TAG_PREFIX}(?:\\s+${ATTR})*\\s+${BUILD_FLAG}(?:\\s+${ATTR})*\\s+${BUILD_ONCE_FLAG}(?:\\s+${ATTR})*\\s*>|${SCRIPT_TAG_PREFIX}(?:\\s+${ATTR})*\\s+${BUILD_ONCE_FLAG}(?:\\s+${ATTR})*\\s+${BUILD_FLAG}(?:\\s+${ATTR})*\\s*>`,
  ),
  "i",
);

const BUILD_SERVER_CONFLICT_RE = new RegExp(
  browserTagSpace(
    `${SCRIPT_TAG_PREFIX}(?:\\s+${ATTR})*\\s+${ANY_BUILD_FLAG}(?:\\s+${ATTR})*\\s+${SERVER_FLAG}(?:\\s+${ATTR})*\\s*>|${SCRIPT_TAG_PREFIX}(?:\\s+${ATTR})*\\s+${SERVER_FLAG}(?:\\s+${ATTR})*\\s+${ANY_BUILD_FLAG}(?:\\s+${ATTR})*\\s*>`,
  ),
  "i",
);

const BUILD_ROUTES_CONFLICT_RE = new RegExp(
  browserTagSpace(
    `${SCRIPT_TAG_PREFIX}(?:\\s+${ATTR})*\\s+${ANY_BUILD_FLAG}(?:\\s+${ATTR})*\\s+${ROUTES_FLAG}(?:\\s+${ATTR})*\\s*>|${SCRIPT_TAG_PREFIX}(?:\\s+${ATTR})*\\s+${ROUTES_FLAG}(?:\\s+${ATTR})*\\s+${ANY_BUILD_FLAG}(?:\\s+${ATTR})*\\s*>`,
  ),
  "i",
);

const BUILD_STREAM_CONFLICT_RE = new RegExp(
  browserTagSpace(
    `${SCRIPT_TAG_PREFIX}(?:\\s+${ATTR})*\\s+${ANY_BUILD_FLAG}(?:\\s+${ATTR})*\\s+${STREAM_FLAG}(?:\\s+${ATTR})*\\s*>|${SCRIPT_TAG_PREFIX}(?:\\s+${ATTR})*\\s+${STREAM_FLAG}(?:\\s+${ATTR})*\\s+${ANY_BUILD_FLAG}(?:\\s+${ATTR})*\\s*>`,
  ),
  "i",
);

const PROCESS_ENV_READ_RE = /\bprocess\.env\.([A-Za-z_$][A-Za-z0-9_$]*)\b/g;

// ─── Build-script output cache ───────────────────────────────────────────────
// Caches child-process output on disk, keyed by a SHA-256 hash of the script
// content plus the content of any local files it references. Subsequent builds
// skip the Node.js child-process spawn entirely for unchanged scripts.

// Bump to invalidate all existing disk cache entries (e.g. when key composition changes).
export const SCRIPT_CACHE_VERSION = 12;

// A script (or a local helper it imports) that names either variable can read
// the file it points at, which static dependency scanning cannot see. Such
// scripts fold that file's content into their cache key.
const CONTEXT_FILE_ENV_RE = /\bBASCIK_(?:SOURCE|PAGE)_FILE\b/;

export interface ImportRootOptions {
  /** Absolute import root that `@/` specifiers resolve against. */
  importRoot?: string;
}

// In-memory cache for dependency file contents during a build run and in-memory cache for outputs.
const depContentCache = new Map<string, string>();

/**
 * Entry cap for the in-memory build-script output memo. Each entry is one
 * script's rendered output (component scripts use the context of each page,
 * and in dev every edit to an inline body is a new key), so an unbounded map grows for
 * the life of a dev session. Eviction is FIFO in insertion order, like
 * `representationCache` in `caching.ts`: the on-disk cache still hits for an
 * evicted key, so eviction costs one file read, never a child spawn.
 */
export const MAX_IN_MEMORY_SCRIPT_OUTPUTS = 512;

const inMemoryScriptOutputCache = new Map<string, string>();
// Whether the run that produced a memoized output read its page context
// (BASCIK_PAGE_PATH, BASCIK_PAGE_FILE, BASCIK_ROUTE), kept beside the output so
// a cache hit can still answer `onReadsPageContext` (prompt 157). Absent for
// records written before the flag existed.
const memoizedPageContextReads = new Map<string, boolean>();

/**
 * Entry cap (distinct source texts) for the dependency scan memo. Every cache
 * key walks the script's full local dependency graph, and the same helpers are
 * reached from every page, so without the memo each key re-tokenizes every
 * helper. FIFO like the output memo; an evicted entry costs one rescan.
 */
export const MAX_DEPENDENCY_SCANS = 1024;
// Per-text cap on distinct resolution contexts (base directory, import root, cwd).
const MAX_DEPENDENCY_SCAN_CONTEXTS = 64;
// source text -> resolution context -> extracted dependencies. A scan is a pure
// function of exactly these inputs (`resolveSpecifierPath` does no I/O), so a
// hit can never be stale: changed file content is a different key. Clears only
// reclaim memory. Keying by the text itself lets lookups of a dependency's
// content (the string `depContentCache` retains) reuse its cached string hash.
const dependencyScanCache = new Map<string, Map<string, readonly string[]>>();
// Reverse index: dependency (project-relative key) -> the output cache keys
// whose hash folded that dependency's content in. Lets a per-path clear drop
// exactly the memoized outputs that read the changed file (prompt 139). Kept
// in lockstep with the memo: a key evicted or cleared from the memo is removed
// from every dependency's set, and a set that empties is deleted.
const outputKeysByDependency = new Map<string, Set<string>>();
// The dependencies each key's hash folded in, recorded by
// `computeScriptCacheKey` and consumed when (if) the output is memoized. Only
// memoized keys enter `outputKeysByDependency`, so the reverse index never
// holds a key the memo does not. Bounded: an entry is removed on memoization
// or eviction, and a key that is never memoized (script failed) is at most one
// pending list per distinct failing key until the next full clear.
const dependenciesByOutputKey = new Map<string, string[]>();

const unindexOutputKey = (key: string): void => {
  const deps = dependenciesByOutputKey.get(key);
  if (!deps) return;
  dependenciesByOutputKey.delete(key);
  for (const relKey of deps) {
    const keys = outputKeysByDependency.get(relKey);
    if (!keys) continue;
    keys.delete(key);
    if (keys.size === 0) outputKeysByDependency.delete(relKey);
  }
};

const indexOutputKey = (key: string): void => {
  const deps = dependenciesByOutputKey.get(key);
  if (!deps) return;
  for (const relKey of deps) {
    let keys = outputKeysByDependency.get(relKey);
    if (!keys) {
      keys = new Set();
      outputKeysByDependency.set(relKey, keys);
    }
    keys.add(key);
  }
};

const memoizeOutput = (
  key: string,
  output: string,
  readsPageContext?: boolean,
): void => {
  if (readsPageContext === undefined) memoizedPageContextReads.delete(key);
  else memoizedPageContextReads.set(key, readsPageContext);
  if (inMemoryScriptOutputCache.has(key)) {
    inMemoryScriptOutputCache.set(key, output);
    return;
  }
  while (inMemoryScriptOutputCache.size >= MAX_IN_MEMORY_SCRIPT_OUTPUTS) {
    const oldest = inMemoryScriptOutputCache.keys().next().value as string;
    inMemoryScriptOutputCache.delete(oldest);
    memoizedPageContextReads.delete(oldest);
    unindexOutputKey(oldest);
  }
  inMemoryScriptOutputCache.set(key, output);
  indexOutputKey(key);
};

/**
 * Clear in-memory caches (called on watch change or between test runs).
 *
 * With a `filePath`, only that dependency's memoized content and the memoized
 * outputs of the scripts that read it are dropped. Output entries are keyed by
 * `computeScriptCacheKey`, a hash over the script and the content of every
 * dependency it reads, so an entry memoized under the old content could never
 * be hit again anyway; dropping it here reclaims the memory and leaves every
 * unrelated script's memo intact so it does not re-read its disk cache entry.
 *
 * Without a `filePath`, all memos are cleared.
 */
export const clearBuildScriptCaches = (filePath?: string): void => {
  if (filePath) {
    const absPath = resolve(process.cwd(), filePath);
    const relKey = relative(process.cwd(), absPath).replace(/\\/g, "/");
    depContentCache.delete(relKey);
    const keys = outputKeysByDependency.get(relKey);
    if (keys) {
      for (const key of [...keys]) {
        inMemoryScriptOutputCache.delete(key);
        memoizedPageContextReads.delete(key);
        // Drop this key from every other dependency's set too, so no
        // dependency indexes a key that is no longer memoized.
        unindexOutputKey(key);
      }
      outputKeysByDependency.delete(relKey);
    }
    return;
  }
  depContentCache.clear();
  inMemoryScriptOutputCache.clear();
  memoizedPageContextReads.clear();
  outputKeysByDependency.clear();
  dependenciesByOutputKey.clear();
  dependencyScanCache.clear();
  clearPackageIdentityCache();
};

/** Observe the in-memory caches in tests without exposing the maps. */
export const _buildScriptCacheTestHooks = {
  hasDepContent(filePath: string): boolean {
    const relKey = relative(
      process.cwd(),
      resolve(process.cwd(), filePath),
    ).replace(/\\/g, "/");
    return depContentCache.has(relKey);
  },
  get depContentSize(): number {
    return depContentCache.size;
  },
  get outputCacheSize(): number {
    return inMemoryScriptOutputCache.size;
  },
  get dependencyScanSize(): number {
    return dependencyScanCache.size;
  },
  /** Number of memo keys the reverse index holds for a dependency. */
  reverseIndexKeyCount(filePath: string): number {
    const relKey = relative(
      process.cwd(),
      resolve(process.cwd(), filePath),
    ).replace(/\\/g, "/");
    return outputKeysByDependency.get(relKey)?.size ?? 0;
  },
  /** True when any reverse-index key is not a live memo entry. */
  reverseIndexHasStaleKeys(): boolean {
    for (const keys of outputKeysByDependency.values()) {
      for (const key of keys) {
        if (!inMemoryScriptOutputCache.has(key)) return true;
      }
    }
    return false;
  },
};

const readCachedFile = async (
  absPath: string,
  relKey: string,
): Promise<string> => {
  const cached = depContentCache.get(relKey);
  if (cached !== undefined) return cached;
  const content = await readFile(absPath, "utf8");
  depContentCache.set(relKey, content);
  return content;
};

const ALL_PAGE_SCRIPTS_RE = new RegExp(
  `${browserTagSpace(`${SCRIPT_TAG_PREFIX}(?:\\s+${ATTR})*\\s+(?:${ANY_BUILD_FLAG}|${ROUTES_FLAG})(?:\\s+${ATTR})*\\s*>`)}([\\s\\S]*?)${SCRIPT_END_TAG}`,
  "gi",
);

/**
 * Extract all local file dependencies referenced by build, build-once, and
 * routes script blocks in `html`, recursively scanning
 * referenced local JS/TS/MJS files.
 */
export const collectAllScriptDeps = async (
  html: string,
  sourceFile?: string,
): Promise<string[]> => {
  const matches = [
    ...html.matchAll(new RegExp(ALL_PAGE_SCRIPTS_RE.source, "gi")),
  ];
  if (matches.length === 0) return [];

  const scriptBaseDir = sourceFile
    ? dirname(resolve(process.cwd(), sourceFile))
    : process.cwd();
  const importRoot = getImportRoot();

  const visited = new Set<string>();
  const queue: string[] = [];

  for (const match of matches) {
    const script = match[1];
    const srcPath = getHtmlAttributeValue(match[0], "src");
    // Leading-slash src= is rejected by the executor with a located error;
    // skip it here so dependency collection never throws.
    if (srcPath && classifySpecifier(srcPath) !== "root-slash") {
      const absPath = resolveScriptSrcPath(srcPath, scriptBaseDir, importRoot);
      queue.push(relative(process.cwd(), absPath).replace(/\\/g, "/"));
    }
    const deps = extractScriptDeps(script, scriptBaseDir, { importRoot });
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
      // Helper files loaded from disk are not rewritten by Bascik, so only
      // their relative imports are followed; importRoot is passed for parity
      // with the cache key walk.
      const nested = extractScriptDeps(content, fileDir, { importRoot });
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
// ESM specifiers additionally honor the `@/` import-root alias so the cache
// key and the dev watcher cover alias-imported helpers.
export const extractScriptDeps = (
  script: string,
  esmBaseDir: string = process.cwd(),
  options: ImportRootOptions = {},
): string[] => {
  const importRoot = options.importRoot ?? getImportRoot();
  const context = `${esmBaseDir}\0${importRoot}\0${process.cwd()}`;
  let contexts = dependencyScanCache.get(script);
  const hit = contexts?.get(context);
  // Callers own the returned array; the memoized one is never exposed.
  if (hit) return [...hit];
  const deps = scanScriptDeps(script, esmBaseDir, importRoot);
  if (!contexts) {
    while (dependencyScanCache.size >= MAX_DEPENDENCY_SCANS) {
      dependencyScanCache.delete(
        dependencyScanCache.keys().next().value as string,
      );
    }
    contexts = new Map();
    dependencyScanCache.set(script, contexts);
  }
  if (contexts.size >= MAX_DEPENDENCY_SCAN_CONTEXTS)
    contexts.delete(contexts.keys().next().value as string);
  contexts.set(context, deps);
  return [...deps];
};

const scanScriptDeps = (
  script: string,
  esmBaseDir: string,
  importRoot: string,
): string[] => {
  const seen = new Set<string>();

  // One tokenization pass serves both extractions (prompt 82).
  const { moduleSpecifiers, callArgumentLiterals } = scanScript(script);
  const moduleRanges = new Set(
    moduleSpecifiers.map(({ start, end }) => `${start}:${end}`),
  );
  for (const { value: specifier } of moduleSpecifiers) {
    // Leading-slash specifiers are rejected by the executor with a located
    // error; dependency extraction just skips them so cache keys and the dev
    // watcher stay well-defined for the rest of the script.
    if (classifySpecifier(specifier) === "root-slash") continue;
    const absPath = resolveSpecifierPath(specifier, esmBaseDir, importRoot);
    if (absPath === undefined) continue;
    seen.add(relative(process.cwd(), absPath).replace(/\\/g, "/"));
  }

  for (const { start, end, value: specifier } of callArgumentLiterals) {
    if (
      !/(?:\.{1,2}\/|[a-zA-Z0-9_$-]+\/)[^\n:]+\.(?:md|mjs|js|jsx|ts|tsx|json|yaml|yml|css|html|txt|csv|svg)$/.test(
        specifier,
      )
    )
      continue;
    if (specifier.includes("://")) continue;
    if (moduleRanges.has(`${start}:${end}`)) continue;
    seen.add(specifier);
  }
  return [...seen];
};

export const resolveBuildScriptImports = (
  source: string,
  baseDir: string,
  options: ImportRootOptions = {},
): string =>
  rewriteModuleSpecifiers(source, baseDir, {
    importRoot: options.importRoot ?? getImportRoot(),
  });

/**
 * Return the names of statically visible `process.env.NAME` reads in `script`
 * that are NOT declared in `scripts.cache.environment`. Only called when the
 * environment declaration is configured, so projects that never declare env
 * inputs get no warning. Never fails a build; the caller warns once per name.
 */
export const detectUndeclaredEnvReads = (script: string): string[] => {
  const declared = new Set(BascikConfig.scripts?.cache?.environment ?? []);
  if (declared.size === 0) return [];
  const seen = new Set<string>();
  for (const match of script.matchAll(PROCESS_ENV_READ_RE)) {
    const name = match[1];
    if (!declared.has(name)) seen.add(name);
  }
  return [...seen];
};

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
  importRoot: string = getImportRoot(),
  variant: string = "",
): Promise<string> => {
  const hash = createHash("sha256");
  hash.update(String(SCRIPT_CACHE_VERSION));
  // A variant keeps records of another kind (output shared across pages) apart
  // from page-specific records. Empty for the page-specific key, which keeps
  // existing cache entries valid.
  if (variant) hash.update(`VARIANT:${variant}`);
  hash.update(script);
  hash.update(relative(process.cwd(), importRoot).replace(/\\/g, "/")); // alias target can change output
  hash.update(isBuild ? "1" : "0");
  hash.update(filePath); // BASCIK_SOURCE_FILE
  hash.update(pageFile); // BASCIK_PAGE_FILE
  hash.update(pagePath); // BASCIK_PAGE_PATH — varies by page
  hash.update(siteUrl); // BASCIK_SITE_URL  — can affect script output
  hash.update(base); // BASCIK_BASE      — can affect script output
  hash.update(routeStr); // BASCIK_ROUTE     — varies per dynamic route

  // Declared environment inputs: fold each variable's name and resolved value
  // into the key so a changed value invalidates cached output. Values are
  // hashed, never persisted. Missing and empty are distinct (a missing key
  // folds a sentinel, an empty string folds its own bytes). Sorted so the key
  // is deterministic across equivalent declaration orders.
  const declaredEnv = BascikConfig.scripts?.cache?.environment;
  if (declaredEnv && declaredEnv.length > 0) {
    hash.update("ENV"); // explicit marker so env-less keys never collide with env keys
    for (const name of [...declaredEnv].sort()) {
      hash.update(name);
      const value = process.env[name];
      hash.update(value === undefined ? "\u0000MISSING" : value);
    }
  }

  const visited = new Set<string>();
  const queue = [...extractScriptDeps(script, baseDir, { importRoot })];
  let readsContextFile = CONTEXT_FILE_ENV_RE.test(script);

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
      if (!readsContextFile && CONTEXT_FILE_ENV_RE.test(content))
        readsContextFile = true;

      // Scan file content for nested dependencies relative to the file's directory
      const fileDir = dirname(absPath);
      const nested = extractScriptDeps(content, fileDir, { importRoot });
      for (const n of nested) {
        if (!visited.has(n)) queue.push(n);
      }
    } catch {
      hash.update(relKey);
      hash.update("MISSING");
    }
  }

  // Context files: a helper that reads BASCIK_SOURCE_FILE or BASCIK_PAGE_FILE
  // (for example to copy the page <title> into og:title) depends on that
  // file's content, not just its path. Fold the content in, and record the
  // file as a dependency so a per-path clear on edit drops the memoized output.
  if (readsContextFile) {
    hash.update("CTX"); // explicit marker so context-free keys never collide with context keys
    for (const contextFile of new Set([filePath, pageFile])) {
      if (!contextFile) continue;
      const absPath = resolve(process.cwd(), contextFile);
      const relKey = relative(process.cwd(), absPath).replace(/\\/g, "/");
      if (visited.has(relKey)) continue;
      visited.add(relKey);
      hash.update(relKey);
      try {
        hash.update(await readCachedFile(absPath, relKey));
      } catch {
        hash.update("MISSING");
      }
    }
  }

  // Resolved package inputs: the same way the child resolves these, folded in
  // deterministically and bounded (prompt 104). This is distinct from the local
  // file deps above, and covers bare/scoped/subpath/user-linked packages.
  const pkgSpecifiers = collectPackageSpecifiers(script);
  if (pkgSpecifiers.length > 0) {
    hash.update("PKG"); // explicit marker so package-less keys never collide with package keys
    const pkgIdentity = await computePackageIdentity(pkgSpecifiers);
    hash.update(pkgIdentity);
  }

  const key = hash.digest("hex");
  // Every dependency folded into this key (present or MISSING) is recorded so
  // that, once the output is memoized, a later per-path clear of that
  // dependency drops this output. Indexing happens in `memoizeOutput`.
  dependenciesByOutputKey.set(key, [...visited]);
  return key;
};

interface CachedScriptOutput {
  output: string;
  /** Whether the recorded run read its page context; undefined for older records. */
  readsPageContext: boolean | undefined;
}

const readScriptCache = async (
  cacheDir: string,
  key: string,
): Promise<CachedScriptOutput | null> => {
  const memCached = inMemoryScriptOutputCache.get(key);
  if (memCached !== undefined)
    return {
      output: memCached,
      readsPageContext: memoizedPageContextReads.get(key),
    };
  try {
    const raw = await readFile(join(cacheDir, `${key}.json`), "utf8");
    const entry = JSON.parse(raw) as {
      v?: number;
      output?: string;
      readsPageContext?: boolean;
    };
    if (
      typeof entry === "object" &&
      entry !== null &&
      entry.v === SCRIPT_CACHE_VERSION &&
      typeof entry.output === "string"
    ) {
      const readsPageContext =
        typeof entry.readsPageContext === "boolean"
          ? entry.readsPageContext
          : undefined;
      memoizeOutput(key, entry.output, readsPageContext);
      return { output: entry.output, readsPageContext };
    }
  } catch {
    /* cache miss */
  }
  return null;
};

const writeScriptCache = async (
  cacheDir: string,
  key: string,
  output: string,
  readsPageContext?: boolean,
): Promise<void> => {
  memoizeOutput(key, output, readsPageContext);
  // Best-effort: don't let a cache write failure abort the build.
  await writeFile(
    join(cacheDir, `${key}.json`),
    JSON.stringify({
      v: SCRIPT_CACHE_VERSION,
      output,
      ...(readsPageContext !== undefined ? { readsPageContext } : {}),
    }),
    "utf8",
  ).catch(() => {});
};

export interface ExecuteBuildScriptOptions {
  pageFile?: string;
  pagePath?: string;
  sourceFile?: string;
  once?: boolean;
  /**
   * Called once for each `data-bascik-build` script in this call whose run
   * read its page context (BASCIK_PAGE_PATH, BASCIK_PAGE_FILE, BASCIK_ROUTE),
   * whether it ran now or its cache record says so. The component manifest
   * (prompt 157) runs a component's build scripts once with an empty page
   * context and refuses the component when one of them read it, since its
   * output would differ per page. Build-once scripts never see a page
   * context and are not reported.
   */
  onReadsPageContext?: () => void;
  /**
   * Where to count this call's cache hits, misses, and child-process time.
   * The caller owns the object; a page passes one through every pass (page,
   * body, head) so the counts on its `transpiled:` line are the page's.
   */
  stats?: BuildScriptStats;
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
  if (BUILD_MODE_CONFLICT_RE.test(html)) {
    throw new Error(
      "[bascik] error: a <script> tag cannot combine data-bascik-build and data-bascik-build-once. Choose one build-script mode.",
    );
  }
  // Build-once scripts run first and without page context, so a build script
  // never sees one and their output is the same wherever the file is used.
  if (!options?.once && BUILD_ONCE_OPEN_TAG_RE.test(html)) {
    html = await executeBuildScripts(html, filePath, null, {
      ...options,
      once: true,
    });
  }

  const matches = [
    ...html.matchAll(options?.once ? BUILD_ONCE_SCRIPT_RE : BUILD_SCRIPT_RE),
  ];
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
  const pageFile = options?.once ? "" : (options?.pageFile ?? filePath ?? "");
  const importRoot = getImportRoot();
  const resolvedSiteUrl = getSiteUrl();
  const siteUrl = resolvedSiteUrl ?? "";
  const routeStr = route ? JSON.stringify(route) : "";
  const pagePath = options?.once
    ? ""
    : (options?.pagePath ??
      (pageFile
        ? computePagePath(
            pageFile,
            BascikConfig.directory?.pages ?? "src/pages",
            route,
          )
        : ""));

  interface ScriptTask {
    fullTag: string;
    index: number;
    openTag: string;
    /** The module text: the script, padded so its lines and columns are the file's own. */
    preparedScript: string;
    cacheKey: string | null;
    /**
     * Key for output shared by every page, when the page context this script
     * runs with varies (a component's script, or a dynamic route's page). Its
     * output is stored under it only after a run that never read page context.
     */
    sharedKey: string | null;
    tmpPath: string;
    sourceFile: string;
    /** The file V8 names the module after (`//# sourceURL`): the HTML file, or the `src=` file. */
    moduleSourcePath: string;
    /** Where the opening tag is, for the error header and the dev overlay. */
    location?: BuildScriptLocation;
    /** The specifier rewrites in `preparedScript`, to put error columns back where they are in the file. */
    specifierEdits: SpecifierEdit[];
    outputScope: OutputScope | null;
    output?: string;
    /** Whether the run (or its cache record) read the page context. */
    readsPageContext?: boolean;
  }

  const tasks: ScriptTask[] = [];

  for (const match of matches) {
    const [fullTag, scriptContent] = match;
    const index = match.index ?? 0;

    const openTag = scriptOpenTag(fullTag, scriptContent);
    // Where the script was written: recorded when its file was read, because
    // `html` may already be transformed (styles extracted, components expanded).
    const position = directiveSourcePosition(html, index, openTag);
    const sourceFile = position.sourceFile ?? defaultSourceFile;
    const locatedFile = sourceFile || filePath;
    const location: BuildScriptLocation | undefined = locatedFile
      ? // The header names the file as the stack does, so both locations open with Cmd+Click.
        {
          sourceFile: getProjectPath(locatedFile),
          line: position.tagLine,
          column: position.tagColumn,
        }
      : undefined;
    const where = location
      ? ` in "${location.sourceFile}" at (line ${location.line}, column ${location.column})`
      : "";
    const useCache = isScriptCacheEnabledForPath(sourceFile || filePath);
    const buildDirective = options?.once
      ? "data-bascik-build-once"
      : "data-bascik-build";
    if (BUILD_SERVER_CONFLICT_RE.test(openTag)) {
      throw new Error(
        `[bascik] error: <script> tag has both ${buildDirective} and data-bascik-server${where}. A script can only run at build time or at request time — not both. Remove one of the attributes.`,
      );
    }

    if (BUILD_ROUTES_CONFLICT_RE.test(openTag)) {
      throw new Error(
        `[bascik] error: <script> tag has both ${buildDirective} and data-bascik-routes${where}. A script cannot be both a build script and a routes script. Remove one of the attributes.`,
      );
    }

    if (BUILD_STREAM_CONFLICT_RE.test(openTag)) {
      throw new Error(
        `[bascik] error: <script> tag has both ${buildDirective} and data-bascik-stream${where}. A script can only run at build time or at request time — not both. Remove one of the attributes.`,
      );
    }

    let scriptBaseDir = sourceFile
      ? dirname(resolve(process.cwd(), sourceFile))
      : filePath
        ? dirname(resolve(process.cwd(), filePath))
        : process.cwd();

    // A leading-slash specifier or src= is a hard error regardless of
    // onBuildScriptError: it is a syntax mistake in the author's HTML, not a
    // runtime failure of their script, so it is never downgraded to a warning.
    const annotateLeadingSlash = (err: unknown): never => {
      if (!(err instanceof LeadingSlashSpecifierError)) throw err;
      const at = location
        ? ` (in "${location.sourceFile}" at line ${location.line}, column ${location.column})`
        : "";
      throw new Error(`[bascik] error: ${err.message}${at}`, { cause: err });
    };

    const htmlRelPath = locatedFile ? getProjectPath(locatedFile) : "unknown";
    let moduleSourcePath = htmlRelPath;
    // The script exactly as written. It is trimmed only for the cache key and checks below;
    // the module keeps it untrimmed so every line and column stays where it is in the file.
    let moduleSource = scriptContent;
    let fromSrcFile = false;
    let trimmedScript = scriptContent.trim();
    if (!trimmedScript) {
      const srcPath = getHtmlAttributeValue(openTag, "src");
      if (srcPath) {
        // `src=` follows the same rules as ESM specifiers: relative and bare
        // paths resolve against the containing file, `@/` against the import
        // root. The script's own imports then re-base to that file.
        let resolvedPath: string;
        try {
          resolvedPath = resolveScriptSrcPath(
            srcPath,
            scriptBaseDir,
            importRoot,
          );
        } catch (err) {
          return annotateLeadingSlash(err);
        }
        scriptBaseDir = dirname(resolvedPath);
        try {
          trimmedScript = await readFile(resolvedPath, "utf8");
          // A `src=` script is its own file, so its errors name that file and its lines.
          moduleSource = trimmedScript;
          moduleSourcePath = getProjectPath(resolvedPath);
          fromSrcFile = true;
        } catch (err) {
          console.warn(
            '[bascik] warning: Failed to read build script src "%s":',
            srcPath,
            err,
          );
        }
      }
    }

    let preparedScript: string;
    let specifierEdits: SpecifierEdit[];
    try {
      // Padded first, so the rewrite's edits are in the file's own lines and columns.
      // Without a known file there are no file lines to line up with.
      const padded =
        fromSrcFile || !locatedFile
          ? moduleSource
          : padToSourcePosition(
              moduleSource,
              position.bodyLine,
              position.bodyColumn,
            );
      ({ code: preparedScript, edits: specifierEdits } =
        rewriteModuleSpecifiersWithEdits(padded, scriptBaseDir, {
          importRoot,
        }));
    } catch (err) {
      return annotateLeadingSlash(err);
    }

    // When `scripts.cache.environment` is configured, warn about statically
    // visible `process.env.NAME` reads that are not declared. This is advisory
    // only: it never fails the build, and it only fires when the declaration
    // is present so existing projects see no new noise (Option A).
    if (BascikConfig.scripts?.cache?.environment?.length) {
      for (const name of detectUndeclaredEnvReads(trimmedScript)) {
        console.warn(
          `[bascik] warning: build script reads process.env.${name} but "${name}" is not declared in scripts.cache.environment; its value is not part of the cache key.`,
        );
      }
    }

    // A script whose effective dependency graph static analysis cannot know
    // (a dynamic import of a non-literal, computed at runtime) is classified
    // NON-cacheable rather than mis-keyed: we re-run it always and never write
    // a cache entry (prompt 104). This is the explicit declared-input contract:
    // env vars and Bascik-provided context are part of the key; remote data /
    // native modules / external side effects are NOT fingerprinted automatically,
    // so an author whose script reads them must disable caching for the page
    // (scripts.cache.exclude) or treat it as non-repeatable.
    const scriptIsNonCacheable = hasDynamicImport(trimmedScript) && useCache;
    const computeKey =
      useCache && !scriptIsNonCacheable
        ? await computeScriptCacheKey(
            trimmedScript,
            scriptBaseDir,
            BascikConfig.isBuild ?? false,
            sourceFile,
            siteUrl,
            BascikConfig.base ?? "/",
            routeStr,
            pageFile,
            pagePath,
            importRoot,
          )
        : null;
    const cacheKey = scriptIsNonCacheable ? null : computeKey;
    const pageContextVaries =
      routeStr !== "" ||
      (sourceFile !== "" &&
        pageFile !== "" &&
        resolve(process.cwd(), sourceFile) !==
          resolve(process.cwd(), pageFile));
    // A file's script run with no page at all (a component's request-time
    // template, prompt 157) prints what a run on any page that never read its
    // page context printed, so that page's shared record answers it too.
    const withoutPage =
      !options?.once &&
      sourceFile !== "" &&
      routeStr === "" &&
      pageFile === "" &&
      pagePath === "";
    const sharedKey =
      cacheKey !== null && (pageContextVaries || withoutPage)
        ? await computeScriptCacheKey(
            trimmedScript,
            scriptBaseDir,
            BascikConfig.isBuild ?? false,
            sourceFile,
            siteUrl,
            BascikConfig.base ?? "/",
            "",
            "",
            "",
            importRoot,
            "shared",
          )
        : null;

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
      sharedKey,
      tmpPath,
      moduleSourcePath,
      location,
      specifierEdits,
      outputScope: decodeOutputScope(
        getHtmlAttributeValue(openTag, OUTPUT_SCOPE_ATTRIBUTE),
      ),
      sourceFile,
    });
  }

  // A page-specific record, or one a run on another page proved page-independent.
  const readCachedOutput = async (
    task: ScriptTask,
  ): Promise<CachedScriptOutput | null> => {
    if (task.cacheKey !== null) {
      const cached = await readScriptCache(cacheDir, task.cacheKey);
      if (cached !== null) return cached;
    }
    if (task.sharedKey !== null) {
      const shared = await readScriptCache(cacheDir, task.sharedKey);
      // A shared record exists only for a run that never read its page.
      if (shared !== null) return { ...shared, readsPageContext: false };
    }
    return null;
  };

  // Check cache for all tasks
  const uncachedTasks: ScriptTask[] = [];
  for (const task of tasks) {
    const cached = await readCachedOutput(task);
    if (cached !== null) {
      task.output = cached.output;
      task.readsPageContext = cached.readsPageContext;
      continue;
    }
    uncachedTasks.push(task);
  }
  // The recursive build-once call above received the same `stats`, so a
  // page's build-once scripts are counted as the page's too.
  const stats = options?.stats;
  if (stats) {
    stats.cached += tasks.length - uncachedTasks.length;
    stats.ran += uncachedTasks.length;
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

    // ─── Isolated per-script execution ───────────────────────────────────────
    // Every uncached script runs in its OWN fresh child process (via runModule),
    // independently of how many of its siblings were cache misses. This is the
    // single, cache-temperature-independent isolation contract (prompt 103):
    // each script gets its own ESM module registry, its own stdout/stderr, and
    // its own environment, so two scripts sharing a stateful helper each see
    // their own module instance and async (detached) output never crosses task
    // boundaries. Variants are run sequentially against the shared bounded
    // child-process semaphore: cache misses never create a shared-process batch
    // whose state could bleed across independently cached tasks.
    //
    // A script that fails is reported according to onBuildScriptError and never
    // re-executed: partial execution may have side effects that are unsafe to
    // duplicate, so there is no blind fallback retry. Siblings keep their own
    // output; a failed script contributes an empty replacement.
    //
    // The loop is timed as a whole: the page's own clock is paused for this
    // await, so this is the only place the child time is seen.
    const childrenStarted = performance.now();
    for (const task of uncachedTasks) {
      const taskSourceUrlComment =
        task.moduleSourcePath !== "unknown"
          ? `\n//# sourceURL=${task.moduleSourcePath}`
          : "";
      const taskEnv = {
        ...extraEnv,
        BASCIK_SOURCE_FILE: task.sourceFile,
      };
      try {
        await writeFile(
          task.tmpPath,
          task.preparedScript + taskSourceUrlComment,
          "utf8",
        );
        const { result, stdout, stderr, readsPageContext } =
          await runDirectiveHandler<string>(task.tmpPath, "build", {
            extraEnv: taskEnv,
          });
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        const output = result;
        if (task.cacheKey !== null)
          await writeScriptCache(
            cacheDir,
            task.cacheKey,
            output,
            readsPageContext,
          );
        // A run that never looked at its page produced what every page gets.
        if (task.sharedKey !== null && !readsPageContext)
          await writeScriptCache(cacheDir, task.sharedKey, output, false);
        task.output = output;
        task.readsPageContext = readsPageContext;
      } catch (err: any) {
        // The script's own output, printed once. Its error report is the message below.
        if (err?.stdout) process.stdout.write(err.stdout);
        if (err?.stderr) process.stderr.write(err.stderr);
        const msg = err instanceof Error ? err.message : String(err);
        const { location } = task;
        let errorMsg = `[bascik] build script error`;
        // The module is padded to the file's own lines, so only the temp path needs renaming,
        // and columns after a rewritten import on the same line need putting back.
        const moduleReferences = [
          task.tmpPath,
          pathToFileURL(task.tmpPath).href,
          task.moduleSourcePath,
        ];
        const remapped = remapRewrittenColumns(
          msg,
          moduleReferences,
          task.specifierEdits,
        );
        const cleanedMsg = cleanStackTrace(
          remapped,
          task.tmpPath,
          task.moduleSourcePath,
          1,
        );
        if (location) {
          errorMsg += ` in "${location.sourceFile}" at (line ${location.line}, column ${location.column})`;
        }
        // Nothing was memoized for this key; drop its pending dependency list
        // so a failing script cannot accumulate index state across edits.
        if (task.cacheKey !== null)
          dependenciesByOutputKey.delete(task.cacheKey);
        const behavior = BascikConfig.scripts?.onBuildScriptError ?? "error";
        if (behavior === "error") {
          console.error(`${errorMsg}:\n${cleanedMsg}`);
          // The location travels as data so the dev overlay can name the file. Without a source
          // file there is nothing to point at, so the failure stays a plain Error.
          if (location)
            throw new BuildScriptError(`${errorMsg}:\n${cleanedMsg}`, location);
          throw new Error(`${errorMsg}:\n${cleanedMsg}`);
        } else {
          console.warn(`${errorMsg}:\n${cleanedMsg}`);
        }
        task.output = "";
      } finally {
        await unlink(task.tmpPath).catch(() => {});
      }
    }
    if (stats) stats.childMs += performance.now() - childrenStarted;
  }

  if (options?.onReadsPageContext && !options.once) {
    for (const task of tasks) {
      if (task.readsPageContext) options.onReadsPageContext();
    }
  }

  // Splice each script's output in at its own match index, from right to left
  // so earlier indices stay valid. Index splicing is inherently safe against
  // `$`-style replacement patterns and against duplicate identical tags.
  tasks.sort((a, b) => b.index - a.index);
  const removedDirectives = new Set<string>();
  for (const { fullTag, index, output, outputScope } of tasks) {
    // Printed output is transpiled again, so a directive script inside it (for
    // example in CMS HTML) would run at build time or become a server script.
    // Only directives written in source files run; printed ones are dropped.
    // security.stripDirectiveScripts off: the output is kept as printed.
    const { html: safeOutput, removed } =
      BascikConfig.security?.stripDirectiveScripts === false
        ? { html: output ?? "", removed: [] as string[] }
        : removeOutputDirectives(output ?? "");
    for (const name of removed) removedDirectives.add(name);
    // A component build script carries its component's scope so its output
    // matches the component's scoped CSS. Applied after
    // caching, so the cache stores the script's own stdout.
    const emitted = outputScope
      ? applyOutputScope(safeOutput, outputScope)
      : safeOutput;
    result =
      result.slice(0, index) + emitted + result.slice(index + fullTag.length);
  }
  if (removedDirectives.size > 0) {
    const where = filePath ? ` in "${getRelativePath(filePath, "pages")}"` : "";
    const tags = [...removedDirectives]
      .map((name) => `<script ${name}>`)
      .join(", ");
    console.warn(
      `[bascik] warning: build script output${where} contained ${tags}. Printed directive scripts never run; they were removed. Write directives in source files, and sanitize HTML from a CMS or an API before printing it.`,
    );
  }

  return result;
};
