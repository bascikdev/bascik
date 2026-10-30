import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import {
  analyzeComponentSource,
  type ComponentMetadata,
} from "./component-metadata.js";

export interface ProjectSnapshot {
  projectRoot: string;
  componentRoots: string[];
  /** The API routes folder (`directory.api`, default `src/api`), resolved and normalized. */
  apiRoot?: string;
  componentMap: Map<string, string>;
  componentMetadata: Map<string, ComponentMetadata>;
  importRoot: string;
  /** The pages folder (`directory.pages`, default `src/pages`), resolved. Its HTML is in `htmlUsageByFile`. */
  pagesRoot?: string;
  /** The HTML that can use a component outside the component roots: everything under `src` and `pagesRoot`. */
  htmlUsageByFile: Map<string, string>;
  /**
   * The text of every component file, keyed by absolute path, including component roots outside `src`.
   * Find All References reads usages from it and `htmlUsageByFile`.
   */
  componentSourceByFile?: Map<string, string>;
  /**
   * `scoping.attributes.name`: whether the project opts in to scoping `name` per component instance. Off by
   * default, when every `name` ships as written.
   */
  scopesName?: boolean;
}

export const CONFIG_FILE_CANDIDATES = [
  "bascik.config.ts",
  "bascik.config.js",
  "bascik.config.mjs",
];
const DEFAULT_COMPONENT_ROOTS = ["src/components"];
const DEFAULT_IMPORT_ROOT = "src";
const DEFAULT_API_ROOT = "src/api";
const DEFAULT_PAGES_ROOT = "src/pages";

/** Reads `directory.pages` from the config source. The key must be exactly `pages`. */
export function parsePagesRoot(source: string | undefined): string {
  return (
    /(?<![\w$])pages\s*:\s*['"]([^'"]+)['"]/.exec(source ?? "")?.[1] ??
    DEFAULT_PAGES_ROOT
  );
}

/**
 * Reads `scoping.attributes.name` from the config source: true only when the `attributes` object sets
 * `name: true`. Line comments are ignored; a `name` key anywhere else is not the toggle.
 */
export function parseScopesName(source: string | undefined): boolean {
  // Line comments only: a block-comment regex is quadratic on unclosed `/*` runs, and the other config readers
  // here do not strip them either.
  const code = (source ?? "").replace(/(^|[^:"'])\/\/[^\n]*/g, "$1");
  const attributes = /(?<![\w$])attributes\s*:\s*\{([^{}]*)\}/.exec(code);
  if (!attributes) return false;
  return /(?<![\w$-])["']?name["']?\s*:\s*true\b/.test(attributes[1]);
}

/** Is `fsPath` HTML that `htmlUsageByFile` tracks: under `src` or the pages folder? */
export function isUsageSourcePath(
  fsPath: string,
  snapshot: Pick<ProjectSnapshot, "projectRoot" | "pagesRoot">,
): boolean {
  return (
    isPathInside(fsPath, path.join(snapshot.projectRoot, "src")) ||
    (snapshot.pagesRoot !== undefined &&
      isPathInside(fsPath, snapshot.pagesRoot))
  );
}

/** Reads `directory.api` from the config source. `apiTimeout` does not match: the key must be exactly `api`. */
export function parseApiRoot(source: string | undefined): string {
  return (
    /\bapi\s*:\s*['"]([^'"]+)['"]/.exec(source ?? "")?.[1] ?? DEFAULT_API_ROOT
  );
}

export function normalizeComponentName(name: string): string {
  return (
    name
      .replace(/\\/g, "/")
      .split("/")
      .pop()
      ?.replace(/\.html$/i, "")
      .toLowerCase() ?? ""
  );
}

export function parseComponentRoots(source: string | undefined): string[] {
  if (!source) return DEFAULT_COMPONENT_ROOTS;
  const match = /\bcomponents\s*:\s*(\[[^\]]*\]|['"][^'"]+['"])/.exec(source);
  if (!match?.[1]) return DEFAULT_COMPONENT_ROOTS;
  const literals = Array.from(
    match[1].matchAll(/['"]([^'"]+)['"]/g),
    (item) => item[1],
  );
  return literals.length > 0 ? literals : DEFAULT_COMPONENT_ROOTS;
}

export function parseImportRoot(source: string | undefined): string {
  return (
    /importRoot\s*:\s*['"]([^'"]+)['"]/.exec(source ?? "")?.[1] ??
    DEFAULT_IMPORT_ROOT
  );
}

export async function readConfigSource(
  workspaceRoot: string,
): Promise<string | undefined> {
  for (const candidate of CONFIG_FILE_CANDIDATES) {
    const configPath = path.join(workspaceRoot, candidate);
    try {
      return await fsPromises.readFile(configPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
  }
  return undefined;
}

/** Drops trailing "/" in linear time; the regex `/\/+$/` is quadratic on long slash runs. */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

export function resolveComponentRoots(
  workspaceRoot: string,
  configuredRoots: string[],
): string[] {
  return configuredRoots.map((root) =>
    trimTrailingSlashes(path.resolve(workspaceRoot, root).replace(/\\/g, "/")),
  );
}

export function isInsideComponentRoots(
  fsPath: string,
  roots: string[],
): boolean {
  const normalized = fsPath.replace(/\\/g, "/");
  return roots.some(
    (root) => normalized === root || normalized.startsWith(`${root}/`),
  );
}

export async function findHtmlFiles(roots: string[]): Promise<string[]> {
  const files: string[] = [];
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: fs.Dirent[];
    try {
      entries = await fsPromises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".html")) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

export async function buildSnapshot(
  workspaceRoot: string,
): Promise<ProjectSnapshot> {
  const configSource = await readConfigSource(workspaceRoot);
  const componentRoots = resolveComponentRoots(
    workspaceRoot,
    parseComponentRoots(configSource),
  );
  const componentFiles = await findHtmlFiles(componentRoots);
  const componentMap = new Map<string, string>();
  for (const filePath of componentFiles) {
    const name = normalizeComponentName(filePath);
    if (name) componentMap.set(name, filePath);
  }
  const componentMetadata = new Map<string, ComponentMetadata>();
  const componentSourceByFile = new Map<string, string>();
  await Promise.all(
    componentFiles.map(async (filePath) => {
      try {
        componentSourceByFile.set(
          filePath,
          await fsPromises.readFile(filePath, "utf8"),
        );
      } catch {
        // Ignored if file changed or unreadable
      }
    }),
  );
  await Promise.all(
    Array.from(componentMap, async ([name, filePath]) => {
      try {
        const source =
          componentSourceByFile.get(filePath) ??
          (await fsPromises.readFile(filePath, "utf8"));
        componentMetadata.set(
          name,
          analyzeComponentSource(source, {
            hasCompanionStyles: fs.existsSync(
              filePath.replace(/\.html$/i, ".css"),
            ),
          }),
        );
      } catch {
        // Ignored if file changed or unreadable
      }
    }),
  );

  const htmlUsageByFile = new Map<string, string>();
  const srcRoot = path.join(workspaceRoot, "src");
  const pagesRoot = path.resolve(workspaceRoot, parsePagesRoot(configSource));
  const usageFiles = await findHtmlFiles(
    isPathInside(pagesRoot, srcRoot) ? [srcRoot] : [srcRoot, pagesRoot],
  );
  await Promise.all(
    usageFiles.map(async (filePath) => {
      try {
        htmlUsageByFile.set(
          filePath,
          await fsPromises.readFile(filePath, "utf8"),
        );
      } catch {
        // Ignored
      }
    }),
  );

  return {
    projectRoot: path.resolve(workspaceRoot),
    componentRoots,
    apiRoot: trimTrailingSlashes(
      path
        .resolve(workspaceRoot, parseApiRoot(configSource))
        .replace(/\\/g, "/"),
    ),
    componentMap,
    componentMetadata,
    importRoot: path.resolve(workspaceRoot, parseImportRoot(configSource)),
    pagesRoot,
    htmlUsageByFile,
    componentSourceByFile,
    scopesName: parseScopesName(configSource),
  };
}

export function isPathInside(fsPath: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(fsPath));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/** Is `fsPath` a Bascik config file (`bascik.config.ts`, `.js`, or `.mjs`)? */
export function isConfigFile(fsPath: string): boolean {
  return CONFIG_FILE_CANDIDATES.includes(path.basename(fsPath));
}

/**
 * Paths that never hold a project: installed packages, build output, and git internals. Judged relative to the
 * workspace folder, so a workspace that itself lives under a folder named `dist` still works.
 */
export function isExcludedProjectPath(
  fsPath: string,
  workspaceRoot: string,
): boolean {
  const relativeParts = path
    .relative(path.resolve(workspaceRoot), path.resolve(fsPath))
    .split(path.sep);
  return relativeParts.some(
    (part) => part === "node_modules" || part === "dist" || part === ".git",
  );
}

export function htmlSuppliesComponentProp(
  html: string,
  componentName: string,
  propName: string,
): boolean {
  const escapedComponentName = componentName.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const escapedPropName = propName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const usageRegex = new RegExp(
    `<${escapedComponentName}(?![\\w-])(?:[^>"']|"[^"]*"|'[^']*')*>`,
    "gi",
  );
  const propRegex = new RegExp(
    `\\sdata-bascik-prop-${escapedPropName}\\s*=`,
    "i",
  );
  return Array.from(html.matchAll(usageRegex)).some((match) =>
    propRegex.test(match[0]),
  );
}
