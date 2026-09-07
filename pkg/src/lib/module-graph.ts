/**
 * @module module-graph
 *
 * Development-only module dependency graph and resolve hook
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Problem: `ScriptRegistry` gives an entry module (an API route or a `src=`
 * server script) a fresh ESM identity per invalidation by importing it under
 * `?bascik-gen=N`. Node evaluates the new entry URL as a new module, but the
 * `import "./helper.ts"` specifier inside it is unchanged text: Node resolves
 * it to the same `file:` URL already in its module map and reuses the old
 * helper instance. A generation on the entry cannot reach its dependencies
 * because the registry does not own resolution below the entry.
 *
 * Solution: a synchronous, in-thread `node:module` `registerHooks({ resolve })`
 * hook that
 *
 *   1. records `child -> Set<parent>` edges for every resolved `file:` URL
 *      whose realpath is under a tracked root (the project root or the
 *      configured import root) and not under `node_modules`, and
 *   2. rewrites a resolved child URL to carry `?bascik-gen=<gen>` when that
 *      child's generation is above 0. First loads keep clean URLs.
 *
 * `invalidateModule(key)` advances the key's generation and, transitively,
 * every recorded parent's generation (cycle guarded). The registry unpublishes
 * every returned key, so the next request re-imports the entry under a new
 * generation and Node, resolving `./helper.ts` from it, receives the helper's
 * new generation URL too: a new helper instance evaluated from the edited
 * file.
 *
 * Keys are generation-stripped realpath `file:` hrefs. Node's resolver returns
 * realpaths (`/private/tmp/...` on macOS), so a watcher path must be passed
 * through `moduleKeyForPath` before it can match what the hook recorded.
 *
 * Boundaries (documented in `docs/content/internals/server.md`):
 * - Dev only. `installModuleGraphHook` is a no-op outside development and is
 *   idempotent within a process; production and build install nothing.
 * - Only project files outside `node_modules` are tracked. Bare packages,
 *   `node:` builtins, `data:` URLs, and files outside every tracked root pass
 *   through untouched and are never recorded.
 * - Nothing is evicted from Node's module map. Old generations stay alive
 *   (with their module-level state) until the process exits.
 * - A key never seen by the hook allocates nothing: a watcher event for an
 *   unrelated file does not grow the graph.
 */

import { registerHooks, type ModuleHooks, type ResolveHookSync } from "node:module";
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Query parameter appended in development so each generation is a new ESM identity. */
export const DEV_GENERATION_PARAM = "bascik-gen";

/**
 * Remove only the framework's generation marker from a URL string. Authored
 * search params and fragments are preserved because Node treats them as part
 * of the module identity. Non-URL strings are returned as-is.
 */
export const stripGeneration = (href: string): string => {
  if (!href.includes(`${DEV_GENERATION_PARAM}=`)) return href;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  if (!url.searchParams.has(DEV_GENERATION_PARAM)) return href;
  url.searchParams.delete(DEV_GENERATION_PARAM);
  return url.href;
};

/** realpath that falls back to the input when the path does not exist. */
const safeRealpath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * Memoized realpath for module identity, keyed by the absolute path as
 * spelled. Identity resolution runs on every registry `load()` and `invoke()`,
 * so without the memo a production server would pay a filesystem round trip
 * per request per script. A production identity never changes for the process
 * lifetime. In development, `ScriptRegistry.invalidate()` calls
 * `forgetModulePaths` for the invalidated key and every dependent it advanced,
 * so a path that later appears, disappears, or is re-pointed through a symlink
 * is re-resolved.
 */
const realpathMemo = new Map<string, string>();

const memoizedRealpath = (absPath: string): string => {
  const cached = realpathMemo.get(absPath);
  if (cached !== undefined) return cached;
  const real = safeRealpath(absPath);
  realpathMemo.set(absPath, real);
  return real;
};

/**
 * Drop memoized realpaths for the given paths: every entry whose spelled path
 * or resolved realpath matches one of them (as spelled or as realpath'd now).
 * Paths are resolved against cwd. Called on invalidation only, so the fresh
 * realpath per target is not on a request path.
 */
export const forgetModulePaths = (paths: Iterable<string>): void => {
  const targets = new Set<string>();
  for (const path of paths) {
    const abs = resolve(process.cwd(), path);
    targets.add(abs);
    targets.add(safeRealpath(abs));
  }
  for (const [spelled, real] of realpathMemo) {
    if (targets.has(spelled) || targets.has(real)) realpathMemo.delete(spelled);
  }
};

/** Test-only observation of the realpath memo. */
export const _moduleKeyTestHooks = {
  clearRealpathMemo(): void {
    realpathMemo.clear();
  },
  get realpathMemoSize(): number {
    return realpathMemo.size;
  },
  hasRealpathMemo(path: string): boolean {
    return realpathMemo.has(resolve(process.cwd(), path));
  },
};

/**
 * The single owner of the module key rule: the `file:` href of a path's
 * realpath (or of the resolved path when the file does not exist yet). The
 * registry's `resolveModuleIdentity` builds file identities on top of this
 * (adding only an authored query or fragment), and a watcher path must pass
 * through it before it can match what the hook recorded, because Node's
 * resolver reports realpaths.
 */
export const moduleKeyForPath = (path: string): string =>
  pathToFileURL(memoizedRealpath(resolve(process.cwd(), path))).href;

export interface ModuleGraph {
  /** Current generation for a key (0 when never invalidated or never seen). */
  generationOf(key: string): number;
  /** Whether the graph has any state for this key. */
  has(key: string): boolean;
  /** Number of tracked keys. */
  readonly size: number;
  /** Recorded parents (importers) of a child key. Empty set when none. */
  parentsOf(key: string): ReadonlySet<string>;
  /** Mark a key as seen at its current generation without adding an edge. */
  track(key: string): void;
  /** Record that `parent` imports `child` (both generation-stripped keys). */
  recordEdge(child: string, parent: string): void;
  /**
   * Advance the key's generation and, transitively, every recorded parent's.
   * Returns the set of advanced keys. A key the graph has never seen returns
   * an empty set and allocates nothing.
   */
  invalidateModule(key: string): ReadonlySet<string>;
  /** Drop all generations and edges (tests). Does not touch Node's module map. */
  clear(): void;
}

const EMPTY: ReadonlySet<string> = new Set();

export const createModuleGraph = (): ModuleGraph => {
  const generations = new Map<string, number>();
  const parents = new Map<string, Set<string>>();

  return {
    generationOf: (key) => generations.get(key) ?? 0,
    has: (key) => generations.has(key),
    get size() {
      return generations.size;
    },
    parentsOf: (key) => parents.get(key) ?? EMPTY,
    track(key) {
      if (!generations.has(key)) generations.set(key, 0);
    },
    recordEdge(child, parent) {
      if (!generations.has(child)) generations.set(child, 0);
      if (!generations.has(parent)) generations.set(parent, 0);
      let set = parents.get(child);
      if (!set) {
        set = new Set();
        parents.set(child, set);
      }
      set.add(parent);
    },
    invalidateModule(key) {
      if (!generations.has(key)) return EMPTY;
      const advanced = new Set<string>();
      const stack = [key];
      while (stack.length) {
        const current = stack.pop()!;
        if (advanced.has(current)) continue;
        advanced.add(current);
        generations.set(current, (generations.get(current) ?? 0) + 1);
        const importers = parents.get(current);
        if (importers) {
          for (const importer of importers) {
            if (!advanced.has(importer)) stack.push(importer);
          }
        }
      }
      return advanced;
    },
    clear() {
      generations.clear();
      parents.clear();
    },
  };
};

/** The process-wide graph shared by the resolve hook and `ScriptRegistry`. */
export const moduleGraph: ModuleGraph = createModuleGraph();

export interface ResolveHookOptions {
  /**
   * Absolute directories whose files are tracked. Files under any `node_modules`
   * segment are excluded even when inside a root. Roots are realpath'd.
   */
  roots: readonly string[];
}

export type ResolveHook = ResolveHookSync;
export type ResolveHookContext = Parameters<ResolveHookSync>[1];
export type ResolveHookNext = Parameters<ResolveHookSync>[2];

const NODE_MODULES_SEGMENT = `${sep}node_modules${sep}`;

const isUnder = (path: string, root: string): boolean => path === root || path.startsWith(root + sep);

/**
 * Build the resolve hook for a graph. Exported separately from installation so
 * the URL rules can be unit tested without touching Node's loader.
 */
export const createResolveHook = (graph: ModuleGraph, options: ResolveHookOptions): ResolveHook => {
  const roots = options.roots.map((root) => safeRealpath(resolve(root)));

  /** Generation-stripped key for a tracked `file:` URL, or undefined when out of scope. */
  const trackedKey = (href: string): string | undefined => {
    if (!href.startsWith("file:")) return undefined;
    const key = stripGeneration(href);
    let path: string;
    try {
      const pathOnly = new URL(key);
      pathOnly.search = "";
      pathOnly.hash = "";
      path = fileURLToPath(pathOnly);
    } catch {
      return undefined;
    }
    if (path.includes(NODE_MODULES_SEGMENT)) return undefined;
    if (!roots.some((root) => isUnder(path, root))) return undefined;
    return key;
  };

  return (specifier, context, next) => {
    const resolved = next(specifier, context);
    const childKey = trackedKey(resolved.url);
    if (childKey === undefined) return resolved;

    const parentKey = context.parentURL ? trackedKey(context.parentURL) : undefined;
    if (parentKey !== undefined) {
      graph.recordEdge(childKey, parentKey);
    } else {
      graph.track(childKey);
    }

    // The registry imports an entry under the exact generation it decided on;
    // a URL that already carries the marker is left alone so an in-flight
    // request finishes on the generation it started with (prompt 111).
    if (resolved.url !== childKey) return resolved;

    const generation = graph.generationOf(childKey);
    if (generation === 0) return resolved;
    const url = new URL(resolved.url);
    url.searchParams.set(DEV_GENERATION_PARAM, String(generation));
    return { ...resolved, url: url.href };
  };
};

export interface InstallModuleGraphHookOptions {
  /** Absolute project root; files under it (outside `node_modules`) are tracked. */
  projectRoot: string;
  /** Extra roots to track, such as `scripts.importRoot` when it lies outside the project. */
  extraRoots?: readonly string[];
  /** Only development installs anything. */
  isDev: boolean;
}

export interface ModuleGraphHookHandle {
  /** True when this call (or an earlier idempotent one) registered the hook. */
  readonly installed: boolean;
  /** Remove the hook. Safe to call repeatedly and on an inert handle. */
  deregister(): void;
}

let activeHandle: ModuleGraphHookHandle | undefined;

const INERT_HANDLE: ModuleGraphHookHandle = Object.freeze({ installed: false, deregister: () => {} });

/** Whether the dev resolve hook is currently registered in this process. */
export const isModuleGraphHookInstalled = (): boolean => activeHandle !== undefined;

/**
 * Install the dev-only resolve hook exactly once per process. Returns an inert
 * handle outside development and the existing handle when already installed.
 */
export const installModuleGraphHook = (options: InstallModuleGraphHookOptions): ModuleGraphHookHandle => {
  if (!options.isDev) return INERT_HANDLE;
  if (activeHandle) return activeHandle;

  const hook = createResolveHook(moduleGraph, {
    roots: [options.projectRoot, ...(options.extraRoots ?? [])],
  });
  const hooks: ModuleHooks = registerHooks({ resolve: hook });
  const handle: ModuleGraphHookHandle = {
    installed: true,
    deregister() {
      if (activeHandle !== handle) return;
      activeHandle = undefined;
      hooks.deregister();
    },
  };
  activeHandle = handle;
  return handle;
};
