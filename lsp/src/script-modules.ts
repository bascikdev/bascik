/**
 * The project's .ts and .js files that run in Node, so the markup rules and
 * hand-written-html-escaper apply to them as they do to inline directive
 * scripts.
 *
 * A file runs in Node when it is:
 *   - the `src=` file of a directive script (`data-bascik-build`,
 *     `data-bascik-build-once`, `data-bascik-routes`, `data-bascik-server`,
 *     `data-bascik-stream`) in a page or component;
 *   - a module that a directive script, an API route, or another such module
 *     imports with a `./`, `../` or `@/` specifier (followed transitively);
 *   - an API route itself.
 *
 * Browser code is left out: a component's plain `<script src>` companion,
 * and anything only it imports, is scoped for the browser, where these rules
 * do not apply. Bare specifiers (packages) are not followed.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { findModuleSpecifiers } from "./module-specifiers.js";
import type { ProjectSnapshot } from "./project.js";

/** A directive attribute in a script's open tag (`data-bascik-build`, `data-bascik-build-once`, `data-bascik-routes`, `data-bascik-server`, `data-bascik-stream`). */
const DIRECTIVE_RE =
  /(?:^|[\s"'])data-bascik-(?:build-once|build|routes|server|stream)(?=[\s=/>]|$)/i;
const SCRIPT_EXTENSIONS = [".ts", ".mts", ".js", ".mjs"];
const API_ROUTE_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs"]);
/** A bound on the files followed, so a huge or cyclic graph cannot stall the editor. */
const MAX_MODULES = 5_000;

const SCRIPT_RE =
  /<script(?=[\t\n\f\r />])((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script(?:[\t\n\f\r /][^>]*)?>/gi;

/** Forward slashes, so Windows and POSIX paths compare the same. */
export const normalizeModulePath = (fsPath: string): string =>
  path.resolve(fsPath).replace(/\\/g, "/");

const isTestFile = (file: string): boolean =>
  /\.(test|spec)\.[a-z0-9]+$/i.test(file) || /\.d\.[cm]?ts$/i.test(file);

/** The file a specifier names, trying TypeScript for `.js` and adding an extension or `/index`. */
function resolveFile(target: string): string | undefined {
  const candidates = [target];
  const ext = path.extname(target).toLowerCase();
  if (ext === ".js") candidates.push(target.slice(0, -3) + ".ts");
  else if (ext === ".mjs") candidates.push(target.slice(0, -4) + ".mts");
  else if (!SCRIPT_EXTENSIONS.includes(ext))
    for (const e of SCRIPT_EXTENSIONS)
      candidates.push(target + e, path.join(target, `index${e}`));
  for (const candidate of candidates) {
    if (!SCRIPT_EXTENSIONS.includes(path.extname(candidate).toLowerCase()))
      continue;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not there; try the next spelling.
    }
  }
  return undefined;
}

function resolveSpecifier(
  value: string,
  fromDir: string,
  importRoot: string,
): string | undefined {
  if (value.startsWith("./") || value.startsWith("../"))
    return resolveFile(path.resolve(fromDir, value));
  if (value.startsWith("@/"))
    return resolveFile(path.resolve(importRoot, value.slice(2)));
  return undefined;
}

export interface ScriptModuleSources {
  projectRoot: string;
  importRoot: string;
  /** HTML files (pages and components) and their text. */
  html: Iterable<[fsPath: string, text: string]>;
  /** API route files. */
  apiRoutes?: Iterable<string>;
  /** Text of a module that is open in the editor, used in place of the disk. */
  readText?: (fsPath: string) => string | undefined;
}

/** Every file that runs in Node (normalized paths), from the given pages, components and API routes. */
export function findScriptModules(sources: ScriptModuleSources): Set<string> {
  const { projectRoot, importRoot } = sources;
  const found = new Set<string>();
  const queue: string[] = [];
  const inProject = (file: string): boolean => {
    const rel = path.relative(projectRoot, file);
    return (
      rel !== "" &&
      !rel.startsWith("..") &&
      !path.isAbsolute(rel) &&
      !rel.split(/[\\/]/).includes("node_modules")
    );
  };
  const add = (file: string | undefined): void => {
    if (!file || !inProject(file) || isTestFile(file)) return;
    const key = normalizeModulePath(file);
    if (found.has(key) || found.size >= MAX_MODULES) return;
    found.add(key);
    queue.push(file);
  };
  const addImports = (text: string, fromDir: string): void => {
    for (const { value } of findModuleSpecifiers(text))
      add(resolveSpecifier(value, fromDir, importRoot));
  };

  for (const [htmlPath, text] of sources.html) {
    const dir = path.dirname(htmlPath);
    SCRIPT_RE.lastIndex = 0;
    for (const match of text.matchAll(SCRIPT_RE)) {
      const attrs = match[1];
      if (!DIRECTIVE_RE.test(attrs)) continue;
      const src = /(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(
        attrs,
      );
      if (src) {
        const value = (src[1] ?? src[2] ?? src[3] ?? "").trim();
        if (value.startsWith("@/"))
          add(resolveFile(path.resolve(importRoot, value.slice(2))));
        else if (
          value &&
          !value.startsWith("/") &&
          !/^[a-z][a-z\d+.-]*:/i.test(value)
        )
          add(resolveFile(path.resolve(dir, value)));
      } else addImports(match[2], dir);
    }
  }
  for (const route of sources.apiRoutes ?? []) add(route);

  while (queue.length > 0) {
    const file = queue.pop()!;
    let text = sources.readText?.(file);
    if (text === undefined) {
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
    }
    addImports(text, path.dirname(file));
  }
  return found;
}

/** The API route files under `apiRoot`, skipping tests and folders that start with a dot. */
export function listApiRoutes(apiRoot: string | undefined): string[] {
  if (!apiRoot) return [];
  const out: string[] = [];
  const stack = [apiRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (
        API_ROUTE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) &&
        !isTestFile(entry.name)
      )
        out.push(full);
    }
  }
  return out;
}

const cache = new WeakMap<ProjectSnapshot, Set<string>>();

/**
 * The Node modules of a project snapshot: its pages' and components' HTML
 * (open HTML buffers in place of the disk) and its API routes. Cached per
 * snapshot when no buffers are given (`--check`); recomputed with open
 * buffers (the editor), where a page or import can change between checks.
 */
export function scriptModulesOf(
  snapshot: ProjectSnapshot,
  openDocumentTexts: { fsPath: string; text: string }[] = [],
): Set<string> {
  if (openDocumentTexts.length === 0) {
    const cached = cache.get(snapshot);
    if (cached) return cached;
  }
  const open = new Map(
    openDocumentTexts.map((d) => [normalizeModulePath(d.fsPath), d.text]),
  );
  const html = new Map<string, string>();
  for (const [file, text] of snapshot.htmlUsageByFile) html.set(file, text);
  for (const [file, text] of snapshot.componentSourceByFile ?? [])
    html.set(file, text);
  for (const { fsPath, text } of openDocumentTexts)
    if (fsPath.toLowerCase().endsWith(".html")) html.set(fsPath, text);
  const modules = findScriptModules({
    projectRoot: snapshot.projectRoot,
    importRoot: snapshot.importRoot,
    html,
    apiRoutes: listApiRoutes(snapshot.apiRoot),
    readText: (file) => open.get(normalizeModulePath(file)),
  });
  if (openDocumentTexts.length === 0) cache.set(snapshot, modules);
  return modules;
}
