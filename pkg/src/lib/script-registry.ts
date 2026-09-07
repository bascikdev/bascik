/**
 * @module script-registry
 *
 * In-Process Script Module Registry
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Provides a unified, in-process runtime for dynamic script modules (such as
 * server scripts and API routes). Modules are loaded via dynamic `import()`,
 * keyed and cached by resolved file path.
 *
 * Behavior:
 * - Production: Modules load once and remain cached for the server's lifetime.
 * - Development: `invalidate()` advances the identity's generation in the
 *   shared module graph (`module-graph.ts`), together with every module that
 *   transitively imports it. The next load imports the entry under a new URL
 *   (`?bascik-gen=N`), which is a new identity for Node's ESM loader, and the
 *   dev resolve hook hands its edited helpers new generation URLs as well. The
 *   framework never claims to evict Node's module cache: previous generations
 *   stay loaded until the process exits, and any request already holding one
 *   keeps using it.
 * - Identity: filesystem paths are realpath'd (so registry keys agree with
 *   the URLs Node's resolver reports to the hook) and canonicalized with
 *   `pathToFileURL`; `file:` URLs are parsed as URLs (an authored query or
 *   fragment is a deliberate distinct identity and is preserved); `data:` URLs
 *   are used as-is.
 * - Concurrency: Handlers receive per-invocation explicit context arguments;
 *   state does not leak across concurrent requests.
 * - Timeout: Configurable per invocation via AbortController/AbortSignal.
 * - Errors: Caught and returned as structured results; real errors are logged
 *   to stderr with cleaned stack traces; network reset errors (client disconnects)
 *   are filtered out.
 *
 * Mode ownership: the exported singleton reads `BascikConfig.isBuild` /
 * `BascikConfig.isProdServer` once at construction. `config.ts` imports only
 * `userConfig`, `environment`, and `cli`, so there is no import cycle, and
 * because the mode is fixed at construction there is no mutable global to
 * reconfigure or race against. Tests construct their own instances.
 */

import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanStackTrace } from "./stack-trace.ts";
import { moduleGraph, createModuleGraph, DEV_GENERATION_PARAM, type ModuleGraph } from "./module-graph.ts";
import { isNetworkResetError } from "./server.ts";
import { nativeClock, type FrameworkClock, type TimeoutHandle } from "./clock.ts";
import { BascikConfig } from "./config.ts";

export interface LoadedScriptModule {
  /**
   * Display path: the absolute filesystem path for file identities, or the
   * raw specifier for `data:` URLs. Used for stack trace remapping and logs.
   */
  filePath: string;
  /**
   * Canonical identity key (URL href without the dev generation marker).
   * Always set by `load()`; optional so test doubles that stub `load` with the
   * pre-112 shape keep compiling.
   */
  key?: string;
  /** The exact URL handed to `import()` for this generation. Always set by `load()`. */
  url?: string;
  module: any;
  /** Generation this entry was loaded under (0 before any invalidation). */
  version: number;
}

export type ScriptRegistryMode = "development" | "production";

export { DEV_GENERATION_PARAM };

/**
 * The canonical identity of a specifier.
 *
 * - `data:` URL: identity is the full string.
 * - `file:` URL: parsed as a URL. Search and hash are part of the identity
 *   because Node treats them as distinct modules; the display path is the
 *   decoded filesystem path.
 * - anything else: a filesystem path resolved against `process.cwd()` and
 *   converted with `pathToFileURL`, which percent-encodes `#`, `%`, spaces,
 *   and non-ASCII correctly.
 *
 * In both file forms the filesystem path is realpath'd when it exists (Node's
 * resolver reports realpaths, and the module graph is keyed by what the
 * resolver reports); a missing file keeps its unresolved path.
 */
export interface ModuleIdentity {
  key: string;
  displayPath: string;
  kind: "data" | "file";
  /** Parsed URL for file identities (undefined for data URLs). */
  url?: URL;
}

export const resolveModuleIdentity = (specifier: string): ModuleIdentity => {
  if (specifier.startsWith("data:")) {
    return { key: specifier, displayPath: specifier, kind: "data" };
  }
  let url: URL;
  if (specifier.startsWith("file:")) {
    url = new URL(specifier);
  } else {
    url = pathToFileURL(resolve(process.cwd(), specifier));
  }
  // Strip only the framework's own generation marker so a re-entered dev URL
  // maps back to the same identity; every authored parameter is preserved.
  if (url.searchParams.has(DEV_GENERATION_PARAM)) {
    url.searchParams.delete(DEV_GENERATION_PARAM);
  }
  let displayPath: string;
  try {
    const pathOnly = new URL(url.href);
    pathOnly.search = "";
    pathOnly.hash = "";
    displayPath = fileURLToPath(pathOnly);
    // Realpath so a symlinked path and the real path are one identity and the
    // key matches what Node's resolver hands the module graph hook.
    let real: string;
    try {
      real = realpathSync(displayPath);
    } catch {
      real = displayPath;
    }
    if (real !== displayPath) {
      const realUrl = pathToFileURL(real);
      realUrl.search = url.search;
      realUrl.hash = url.hash;
      url = realUrl;
      displayPath = real;
    }
  } catch {
    displayPath = url.href;
  }
  return { key: url.href, displayPath, kind: "file", url };
};

export interface ScriptExecutionOptions {
  /** Optional timeout in milliseconds. */
  timeoutMs?: number;
  /** Custom AbortSignal if passed from upstream request. */
  signal?: AbortSignal;
  /** Original source file path for stack trace remapping. */
  originalSourcePath?: string;
  /** Line offset in the original file for stack trace remapping. */
  lineOffset?: number;
  /** Custom handler name inside the module to invoke. Defaults to 'default'. */
  exportName?: string;
}

export interface ScriptExecutionResult<T = unknown> {
  ok: boolean;
  value?: T;
  error?: Error;
  timedOut?: boolean;
  isNetworkReset?: boolean;
}

export interface ScriptRegistryOptions {
  isDev?: boolean;
  clock?: FrameworkClock;
  /**
   * Generation owner shared with the dev resolve hook. Defaults to the
   * process-wide graph; tests pass their own so instances do not interfere.
   */
  graph?: ModuleGraph;
}

/**
 * Decide the registry mode from the resolved configuration. `bascik --build`
 * and `bascik --server` keep stable module identities; everything else is the
 * live dev server. Exported so the singleton's decision is testable.
 */
export const resolveRegistryMode = (
  config: { isBuild?: boolean; isProdServer?: boolean } = BascikConfig,
): ScriptRegistryMode => (config.isBuild || config.isProdServer ? "production" : "development");

export class ScriptRegistry {
  /** Published current-generation entries by identity key. */
  private cache = new Map<string, LoadedScriptModule>();
  /**
   * The single generation owner, shared with the dev resolve hook. Only
   * identities that were loaded, attempted, resolved by the hook, or
   * explicitly invalidated have an entry; a key that was never seen stays at
   * 0 without allocating. Production never writes to it.
   */
  readonly graph: ModuleGraph;
  /** Keys advanced by the most recent `invalidate()` call (for watcher logs). */
  private lastAdvanced: ReadonlySet<string> = new Set();
  private isDev: boolean;
  private clock: FrameworkClock;

  constructor(options: ScriptRegistryOptions = {}) {
    this.isDev = options.isDev ?? false;
    this.clock = options.clock ?? nativeClock;
    // A production registry gets a private, always-empty graph so it can never
    // observe or grow the dev graph even when both exist in one process (tests).
    this.graph = options.graph ?? (this.isDev ? moduleGraph : createModuleGraph());
  }

  get mode(): ScriptRegistryMode {
    return this.isDev ? "development" : "production";
  }

  /** Current generation for a specifier (0 when never invalidated). */
  generationOf(specifier: string): number {
    return this.graph.generationOf(resolveModuleIdentity(specifier).key);
  }

  /** Whether a current-generation entry is published for the specifier. */
  isPublished(specifier: string): boolean {
    return this.cache.has(resolveModuleIdentity(specifier).key);
  }

  /** Identity keys advanced by the most recent `invalidate()` (empty when it returned false). */
  lastInvalidated(): ReadonlySet<string> {
    return this.lastAdvanced;
  }

  /**
   * Resolve and load an ESM module by filesystem path, `file:` URL, or `data:` URL.
   *
   * Production: the first successful load is published and reused forever.
   * Development: the load imports the current generation. If `invalidate()`
   * ran while the import was in flight, the completed entry is returned to
   * its caller (that request finishes on the generation it started with) but
   * is NOT published, so no later request can observe a superseded module.
   */
  async load(specifier: string): Promise<LoadedScriptModule> {
    const identity = resolveModuleIdentity(specifier);
    const { key } = identity;

    const published = this.cache.get(key);
    if (published) return published;

    const generation = this.isDev ? this.graph.generationOf(key) : 0;
    let targetUrl: string;
    if (identity.kind === "data") {
      targetUrl = key;
    } else {
      const url = new URL(identity.url!.href);
      if (this.isDev && generation > 0) {
        url.searchParams.set(DEV_GENERATION_PARAM, String(generation));
      }
      targetUrl = url.href;
    }

    // Record the attempt so a later invalidate() advances this identity even
    // when the import fails: Node caches a module whose evaluation threw, so
    // the fixed file must be imported under a new generation URL.
    if (this.isDev) this.graph.track(key);

    // Failed imports are never published, so a fixed file loads on the next attempt.
    const imported = await import(targetUrl);
    const entry: LoadedScriptModule = {
      filePath: identity.displayPath,
      key,
      url: targetUrl,
      module: imported,
      version: generation,
    };
    // Publish only if this load is still the current generation. A concurrent
    // load for the same generation may already have published an equivalent
    // entry; keeping the first keeps one module instance per generation.
    const current = this.isDev ? this.graph.generationOf(key) : 0;
    if (current === generation && !this.cache.has(key)) {
      this.cache.set(key, entry);
    }
    return entry;
  }

  /**
   * Invalidate a module identity. Development: advance the generation of the
   * identity and of every module that transitively imports it (per the module
   * graph), and unpublish each advanced entry so the next load is a fresh ESM
   * identity. The specifier may name a helper the registry never imported
   * directly: the graph knows which entries import it. In-flight requests keep
   * the entry they already hold. Production: a deliberate no-op, so a loaded
   * module's identity is stable for the process lifetime.
   *
   * Returns true when at least one generation was advanced, false otherwise. A
   * key that neither the registry nor the hook has seen allocates nothing.
   */
  invalidate(specifier: string): boolean {
    if (!this.isDev) return false;
    const { key } = resolveModuleIdentity(specifier);
    const advanced = this.graph.invalidateModule(key);
    if (advanced.size === 0) {
      this.lastAdvanced = advanced;
      return false;
    }
    for (const advancedKey of advanced) this.cache.delete(advancedKey);
    this.lastAdvanced = advanced;
    return true;
  }

  /**
   * Clear all published entries and generation counters (tests). This does not
   * evict anything from Node's ESM cache.
   */
  clear(): void {
    this.cache.clear();
    this.graph.clear();
    this.lastAdvanced = new Set();
  }

  /**
   * Invoke a function from a module in-process with isolated context and timeout support.
   */
  async invoke<T = unknown>(
    specifier: string,
    args: readonly unknown[],
    options: ScriptExecutionOptions = {},
  ): Promise<ScriptExecutionResult<T>> {
    const identity = resolveModuleIdentity(specifier);
    const resolvedPath = identity.displayPath;
    const exportName = options.exportName ?? "default";
    const timeoutMs = options.timeoutMs;

    const controller = new AbortController();
    let upstreamSignalUnsubscribe: (() => void) | undefined;

    if (options.signal) {
      if (options.signal.aborted) {
        controller.abort(options.signal.reason);
      } else {
        const onAbort = () => controller.abort(options.signal!.reason);
        options.signal.addEventListener("abort", onAbort, { once: true });
        upstreamSignalUnsubscribe = () => options.signal!.removeEventListener("abort", onAbort);
      }
    }

    let timer: TimeoutHandle | undefined;
    let didTimeout = false;

    if (timeoutMs && timeoutMs > 0) {
      timer = this.clock.setTimeout(() => {
        didTimeout = true;
        controller.abort(new Error(`Script execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    let settled = false;
    let onAbortListener: (() => void) | undefined;

    const toError = (raw: unknown): Error =>
      raw instanceof Error ? raw : new Error(String(raw));

    try {
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }

      // Race load with abort signal
      const loadPromise = Promise.resolve(this.load(specifier));
      loadPromise.catch(() => {});

      const abortDuringLoadPromise = new Promise<never>((_, reject) => {
        if (controller.signal.aborted) {
          reject(controller.signal.reason);
          return;
        }
        onAbortListener = () => {
          if (!settled) {
            if (didTimeout) {
              reject(new Error(`Script execution timed out after ${timeoutMs}ms`));
            } else {
              reject(controller.signal.reason);
            }
          }
        };
        controller.signal.addEventListener("abort", onAbortListener, { once: true });
      });
      abortDuringLoadPromise.catch(() => {});

      const loaded = (await Promise.race([loadPromise, abortDuringLoadPromise])) as LoadedScriptModule;

      if (onAbortListener) {
        controller.signal.removeEventListener("abort", onAbortListener);
        onAbortListener = undefined;
      }

      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }

      const handler = loaded.module[exportName];

      if (typeof handler !== "function") {
        throw new TypeError(
          `Module "${resolvedPath}" does not export a function named "${exportName}".`,
        );
      }

      let resultPromise: Promise<unknown>;
      try {
        resultPromise = Promise.resolve(
          handler(...args, {
            signal: controller.signal,
          }),
        );
      } catch (syncErr) {
        resultPromise = Promise.reject(syncErr);
      }

      // Observe rejection so late rejection after settlement never triggers unhandled-rejection
      resultPromise.catch(() => {});

      let value: T;
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }

      const abortPromise = new Promise<never>((_, reject) => {
        if (controller.signal.aborted) {
          reject(controller.signal.reason);
          return;
        }
        onAbortListener = () => {
          if (!settled) {
            if (didTimeout) {
              reject(new Error(`Script execution timed out after ${timeoutMs}ms`));
            } else {
              reject(controller.signal.reason);
            }
          }
        };
        controller.signal.addEventListener("abort", onAbortListener, { once: true });
      });
      abortPromise.catch(() => {});

      value = (await Promise.race([resultPromise, abortPromise])) as T;
      settled = true;

      return {
        ok: true,
        value,
      };
    } catch (rawError: unknown) {
      settled = true;
      const err = toError(rawError);
      const isNetReset = isNetworkResetError(rawError);
      // An upstream abort (the response sink aborts with "client disconnected"
      // on a dropped connection) is a client event, not a script fault, so it
      // is not reported as an error. A timeout also aborts the internal
      // controller but never the upstream signal, so it is tracked separately.
      const upstreamAborted = !didTimeout && options.signal?.aborted === true;

      if (!isNetReset && !didTimeout && !upstreamAborted) {
        this.logError(err, resolvedPath, options);
      }

      return {
        ok: false,
        error: err,
        timedOut: didTimeout,
        isNetworkReset: isNetReset,
      };
    } finally {
      settled = true;
      if (timer) {
        this.clock.clearTimeout(timer);
        timer = undefined;
      }
      if (onAbortListener) {
        controller.signal.removeEventListener("abort", onAbortListener);
        onAbortListener = undefined;
      }
      if (upstreamSignalUnsubscribe) {
        upstreamSignalUnsubscribe();
        upstreamSignalUnsubscribe = undefined;
      }
    }
  }

  private logError(
    err: Error,
    resolvedPath: string,
    options: ScriptExecutionOptions,
  ): void {
    const rawTrace = err.stack || err.message;
    // Frames may carry the dev generation query (`?bascik-gen=N`) after the
    // path or file URL; cleanStackTrace strips it while remapping lines.
    const cleanedTrace = cleanStackTrace(
      rawTrace,
      resolvedPath,
      options.originalSourcePath ?? resolvedPath,
      options.lineOffset ?? 1,
    );

    console.error(`[bascik:script-registry] Error executing module "${options.originalSourcePath ?? resolvedPath}":\n${cleanedTrace}`);
  }
}

/**
 * The process-wide runtime registry. Mode is decided once, here, from the
 * frozen configuration: `bascik` (dev) reloads edited modules, `bascik --server`
 * and `bascik --build` keep stable identities.
 */
export const scriptRegistry = new ScriptRegistry({
  isDev: resolveRegistryMode() === "development",
});
