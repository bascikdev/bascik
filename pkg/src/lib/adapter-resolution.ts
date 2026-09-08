/**
 * @module adapter-resolution
 *
 * Resolves `--target <name>` to a HostingAdapter instance and variant.
 */

import { createRequire } from "node:module";
import { join, isAbsolute } from "node:path";
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

const OFFICIAL_TARGETS: Record<string, { package: string; variant?: string }> = {
  "cloudflare-pages": {
    package: "@bascik/adapter-cloudflare",
    variant: "pages",
  },
  "cloudflare-workers": {
    package: "@bascik/adapter-cloudflare",
    variant: "workers",
  },
};

export const resolveAdapterTarget = async (
  target: string,
  projectRoot = process.cwd(),
  options: ResolveAdapterOptions = {},
): Promise<ResolvedAdapterTarget> => {
  const official = Object.prototype.hasOwnProperty.call(OFFICIAL_TARGETS, target)
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
  } else if (target.startsWith("./") || target.startsWith("../") || isAbsolute(target)) {
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
    try {
      const req = createRequire(join(projectRoot, "package.json"));
      specifier = req.resolve(target);
    } catch {
      throw new Error(
        `[bascik] --target: could not resolve adapter package "${target}" from ${projectRoot}.\n` +
        `  Ensure it is installed in package.json dependencies or devDependencies.`,
      );
    }
  }

  // Import adapter module
  let importedModule: unknown;
  try {
    const importUrl = pathToFileURL(specifier).href;
    importedModule = await import(importUrl);
  } catch (err) {
    if (official && (err as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
      throw new Error(
        `[bascik] --target ${target}: required package "${pkgName}" is not installed in this project.\n` +
        `  Install it as a dev dependency: npm install --save-dev ${pkgName}`,
      );
    }
    throw err;
  }

  const rawAdapter =
    importedModule && typeof importedModule === "object" && "default" in importedModule
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
