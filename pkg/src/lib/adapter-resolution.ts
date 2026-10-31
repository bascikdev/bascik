/**
 * @module adapter-resolution
 *
 * Resolves `--target <name>` to a HostingAdapter instance and variant.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
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

/** A conditional `exports` target resolved with the import conditions, in key order like Node. */
const resolveExportTarget = (
  target: unknown,
  wildcard: string | undefined,
): string | null => {
  if (typeof target === "string") {
    if (!target.startsWith("./")) return null;
    return wildcard === undefined ? target : target.split("*").join(wildcard);
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
const resolveAdapterPackage = (target: string, projectRoot: string): string => {
  let requireError: NodeJS.ErrnoException;
  try {
    return createRequire(join(projectRoot, "package.json")).resolve(target);
  } catch (err) {
    requireError = err as NodeJS.ErrnoException;
  }
  const [name, subpath] = splitPackageSpecifier(target);
  const packageDir = findPackageDir(name, projectRoot);
  if (!packageDir) {
    throw new Error(
      `[bascik] --target: could not resolve adapter package "${target}" from ${projectRoot}.\n` +
        `  Ensure it is installed in package.json dependencies or devDependencies.`,
    );
  }
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

export const resolveAdapterTarget = async (
  target: string,
  projectRoot = process.cwd(),
  options: ResolveAdapterOptions = {},
): Promise<ResolvedAdapterTarget> => {
  const official = Object.prototype.hasOwnProperty.call(
    OFFICIAL_TARGETS,
    target,
  )
    ? OFFICIAL_TARGETS[target]
    : undefined;
  let specifier: string;
  let variant = official?.variant;
  let pkgName: string | undefined;
  let localPath: string | undefined;

  if (official) {
    pkgName = official.package;

    if (options.load === false) {
      return { package: pkgName, variant };
    }

    try {
      const req = createRequire(join(projectRoot, "package.json"));
      specifier = req.resolve(pkgName);
    } catch {
      throw new Error(
        `[bascik] --target ${target}: required package "${pkgName}" is not installed in this project.\n` +
          `  Install it as a dev dependency: npm install --save-dev ${pkgName}`,
      );
    }
  } else if (
    target.startsWith("./") ||
    target.startsWith("../") ||
    isAbsolute(target)
  ) {
    localPath = isAbsolute(target) ? target : join(projectRoot, target);
    specifier = localPath;
    if (options.load === false) {
      return { path: localPath };
    }
  } else {
    pkgName = target;
    if (options.load === false) {
      return { package: pkgName };
    }
    specifier = resolveAdapterPackage(target, projectRoot);
  }

  // Import adapter module
  let importedModule: unknown;
  try {
    const importUrl = pathToFileURL(specifier).href;
    importedModule = await import(importUrl);
  } catch (err) {
    if (
      official &&
      (err as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND"
    ) {
      throw new Error(
        `[bascik] --target ${target}: required package "${pkgName}" is not installed in this project.\n` +
          `  Install it as a dev dependency: npm install --save-dev ${pkgName}`,
      );
    }
    throw err;
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
