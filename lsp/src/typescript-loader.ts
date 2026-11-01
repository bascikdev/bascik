/**
 * Finds the TypeScript that checks `type="text/typescript"` script blocks.
 *
 * TypeScript is never a dependency of the language server and never bundled with it: it is an optional peer. The
 * first of these that works is used:
 *
 *   1. a path the client passes (the VS Code extension passes the `bascik.typescript.path` setting);
 *   2. the editor's own TypeScript, when the client passes one (the VS Code extension passes VS Code's), so a
 *      mistyped or broken setting falls back to it rather than turning the checks off;
 *   3. the project's `typescript`, resolved from the project root, then from this package (where a strict
 *      layout such as pnpm's links an installed peer);
 *   4. none: TypeScript checks are off.
 *
 * Why a client path could not be used is kept apart (`clientPathProblem`), so the editor can show it where the
 * user set it.
 *
 * A copy without `createLanguageService` (TypeScript 7, the native port, publishes no JavaScript language
 * service) is skipped like a missing one, with a note, and so is a copy older than TypeScript 5 or missing any
 * library file the checks load.
 */
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import type * as TS from "typescript-6";

export type TypeScriptModule = typeof TS;

/** Where a TypeScript copy was found. */
export type TypeScriptSource = "client" | "editor" | "project";

export interface LoadedTypeScript {
  ok: true;
  ts: TypeScriptModule;
  version: string;
  source: TypeScriptSource;
  /** The package folder. */
  packageDir: string;
  /** Copies that were found and skipped, with the reason, for a log line. */
  skipped: string[];
  /** Why the client's path was not used, when it gave one that could not be. */
  clientPathProblem?: string;
}

export interface MissingTypeScript {
  ok: false;
  /** One line for a log or `bascik --check`: why there is no TypeScript, and what to do. */
  message: string;
  skipped: string[];
  /** Why the client's path was not used, when it gave one that could not be. */
  clientPathProblem?: string;
}

export type TypeScriptResolution = LoadedTypeScript | MissingTypeScript;

export interface TypeScriptLookup {
  /** A `typescript` package folder (or a path inside one, such as its `lib`) the client asked for. */
  clientPath?: string;
  /** The editor's own `typescript` package folder, tried after `clientPath` (VS Code's bundled copy). */
  editorPath?: string;
  /** The project root; its `node_modules` is searched next. */
  projectRoot: string;
  /**
   * A file or URL to resolve `typescript` from after the project: this package's own location, where a strict
   * layout such as pnpm's links an installed peer. Left out, only the project is searched (the VS Code bundle has
   * no packages beside it).
   */
  fallbackFrom?: string;
}

/**
 * The library files Bascik's programs always load: the language (ES5 and ES2022, the lowest target), the browser's
 * for client blocks, and the web worker's for server-side blocks without `@types/node`. A copy missing any of them
 * would report every use of those globals as an error, so it is not used. Libraries a project's `tsconfig.json`
 * adds are checked when its project is made (`missingLibraryFiles` in `typescript-service.ts`).
 */
export const REQUIRED_LIB_FILES = [
  "lib.es5.d.ts",
  "lib.es2022.d.ts",
  "lib.dom.d.ts",
  "lib.dom.iterable.d.ts",
  "lib.webworker.d.ts",
  "lib.webworker.iterable.d.ts",
];

/**
 * The oldest TypeScript the checks run with, the floor of the peer range (`>=5.0 <7`). TypeScript 4 has no
 * `moduleResolution: "bundler"` and no `allowImportingTsExtensions`, so every `@/lib/x.ts` import would be a
 * false error.
 */
const MINIMUM_MAJOR_VERSION = 5;

const loaded = new Map<string, TypeScriptModule>();

/**
 * The package folder of a client-given path: the folder itself, or the nearest folder above it with a
 * `package.json` named `typescript` (VS Code's `typescript.tsdk` setting names the `lib` folder).
 */
function packageDirOf(candidate: string): string | undefined {
  let current = path.resolve(candidate);
  for (let depth = 0; depth < 3; depth++) {
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(current, "package.json"), "utf8"),
      ) as { name?: unknown };
      if (manifest.name === "typescript") return current;
    } catch {
      // Not a package folder; try the parent.
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

/**
 * The file `require("typescript")` loads from the package: its `exports` entry for `.` (TypeScript 7 has only
 * that), else `main`. The folder may not be named `typescript` (an alias install), so it is not required by name.
 */
function packageEntry(packageDir: string): string {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageDir, "package.json"), "utf8"),
  ) as { main?: unknown; exports?: unknown };
  let entry: unknown =
    typeof manifest.exports === "object" && manifest.exports !== null
      ? (manifest.exports as Record<string, unknown>)["."]
      : manifest.exports;
  if (typeof entry === "object" && entry !== null) {
    const conditions = entry as Record<string, unknown>;
    entry = conditions.require ?? conditions.node ?? conditions.default;
  }
  if (typeof entry !== "string")
    entry = typeof manifest.main === "string" ? manifest.main : "index.js";
  return path.join(packageDir, entry as string);
}

/** Loads the package in `packageDir`, or explains why it cannot be used. */
function tryLoad(
  packageDir: string,
  source: TypeScriptSource,
  skipped: string[],
): LoadedTypeScript | undefined {
  let ts: Partial<TypeScriptModule>;
  try {
    ts =
      loaded.get(packageDir) ??
      (createRequire(path.join(packageDir, "package.json"))(
        packageEntry(packageDir),
      ) as TypeScriptModule);
  } catch (error) {
    skipped.push(
      `${packageDir} could not be loaded (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`,
    );
    return undefined;
  }
  const version = typeof ts.version === "string" ? ts.version : "unknown";
  if (typeof ts.createLanguageService !== "function") {
    skipped.push(
      `TypeScript ${version} in ${packageDir} has no language service (TypeScript 7 and later do not publish one); TypeScript 5 or 6 is needed`,
    );
    return undefined;
  }
  const major = Number(/^(\d+)\./.exec(version)?.[1]);
  if (major < MINIMUM_MAJOR_VERSION) {
    skipped.push(
      `TypeScript ${version} in ${packageDir} is older than ${MINIMUM_MAJOR_VERSION}.0; TypeScript 5 or 6 is needed`,
    );
    return undefined;
  }
  const libDir = path.dirname(ts.getDefaultLibFilePath!({}));
  const missing = REQUIRED_LIB_FILES.filter(
    (name) => !fs.existsSync(path.join(libDir, name)),
  );
  if (missing.length > 0) {
    skipped.push(
      `TypeScript ${version} in ${packageDir} is missing library files in ${libDir}: ${missing.join(", ")}`,
    );
    return undefined;
  }
  loaded.set(packageDir, ts as TypeScriptModule);
  return {
    ok: true,
    ts: ts as TypeScriptModule,
    version,
    source,
    packageDir,
    skipped,
  };
}

function realPath(fsPath: string): string {
  try {
    return fs.realpathSync(fsPath);
  } catch {
    return fsPath;
  }
}

/** The `typescript` package folder resolvable from `from`, or `undefined`. */
function resolvePackageDir(from: string): string | undefined {
  try {
    return path.dirname(createRequire(from).resolve("typescript/package.json"));
  } catch {
    return undefined;
  }
}

/** Finds a usable TypeScript, in the order described at the top of this file. */
export function resolveTypeScript(
  lookup: TypeScriptLookup,
): TypeScriptResolution {
  const skipped: string[] = [];
  const tried = new Set<string>();
  let clientPathProblem: string | undefined;
  const withProblem = <T extends TypeScriptResolution>(result: T): T =>
    clientPathProblem === undefined ? result : { ...result, clientPathProblem };
  const given: [string | undefined, TypeScriptSource, string][] = [
    [lookup.clientPath, "client", "the TypeScript path the editor gave"],
    [lookup.editorPath, "editor", "the editor's own TypeScript"],
  ];
  for (const [candidate, source, label] of given) {
    if (!candidate) continue;
    const before = skipped.length;
    const packageDir = packageDirOf(candidate);
    if (packageDir === undefined) {
      skipped.push(
        `${label} (${candidate}) is not a typescript package folder`,
      );
    } else if (!tried.has(realPath(packageDir))) {
      tried.add(realPath(packageDir));
      const result = tryLoad(packageDir, source, skipped);
      if (result) return withProblem(result);
    }
    if (source === "client" && skipped.length > before)
      clientPathProblem = skipped.slice(before).join("; ");
  }
  const projectRoot = path.resolve(lookup.projectRoot);
  for (const from of [
    path.join(projectRoot, "package.json"),
    ...(lookup.fallbackFrom === undefined ? [] : [lookup.fallbackFrom]),
  ]) {
    const packageDir = resolvePackageDir(from);
    if (packageDir === undefined || tried.has(realPath(packageDir))) continue;
    tried.add(realPath(packageDir));
    const result = tryLoad(packageDir, "project", skipped);
    if (result) return withProblem(result);
  }
  const reasons = skipped.length > 0 ? ` (${skipped.join("; ")})` : "";
  return withProblem({
    ok: false,
    message: `TypeScript checks of type="text/typescript" scripts are off: no usable typescript was found from ${projectRoot}${reasons}. Install TypeScript 5 or 6 with: npm install --save-dev typescript@6`,
    skipped,
  });
}
