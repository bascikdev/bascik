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
 * - Development: Modules are invalidated on file change using cache-busting URLs.
 * - Concurrency: Handlers receive per-invocation explicit context arguments;
 *   state does not leak across concurrent requests.
 * - Timeout: Configurable per invocation via AbortController/AbortSignal.
 * - Errors: Caught and returned as structured results; real errors are logged
 *   to stderr with cleaned stack traces; network reset errors (client disconnects)
 *   are filtered out.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cleanStackTrace } from "./stack-trace.ts";
import { isNetworkResetError } from "./server.ts";
import { nativeClock, type FrameworkClock, type TimeoutHandle } from "./clock.ts";

export type ScriptInvocationContext = Record<string, unknown>;

export interface LoadedScriptModule {
  filePath: string;
  module: any;
  version: number;
}

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
}

export class ScriptRegistry {
  private cache = new Map<string, LoadedScriptModule>();
  private versionMap = new Map<string, number>();
  private isDev: boolean;
  private clock: FrameworkClock;

  constructor(options: ScriptRegistryOptions = {}) {
    this.isDev = options.isDev ?? false;
    this.clock = options.clock ?? nativeClock;
  }

  /**
   * Resolve and load an ESM module by its file path or specifier URL.
   * Caches by resolved absolute path or URL. In dev mode, applies cache-busting.
   */
  async load(specifier: string): Promise<LoadedScriptModule> {
    const isUrl = specifier.startsWith("data:") || specifier.startsWith("file:");
    const resolvedPath = isUrl ? specifier : resolve(process.cwd(), specifier);

    if (!this.isDev && this.cache.has(resolvedPath)) {
      return this.cache.get(resolvedPath)!;
    }

    const currentVersion = (this.versionMap.get(resolvedPath) ?? 0);
    let targetUrl: string;

    if (specifier.startsWith("data:")) {
      targetUrl = specifier;
    } else {
      const fileUrl = pathToFileURL(resolvedPath);
      if (this.isDev && currentVersion > 0) {
        fileUrl.searchParams.set("v", String(currentVersion));
      }
      targetUrl = fileUrl.href;
    }

    try {
      const imported = await import(targetUrl);
      const entry: LoadedScriptModule = {
        filePath: resolvedPath,
        module: imported,
        version: currentVersion,
      };
      this.cache.set(resolvedPath, entry);
      return entry;
    } catch (err) {
      // Do not store failed imports in cache so subsequent retries can succeed after fixes
      throw err;
    }
  }

  /**
   * Invalidate a module by specifier or file path.
   * Increments the version counter for cache-busting in development mode.
   */
  invalidate(specifier: string): void {
    const isUrl = specifier.startsWith("data:") || specifier.startsWith("file:");
    const resolvedPath = isUrl ? specifier : resolve(process.cwd(), specifier);
    this.cache.delete(resolvedPath);
    const nextVersion = (this.versionMap.get(resolvedPath) ?? 0) + 1;
    this.versionMap.set(resolvedPath, nextVersion);
  }

  /**
   * Clear all cached modules and versions.
   */
  clear(): void {
    this.cache.clear();
    this.versionMap.clear();
  }

  /**
   * Invoke a function from a module in-process with isolated context and timeout support.
   */
  async invoke<T = unknown>(
    specifier: string,
    context: ScriptInvocationContext,
    options: ScriptExecutionOptions = {},
  ): Promise<ScriptExecutionResult<T>> {
    const isUrl = specifier.startsWith("data:") || specifier.startsWith("file:");
    const resolvedPath = isUrl ? specifier : resolve(process.cwd(), specifier);
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

    try {
      const loaded = await this.load(resolvedPath);
      const handler = loaded.module[exportName];

      if (typeof handler !== "function") {
        throw new TypeError(
          `Module "${resolvedPath}" does not export a function named "${exportName}".`,
        );
      }

      // Execute handler passing isolated context and controller options
      const resultPromise = Promise.resolve(
        handler(context, {
          signal: controller.signal,
        }),
      );

      // Race with timeout if applicable
      let value: T;
      if (timeoutMs && timeoutMs > 0) {
        value = await Promise.race([
          resultPromise,
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener("abort", () => {
              if (didTimeout) {
                reject(new Error(`Script execution timed out after ${timeoutMs}ms`));
              } else {
                reject(controller.signal.reason);
              }
            }, { once: true });
          }),
        ]);
      } else {
        value = await resultPromise;
      }

      return {
        ok: true,
        value,
      };
    } catch (rawError: unknown) {
      const err = rawError instanceof Error ? rawError : new Error(String(rawError));
      const isNetReset = isNetworkResetError(rawError);

      if (!isNetReset && !didTimeout) {
        this.logError(err, resolvedPath, options);
      }

      return {
        ok: false,
        error: err,
        timedOut: didTimeout,
        isNetworkReset: isNetReset,
      };
    } finally {
      if (timer) {
        this.clock.clearTimeout(timer);
      }
      if (upstreamSignalUnsubscribe) {
        upstreamSignalUnsubscribe();
      }
    }
  }

  private logError(
    err: Error,
    resolvedPath: string,
    options: ScriptExecutionOptions,
  ): void {
    const rawTrace = err.stack || err.message;
    const cleanedTrace = cleanStackTrace(
      rawTrace,
      resolvedPath,
      options.originalSourcePath ?? resolvedPath,
      options.lineOffset ?? 1,
    );

    console.error(`[bascik:script-registry] Error executing module "${options.originalSourcePath ?? resolvedPath}":\n${cleanedTrace}`);
  }
}

export const scriptRegistry = new ScriptRegistry();
