/**
 * @module package-identity
 *
 * Resolved-package identity for build-script cache keys (prompt 104).
 *
 * A `<script data-bascik-build>` executes as ESM and may import bare packages
 * (`marked`), scoped packages (`@scope/pkg`), subpath exports (`pkg/sub`), and
 * user-linked packages (workspace / `file:` deps). Pre-104 the output cache key
 * hashed the script text plus Bascik-rewritten local file deps, but never the
 * resolved package graph, so upgrading or editing a package replayed stale
 * output from a previous fresh build.
 *
 * This module mirrors Node ESM resolution the same way the executing child
 * resolves it, then folds in content identity for each resolved package node.
 *
 * Resolution mechanism: `import.meta.resolve(spec, parent)` ignores the explicit
 * parent when the caller is a different module (verified on Node 24: the base is
 * always the calling module's own directory). To reproduce the child's exact
 * resolution we write a tiny resolver stub into the same directory the child
 * executes from (`<cwd>/node_modules/.cache/bascik/`) and call its
 * `import.meta.resolve`. The stub resolves against the project's hoisted
 * `node_modules` and honors `import` export conditions, subpath exports, and any
 * user-registered loader hooks, exactly like the executed child.
 *
 * Identity composition (folded deterministically into the script cache key):
 *   - builtin (`node:fs`, `fs`): runtime name only. Hashing Node's own install
 *     tree would bake machine/registry state into every cache key.
 *   - installed (realpath under `<cwd>/node_modules`): content hash of the
 *     resolved entry file + the package manifest (covers version/metadata and
 *     npm-bundled or override content changes), plus a bounded recursive hash of
 *     the packages this package imports.
 *   - userlinked (realpath outside `<cwd>/node_modules`, e.g. workspace / file:
 *     / PnP): same entry + manifest, plus a bounded transitive graph walk of its
 *     own package imports, because its content can change in place without a
 *     version bump.
 *
 * Ordering is stable: roots are visited in sorted specifier order; each node's
 * imports are re-collected and visited in their own sorted order. Cycle
 * detection uses the (kind, realpath) tuple so a diamond or a package importing
 * itself is visited once. A depth budget (`MAX_PACKAGE_GRAPH_DEPTH`) caps the
 * walk so an unbounded dependency traversal is impossible.
 */

import { createHash } from "node:crypto";
import { isBuiltin } from "node:module";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { classifySpecifier, scanScript, hasDynamicImportExpression } from "./module-specifiers.ts";

/** Bump together with SCRIPT_CACHE_VERSION whenever identity composition changes. */
export const PACKAGE_IDENTITY_VERSION = 1;

/** Depth budget for the package graph walk. Guards against unbounded traversal. */
export const MAX_PACKAGE_GRAPH_DEPTH = 32;

export type PackageKind = "builtin" | "installed" | "userlinked";

export interface ResolvedPackage {
  /** The bare specifier as authored (e.g. `marked`, `audit-lib/sub`). */
  specifier: string;
  kind: PackageKind;
  /** realpath'd resolved entry file, or the specifier name for builtins. */
  resolvedPath: string;
}

/**
 * True when Bascik resolves this specifier as a package or builtin to track as
 * package identity. Relative, import-root (`@/`), and leading-slash specifiers
 * are Bascik-owned and already tracked as local file deps; `node:`/builtin
 * specifiers are handled via `isBuiltin`; remote `https:`/`data:` URLs are not
 * local repeatable packages, so they are skipped.
 */
export const isExternalPackageSpecifier = (value: string): boolean => {
  const cls = classifySpecifier(value);
  if (cls !== "external") return false;
  if (isBuiltin(value)) return false;
  if (value.includes("://")) return false;
  return true;
};

/**
 * Distinct external package specifiers (bare, scoped, subpath) a script uses,
 * derived from the same single-pass tokenization as `extractScriptDeps`, in a
 * stable sorted order.
 */
export const collectPackageSpecifiers = (script: string): string[] => {
  const { moduleSpecifiers } = scanScript(script);
  const seen = new Set<string>();
  for (const { value } of moduleSpecifiers) {
    if (isExternalPackageSpecifier(value)) seen.add(value);
  }
  return [...seen].sort();
};

/**
 * Non-cacheable classification: true when the script's dependency graph cannot
 * be statically known. `import(` of a non-literal (identifier, template, or
 * expression) resolves a package the analysis cannot see, so the script re-runs
 * on every build and never writes a cache entry rather than being mis-keyed.
 * Static `import('pkg')` of a fixed string is Bascik-rewritten to an absolute
 * URL and is fully cacheable.
 */
export const hasDynamicImport = (script: string): boolean =>
  hasDynamicImportExpression(script);

// ─── Resolution ──────────────────────────────────────────────────────────────

const cwd = (): string => process.cwd();

/** Realpath'd `<cwd>/node_modules/<sep>` so classification matches resolved paths. */
const nodeModulesPrefix = async (): Promise<string> => {
  const p = join(cwd(), "node_modules");
  try {
    return `${await realpath(p)}${sep}`;
  } catch {
    return `${p}${sep}`;
  }
};

const RESOLVER_FILE = "bascik-package-resolver.mjs";
const RESOLVER_SOURCE =
  "export const resolveFor = (spec) => import.meta.resolve(spec, import.meta.url);\n";

let resolverModule: Promise<{ resolveFor: (spec: string) => string } | null> | null = null;

/**
 * Ensure the resolver stub exists under the project temp dir and return its
 * module instance. Writing into the same directory the child executes from
 * makes `import.meta.resolve` inside the stub reproduce the child's exact
 * resolution. The stub content is constant, so concurrent writes (worker mode)
 * are idempotent. Returns `null` when the stub cannot be prepared (read-only or
 * mocked fs), in which case callers degrade to stable MISSING identity.
 */
const resolverModuleRef = async (): Promise<{ resolveFor: (spec: string) => string } | null> => {
  if (resolverModule) return resolverModule;
  const dir = join(cwd(), "node_modules", ".cache", "bascik");
  const file = join(dir, RESOLVER_FILE);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, RESOLVER_SOURCE, "utf8");
  } catch {
    // Resolver stub cannot be prepared (e.g. a read-only or mocked fs in unit
    // tests). Degrade to MISSING identity for every external specifier: the key
    // stays stable and never replays stale content, and real builds (with a real
    // fs) get full resolution. This is not a cache-disable workaround.
    resolverModule = Promise.resolve(null);
    return null;
  }
  const href = pathToFileURL(file).href;
  try {
    resolverModule = import(href) as Promise<{ resolveFor: (spec: string) => string }>;
    // Verify the stub actually loads (the fs may be mocked such that writeFile
    // succeeded but no real file exists). If import fails, degrade to MISSING.
    await resolverModule;
  } catch {
    resolverModule = Promise.resolve(null);
    return null;
  }
  return resolverModule;
};

/** Convert a `file://` URL into its absolute filesystem path (no realpath). */
const fileURLToPathname = (url: string): string => decodeURIComponent(new URL(url).pathname);

/**
 * Classify a realpath'd resolved entry file.
 * - installed: inside `<cwd>/node_modules` (a real directory ESM reached
 *   through the hoisted tree, or a nested `node_modules` under a package).
 * - userlinked: any realpath outside `<cwd>/node_modules` (workspace, `file:`,
 *   PnP virtual, or a `node_modules` symlink escaping into a source tree).
 */
export const classifyKind = async (realPath: string): Promise<PackageKind> => {
  const prefix = await nodeModulesPrefix();
  if (realPath.startsWith(prefix)) return "installed";
  return "userlinked";
};

const realpathOf = async (path: string): Promise<string> => {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
};

/**
 * Resolve every external package specifier the way the executed child will,
 * ordered by a stable specifier sort. A specifier that cannot resolve now is
 * recorded with a stable MISSING marker so its identity is explicit; because an
 * unresolved package never produces a successful cached output, this cannot
 * silently replay stale content.
 */
export const resolvePackages = async (specifiers: string[]): Promise<ResolvedPackage[]> => {
  const resolved: ResolvedPackage[] = [];
  const plain = [...new Set(specifiers)].sort();
  const builtins = plain.filter((s) => isBuiltin(s));
  const externals = plain.filter((s) => !isBuiltin(s));

  for (const spec of builtins) {
    resolved.push({ specifier: spec, kind: "builtin", resolvedPath: spec });
  }
  if (externals.length === 0) return resolved;

  const ref = await resolverModuleRef();
  if (!ref) {
    // Resolver unavailable: stable MISSING identity for every external. See
    // resolverModuleRef for why this is safe.
    for (const spec of externals) {
      resolved.push({
        specifier: spec,
        kind: "userlinked",
        resolvedPath: `MISSING:${spec.replace(/[/\\:]/g, "_")}`,
      });
    }
    return resolved;
  }
  const resolveFor = ref.resolveFor;

  for (const spec of externals) {
    let resolvedUrl: string;
    try {
      resolvedUrl = resolveFor(spec);
    } catch {
      resolved.push({
        specifier: spec,
        kind: "userlinked",
        resolvedPath: `MISSING:${spec.replace(/[/\\:]/g, "_")}`,
      });
      continue;
    }
    const pathname = fileURLToPathname(resolvedUrl);
    const realPath = await realpathOf(pathname);
    const kind = await classifyKind(realPath);
    resolved.push({ specifier: spec, kind, resolvedPath: realPath });
  }
  return resolved;
};

// ─── Identity hashing ─────────────────────────────────────────────────────────

/** Read a UTF-8 file, or null on any error, for identity hashing. Unreadable
 *  files hash as MISSING, never skipped. */
const readMaybe = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
};

const hashUpdate = (hash: ReturnType<typeof createHash>, value: string): void => {
  hash.update(value);
  hash.update("\u0000");
};

/**
 * Hash the resolved package graph into a deterministic identity string.
 *
 * Roots are resolved and visited in stable sorted order. Each node hashes its
 * specifier, kind, and realpath, then the resolved entry file content and the
 * package manifest. Builtins contribute only their runtime name. Every package
 * (installed or userlinked) then contributes a recursive hash of the packages it
 * itself imports, resolved from the project tree, bounded by the depth budget
 * and cycle-detected on the (kind, realpath) tuple.
 */
export const computePackageIdentity = async (specifiers: string[]): Promise<string> => {
  const hash = createHash("sha256");
  hashUpdate(hash, `pkgid:${PACKAGE_IDENTITY_VERSION}`);
  const visited = new Set<string>();

  const visit = async (pkg: ResolvedPackage, depth: number): Promise<void> => {
    if (depth > MAX_PACKAGE_GRAPH_DEPTH) {
      hashUpdate(hash, `<truncated:${pkg.specifier}>`);
      return;
    }
    const dedupe = `${pkg.kind}\u0000${pkg.resolvedPath}`;
    if (visited.has(dedupe)) return;
    visited.add(dedupe);

    hashUpdate(hash, "PKG");
    hashUpdate(hash, pkg.specifier);
    hashUpdate(hash, pkg.kind);
    hashUpdate(hash, pkg.resolvedPath);

    if (pkg.kind === "builtin") return;

    // Entry content and manifest. package.json version/metadata changes matter,
    // and npm-bundled/local-override content changes at a fixed version matter.
    const entry = await readMaybe(pkg.resolvedPath);
    hashUpdate(hash, entry === null ? "MISSING" : entry);
    const manifest = await readMaybe(join(dirname(pkg.resolvedPath), "package.json"));
    hashUpdate(hash, manifest === null ? "nomanifest" : manifest);

    // Recurse into the packages this one imports so a change in a transitive
    // dependency (reached through a subpath export or a linked workspace
    // package) invalidates this key. Only the actually-imported graph is walked
    // (bounded depth + visited set), so unrelated installed packages are never
    // hashed. Local relative files a package's entry imports are covered by the
    // entry content hash in the common hoisted layout.
    for (const spec of collectPackageSpecifiers(entry ?? "")) {
      const children = await resolvePackages([spec]);
      for (const child of children) await visit(child, depth + 1);
    }
  };

  const roots = await resolvePackages(specifiers);
  for (const root of roots) await visit(root, 0);
  return hash.digest("hex");
};

/** Reset resolver caching between tests/fixtures (avoids cross-cwd staleness). */
export const resetPackageIdentity = (): void => {
  resolverModule = null;
};