/**
 * @module adapter-resolution
 *
 * Resolves `--target <name>` to a HostingAdapter instance and variant.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import * as nodePath from "node:path";
import { dirname, join, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { HostingAdapter } from "./adapter-contract.ts";

export interface ResolvedAdapterTarget {
  adapter?: HostingAdapter;
  variant?: string;
  package?: string;
  path?: string;
}

export interface ResolveAdapterOptions {
  /** Whether to actually load the adapter module (default: true). */
  load?: boolean;
}

const OFFICIAL_TARGETS: Record<string, { package: string; variant?: string }> =
  {
    cloudflare: {
      package: "@bascik/adapter-cloudflare",
      variant: "workers",
    },
    "cloudflare-pages": {
      package: "@bascik/adapter-cloudflare",
      variant: "pages",
    },
    "cloudflare-workers": {
      package: "@bascik/adapter-cloudflare",
      variant: "workers",
    },
    netlify: {
      package: "@bascik/adapter-netlify",
    },
  };

/** The conditions Node's ESM loader matches for `import()` (plus "default"). */
const IMPORT_CONDITIONS = new Set(["node", "import", "module-sync", "default"]);

/** `@scope/name/sub` → `["@scope/name", "./sub"]`; `name` → `["name", "."]`. */
const splitPackageSpecifier = (target: string): [string, string] => {
  const parts = target.split("/");
  const nameLength = target.startsWith("@") ? 2 : 1;
  const name = parts.slice(0, nameLength).join("/");
  const rest = parts.slice(nameLength).join("/");
  return [name, rest ? `./${rest}` : "."];
};

/** The installed package folder, found the way Node does: `node_modules` in each folder up from the project. */
const findPackageDir = (name: string, projectRoot: string): string | null => {
  let dir = resolve(projectRoot);
  while (true) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json")))
      return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

/**
 * A `.`, `..` or `node_modules` path segment, also percent-encoded, which
 * Node rejects in an `exports` target (after its `./`) and in the part a
 * `*` matches (ERR_INVALID_PACKAGE_TARGET, ERR_INVALID_MODULE_SPECIFIER),
 * so a target can never leave the package folder.
 */
const INVALID_EXPORTS_SEGMENT =
  /(^|\\|\/)((\.|%2e)(\.|%2e)?|(n|%6e|%4e)(o|%6f|%4f)(d|%64|%44)(e|%65|%45)(_|%5f)(m|%6d|%4d)(o|%6f|%4f)(d|%64|%44)(u|%75|%55)(l|%6c|%4c)(e|%65|%45)(s|%73|%53))(\\|\/|$)/i;

/** A conditional `exports` target resolved with the import conditions, in key order like Node. */
const resolveExportTarget = (
  target: unknown,
  wildcard: string | undefined,
): string | null => {
  if (typeof target === "string") {
    if (!target.startsWith("./")) return null;
    if (INVALID_EXPORTS_SEGMENT.test(target.slice(2))) return null;
    if (wildcard === undefined) return target;
    if (INVALID_EXPORTS_SEGMENT.test(wildcard)) return null;
    return target.split("*").join(wildcard);
  }
  if (Array.isArray(target)) {
    for (const entry of target) {
      const resolved = resolveExportTarget(entry, wildcard);
      if (resolved) return resolved;
    }
    return null;
  }
  if (target && typeof target === "object") {
    for (const [condition, value] of Object.entries(target)) {
      if (!IMPORT_CONDITIONS.has(condition)) continue;
      const resolved = resolveExportTarget(value, wildcard);
      if (resolved) return resolved;
    }
  }
  return null;
};

/** The file `import()` loads for `subpath` of a package's `exports` (exact keys, then one-`*` patterns, longest prefix first). */
const resolveExportsEntry = (
  exportsField: unknown,
  subpath: string,
): string | null => {
  const isSubpathMap =
    exportsField !== null &&
    typeof exportsField === "object" &&
    !Array.isArray(exportsField) &&
    Object.keys(exportsField).some((key) => key.startsWith("."));
  const map: Record<string, unknown> = isSubpathMap
    ? (exportsField as Record<string, unknown>)
    : { ".": exportsField };
  if (Object.prototype.hasOwnProperty.call(map, subpath))
    return resolveExportTarget(map[subpath], undefined);
  const patterns = Object.keys(map)
    .filter((key) => key.split("*").length === 2)
    .sort((a, b) => b.indexOf("*") - a.indexOf("*"));
  for (const key of patterns) {
    const [prefix, suffix] = key.split("*");
    if (
      subpath.length >= prefix.length + suffix.length &&
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix)
    ) {
      const wildcard = subpath.slice(
        prefix.length,
        subpath.length - suffix.length,
      );
      return resolveExportTarget(map[key], wildcard);
    }
  }
  return null;
};

/**
 * Resolve a package adapter for `import()`. `require.resolve` applies the
 * CommonJS conditions, so a package whose `exports` offer only `import` (an
 * ESM-only package) fails there although it is installed; such a package
 * is resolved again from its folder with the import conditions, and a
 * failure says the package is installed rather than asking to install it.
 */
const resolveAdapterPackage = (
  target: string,
  projectRoot: string,
  notInstalled: () => Error = () =>
    new Error(
      `[bascik] --target: could not resolve adapter package "${target}" from ${projectRoot}.\n` +
        `  Ensure it is installed in package.json dependencies or devDependencies.`,
    ),
): string => {
  let requireError: NodeJS.ErrnoException;
  try {
    return createRequire(join(projectRoot, "package.json")).resolve(target);
  } catch (err) {
    requireError = err as NodeJS.ErrnoException;
  }
  const [name, subpath] = splitPackageSpecifier(target);
  const packageDir = findPackageDir(name, projectRoot);
  if (!packageDir) throw notInstalled();
  let manifest: { exports?: unknown };
  try {
    manifest = JSON.parse(
      readFileSync(join(packageDir, "package.json"), "utf8"),
    ) as { exports?: unknown };
  } catch (err) {
    throw new Error(
      `[bascik] --target: adapter package "${target}" is installed at ${packageDir}, but its package.json could not be read: ${(err as Error).message}`,
    );
  }
  const entry =
    manifest.exports === undefined
      ? null
      : resolveExportsEntry(manifest.exports, subpath);
  if (entry) {
    const file = join(packageDir, entry);
    if (existsSync(file)) return file;
  }
  throw new Error(
    `[bascik] --target: adapter package "${target}" is installed at ${packageDir}, but it has no entry Bascik can import` +
      (manifest.exports === undefined
        ? "."
        : `: its package.json "exports" offers no "${subpath}" file under the node, import or default conditions.`) +
      `\n  Node reported: ${requireError.code ? `${requireError.code}: ` : ""}${requireError.message.split("\n")[0]}`,
  );
};

/**
 * True when `--target` names a local adapter file rather than an official
 * target or a package: an absolute path, or one starting with `./` or
 * `../`. On Windows `.\` and `..\` count too, the form PowerShell and cmd
 * complete a relative file to; on posix a backslash is a filename
 * character, so there they stay a (failing) package name.
 */
export const isLocalAdapterPath = (
  target: string,
  path: Pick<typeof nodePath, "isAbsolute" | "sep"> = nodePath,
): boolean =>
  target.startsWith("./") ||
  target.startsWith("../") ||
  (path.sep === "\\" &&
    (target.startsWith(".\\") || target.startsWith("..\\"))) ||
  path.isAbsolute(target);

/** Damerau-Levenshtein distance with adjacent transpositions (optimal string alignment). */
const editDistance = (a: string, b: string): number => {
  const rows = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0,
    ),
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
    }
  return rows[a.length][b.length];
};

/**
 * The official target a mistyped `--target` most likely meant (`cloudfare`
 * → `cloudflare`, `Netlify` → `netlify`), or `undefined` when the name is
 * an official target already, a path, a scoped package, or not close to any.
 */
export const suggestOfficialTarget = (target: string): string | undefined => {
  if (
    !target ||
    Object.prototype.hasOwnProperty.call(OFFICIAL_TARGETS, target) ||
    isLocalAdapterPath(target) ||
    target.includes("/")
  )
    return undefined;
  const lower = target.toLowerCase();
  let best: { name: string; distance: number } | undefined;
  for (const name of Object.keys(OFFICIAL_TARGETS)) {
    const distance = editDistance(lower, name);
    if (distance <= 2 && (!best || distance < best.distance))
      best = { name, distance };
  }
  return best?.name;
};

interface ResolvedSpecifier {
  official?: { package: string; variant?: string };
  pkgName?: string;
  localPath?: string;
  specifier: string;
}

/**
 * Turn `--target` into the file `import()` will load, without loading it.
 * Throws the user-facing error for a missing local file, an uninstalled
 * package (with the nearest official target when the name is a typo) and an
 * installed package with no importable entry.
 */
const resolveAdapterSpecifier = (
  target: string,
  projectRoot: string,
): ResolvedSpecifier => {
  const official = Object.prototype.hasOwnProperty.call(
    OFFICIAL_TARGETS,
    target,
  )
    ? OFFICIAL_TARGETS[target]
    : undefined;
  if (official) {
    const officialPackage = official.package;
    return {
      official,
      pkgName: officialPackage,
      specifier: resolveAdapterPackage(
        officialPackage,
        projectRoot,
        () =>
          new Error(
            `[bascik] --target ${target}: required package "${officialPackage}" is not installed in this project.\n` +
              `  Install it as a dev dependency: npm install --save-dev ${officialPackage}`,
          ),
      ),
    };
  }
  if (isLocalAdapterPath(target)) {
    const localPath = isAbsolute(target) ? target : join(projectRoot, target);
    if (!existsSync(localPath))
      throw new Error(
        `[bascik] --target ${target}: adapter file not found at ${localPath}`,
      );
    return { localPath, specifier: localPath };
  }
  const suggestion = suggestOfficialTarget(target);
  return {
    pkgName: target,
    specifier: resolveAdapterPackage(
      target,
      projectRoot,
      () =>
        new Error(
          `[bascik] --target: could not resolve adapter package "${target}" from ${projectRoot}.\n` +
            (suggestion ? `  Did you mean --target ${suggestion}?\n` : "") +
            `  Ensure it is installed in package.json dependencies or devDependencies.`,
        ),
    ),
  };
};

/**
 * Check that `--target` names an adapter that can be loaded, without
 * importing it, so the CLI can reject a typo or a missing file before it
 * transpiles the site. Throws the same message `resolveAdapterTarget` would.
 */
export const checkAdapterTarget = (
  target: string,
  projectRoot = process.cwd(),
): void => {
  resolveAdapterSpecifier(target, projectRoot);
};

export const resolveAdapterTarget = async (
  target: string,
  projectRoot = process.cwd(),
  options: ResolveAdapterOptions = {},
): Promise<ResolvedAdapterTarget> => {
  if (options.load === false) {
    const official = Object.prototype.hasOwnProperty.call(
      OFFICIAL_TARGETS,
      target,
    )
      ? OFFICIAL_TARGETS[target]
      : undefined;
    if (official)
      return { package: official.package, variant: official.variant };
    if (isLocalAdapterPath(target))
      return {
        path: isAbsolute(target) ? target : join(projectRoot, target),
      };
    return { package: target };
  }

  const { official, pkgName, localPath, specifier } = resolveAdapterSpecifier(
    target,
    projectRoot,
  );
  const variant = official?.variant;

  // Import adapter module
  let importedModule: unknown;
  try {
    const importUrl = pathToFileURL(specifier).href;
    importedModule = await import(importUrl);
  } catch (err) {
    const firstLine = (err as Error).message
      .split("\n")[0]
      .replace(/ imported from \S+$/, "");
    // The package resolved above, so it is installed: a missing module here
    // is one it imports (a pruned dependency, a broken install), and its
    // name is the one the author needs.
    if (
      official &&
      (err as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND"
    ) {
      throw new Error(
        `[bascik] --target ${target}: "${pkgName}" is installed but failed to load: ${firstLine}\n` +
          `  Reinstall the project's dependencies (npm install) so the adapter's own dependencies are present.`,
        { cause: err },
      );
    }
    // Node names the importer (this module, inside the compiler) in a
    // missing-module message; the adapter's own error is what matters.
    throw new Error(
      `[bascik] --target ${target}: the adapter failed to load: ${firstLine}`,
      { cause: err },
    );
  }

  const rawAdapter =
    importedModule &&
    typeof importedModule === "object" &&
    "default" in importedModule
      ? (importedModule as Record<string, unknown>).default
      : importedModule;

  if (
    !rawAdapter ||
    typeof rawAdapter !== "object" ||
    typeof (rawAdapter as { name?: unknown }).name !== "string" ||
    !(rawAdapter as { name: string }).name.trim() ||
    typeof (rawAdapter as { build?: unknown }).build !== "function"
  ) {
    throw new Error(
      `[bascik] --target ${target}: HostingAdapter contract violation: default export must be an object with non-empty string property 'name' and function 'build'.`,
    );
  }

  const adapter = rawAdapter as unknown as HostingAdapter;

  return {
    adapter,
    variant,
    package: pkgName,
    path: localPath,
  };
};
