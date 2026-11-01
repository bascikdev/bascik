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

/** A directive attribute in a script's open tag; group 1 is the directive. */
const DIRECTIVE_RE =
  /(?:^|[\s"'])data-bascik-(build-once|build|routes|server|stream)(?=[\s=/>]|$)/i;
const SCRIPT_EXTENSIONS = [".ts", ".mts", ".js", ".mjs"];
const API_ROUTE_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs"]);
/** A bound on the files followed, so a huge or cyclic graph cannot stall the editor. */
const MAX_MODULES = 5_000;

const SCRIPT_OPEN_RE = /<script(?=[\t\n\f\r />])/gi;
const SCRIPT_CLOSE_RE = /<\/script(?=[\t\n\f\r />])/gi;
const SRC_RE = /(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

/** A <script> element of a page: its open tag's attributes, and its body. */
interface ScriptTag {
  attrs: string;
  body: string;
}

/**
 * The closed <script> elements of an HTML text, in one linear pass. An open
 * tag ends at the first `>` outside quotes; its body at the next
 * `</script`. Whatever follows an opener with no `>` or no close (a page
 * being typed) is not read, since nothing after it can end the script.
 */
function scriptTags(text: string): ScriptTag[] {
  const out: ScriptTag[] = [];
  let pos = 0;
  while (pos < text.length) {
    SCRIPT_OPEN_RE.lastIndex = pos;
    const open = SCRIPT_OPEN_RE.exec(text);
    if (!open) break;
    let i = open.index + 7;
    let tagEnd = -1;
    while (i < text.length) {
      const c = text[i];
      if (c === '"' || c === "'") {
        const quote = text.indexOf(c, i + 1);
        if (quote === -1) return out;
        i = quote + 1;
      } else if (c === ">") {
        tagEnd = i;
        break;
      } else i++;
    }
    if (tagEnd === -1) break;
    SCRIPT_CLOSE_RE.lastIndex = tagEnd + 1;
    const close = SCRIPT_CLOSE_RE.exec(text);
    if (!close) break;
    out.push({
      attrs: text.slice(open.index + 7, tagEnd),
      body: text.slice(tagEnd + 1, close.index),
    });
    const closeEnd = text.indexOf(">", close.index);
    pos = closeEnd === -1 ? text.length : closeEnd + 1;
  }
  return out;
}

/**
 * A script's import specifiers, or none when the script cannot be read (a
 * template nested thousands deep overflows the scanner's stack).
 */
function specifiersOf(text: string): string[] {
  const known = specifierMemo.get(text);
  if (known !== undefined) return known;
  let found: string[];
  try {
    found = findModuleSpecifiers(text).map((s) => s.value);
  } catch {
    found = [];
  }
  if (
    specifierMemo.size >= SPECIFIER_MEMO_ENTRIES ||
    specifierMemoChars + text.length > SPECIFIER_MEMO_CHARS
  ) {
    specifierMemo.clear();
    specifierMemoChars = 0;
  }
  specifierMemo.set(text, found);
  specifierMemoChars += text.length;
  return found;
}

/**
 * Import specifiers by script text. A walk reads a module once per reach
 * (build, request, browser), `bascik --check` walks twice (the checked
 * files and the whole project), and the language server walks again after
 * every module write, so the same texts are scanned many times; keyed by
 * text, an edited file is simply scanned anew. Bounded by entries and by
 * characters held, and cleared whole when full.
 */
const SPECIFIER_MEMO_ENTRIES = 8192;
const SPECIFIER_MEMO_CHARS = 32 * 1024 * 1024;
const specifierMemo = new Map<string, string[]>();
let specifierMemoChars = 0;

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

/** A script's src= value as a local file, or undefined for none, a URL or a root-absolute path. */
function resolveSrc(
  attrs: string,
  dir: string,
  importRoot: string,
): string | undefined | null {
  const src = SRC_RE.exec(attrs);
  if (!src) return null;
  const value = (src[1] ?? src[2] ?? src[3] ?? "").trim();
  if (value.startsWith("@/"))
    return resolveFile(path.resolve(importRoot, value.slice(2)));
  if (value && !value.startsWith("/") && !/^[a-z][a-z\d+.-]*:/i.test(value))
    return resolveFile(path.resolve(dir, value));
  return undefined;
}

export interface ScriptModuleSources {
  projectRoot: string;
  importRoot: string;
  /** HTML files (pages and components) and their text. */
  html: Iterable<[fsPath: string, text: string]>;
  /** API route files. */
  apiRoutes?: Iterable<string>;
  /**
   * Folders outside the project whose files belong to it too: the
   * configured component roots (`directory.components` may name
   * `../shared/components`), the API root and `scripts.importRoot`.
   */
  extraRoots?: Iterable<string>;
  /** Text of a module that is open in the editor, used in place of the disk. */
  readText?: (fsPath: string) => string | undefined;
}

/**
 * The files that run in Node (normalized paths). `requestTime` holds the
 * ones that run per request: API routes and what server scripts, stream
 * scripts and API routes reach. `browser` holds what browser code reaches
 * (a plain `<script src>` companion and what browser scripts import); a
 * file can be in both sets, when browser and Node code share it.
 */
export class ScriptModules extends Set<string> {
  readonly requestTime = new Set<string>();
  readonly browser = new Set<string>();

  /** Every module of both, request-time or browser in either. */
  static union(a: ScriptModules, b: ScriptModules): ScriptModules {
    const out = new ScriptModules([...a, ...b]);
    for (const m of [...a.requestTime, ...b.requestTime])
      out.requestTime.add(m);
    for (const m of [...a.browser, ...b.browser]) out.browser.add(m);
    return out;
  }
}

type Reach = "build" | "request" | "browser";

/** Every file that runs in Node, from the given pages, components and API routes. */
export function findScriptModules(sources: ScriptModuleSources): ScriptModules {
  const { projectRoot, importRoot } = sources;
  const roots = [projectRoot, ...(sources.extraRoots ?? [])];
  const found = new ScriptModules();
  /** Files visited, per reach. */
  const visited: Record<Reach, Set<string>> = {
    build: new Set(),
    request: new Set(),
    browser: new Set(),
  };
  let visits = 0;
  const queue: [file: string, reach: Reach][] = [];
  const inProject = (file: string): boolean =>
    !file.split(/[\\/]/).includes("node_modules") &&
    roots.some((r) => {
      const rel = path.relative(r, file);
      return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    });
  const add = (file: string | undefined | null, reach: Reach): void => {
    if (!file || !inProject(file) || isTestFile(file)) return;
    const key = normalizeModulePath(file);
    if (visited[reach].has(key) || visits >= MAX_MODULES * 3) return;
    visited[reach].add(key);
    visits++;
    if (reach === "browser") found.browser.add(key);
    else {
      if (!found.has(key) && found.size >= MAX_MODULES) return;
      found.add(key);
      if (reach === "request") found.requestTime.add(key);
    }
    queue.push([file, reach]);
  };
  const addImports = (text: string, fromDir: string, reach: Reach): void => {
    for (const value of specifiersOf(text))
      add(resolveSpecifier(value, fromDir, importRoot), reach);
  };

  for (const [htmlPath, text] of sources.html) {
    const dir = path.dirname(htmlPath);
    for (const { attrs, body } of scriptTags(text)) {
      const directive = DIRECTIVE_RE.exec(attrs)?.[1]?.toLowerCase();
      const reach: Reach =
        directive === undefined
          ? "browser"
          : directive === "server" || directive === "stream"
            ? "request"
            : "build";
      const src = resolveSrc(attrs, dir, importRoot);
      if (src === null) addImports(body, dir, reach);
      else add(src, reach);
    }
  }
  for (const route of sources.apiRoutes ?? []) add(route, "request");

  const texts = new Map<string, string | undefined>();
  while (queue.length > 0) {
    const [file, reach] = queue.pop()!;
    let text = texts.get(file);
    if (text === undefined && !texts.has(file)) {
      text = sources.readText?.(file);
      if (text === undefined) {
        try {
          text = fs.readFileSync(file, "utf8");
        } catch {
          text = undefined;
        }
      }
      texts.set(file, text);
    }
    if (text !== undefined) addImports(text, path.dirname(file), reach);
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

/** What an open buffer contributes to the module graph: its scripts' kinds, src= values and imports. */
function importSignature(fsPath: string, text: string): string | undefined {
  const lower = fsPath.toLowerCase();
  if (lower.endsWith(".html"))
    return scriptTags(text)
      .map(
        ({ attrs, body }) =>
          `${DIRECTIVE_RE.exec(attrs)?.[1]?.toLowerCase() ?? ""}|${
            SRC_RE.exec(attrs)?.[0] ?? specifiersOf(body).join("\u0000")
          }`,
      )
      .join("\n");
  if (SCRIPT_EXTENSIONS.includes(path.extname(lower)))
    return specifiersOf(text).join("\u0000");
  return undefined;
}

/** The last signature computed for each open buffer, reused while its text is the same string. */
const signatureMemo = new Map<string, { text: string; signature: string }>();

const signaturesOf = (
  openDocumentTexts: { fsPath: string; text: string }[],
): Map<string, string> => {
  const out = new Map<string, string>();
  for (const { fsPath, text } of openDocumentTexts) {
    const key = normalizeModulePath(fsPath);
    const memo = signatureMemo.get(key);
    let signature: string | undefined;
    if (memo && memo.text === text) signature = memo.signature;
    else {
      signature = importSignature(fsPath, text);
      if (signature !== undefined) signatureMemo.set(key, { text, signature });
    }
    if (signature !== undefined) out.set(key, signature);
  }
  if (signatureMemo.size > 4 * out.size + 64) signatureMemo.clear();
  return out;
};

const sameSignatures = (
  a: Map<string, string>,
  b: Map<string, string>,
): boolean => {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
};

const cache = new WeakMap<
  ProjectSnapshot,
  {
    signatures: Map<string, string>;
    modules: ScriptModules;
    generation: number;
  }
>();

/** Bumped when a module changes on disk, which no snapshot or open buffer shows. */
let generation = 0;

/**
 * Forgets every cached module set. The language server calls it when a
 * .ts or .js file changes on disk (a checkout, a formatter, an agent's
 * edit), since a closed module's imports decide which files run in Node.
 */
export function invalidateScriptModules(): void {
  generation++;
}

/**
 * The Node modules of a project snapshot: its pages' and components' HTML
 * (open HTML buffers in place of the disk) and its API routes. Cached per
 * snapshot, and reused while the open buffers' scripts and imports stay the
 * same, so typing in a module or in a page's markup does not walk the
 * project again; an edit that adds, removes or changes an import does, and
 * so does invalidateScriptModules().
 */
export function scriptModulesOf(
  snapshot: ProjectSnapshot,
  openDocumentTexts: { fsPath: string; text: string }[] = [],
): ScriptModules {
  const signatures = signaturesOf(openDocumentTexts);
  const cached = cache.get(snapshot);
  if (
    cached &&
    cached.generation === generation &&
    sameSignatures(cached.signatures, signatures)
  )
    return cached.modules;
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
    extraRoots: snapshotRoots(snapshot),
    readText: (file) => open.get(normalizeModulePath(file)),
  });
  cache.set(snapshot, { signatures, modules, generation });
  return modules;
}

/**
 * A snapshot's component roots, API root and `scripts.importRoot`, which
 * may lie outside the project (a monorepo's shared folder).
 */
export const snapshotRoots = (snapshot: ProjectSnapshot): string[] => [
  ...snapshot.componentRoots,
  ...(snapshot.apiRoot ? [snapshot.apiRoot] : []),
  snapshot.importRoot,
];
