#!/usr/bin/env node
// Audit how a Bascik project's pages are composed from components, and whether its code is TypeScript.
// Dependency-free; Node.js 22.22+. Run from the project root. Heuristic: every finding is a suggestion to weigh.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  componentRoots,
  fail,
  findProjectRoot,
  isMain,
  loadProjectConfig,
  pagesDirectory,
  walkFiles,
} from "./lib/project.mjs";
import {
  PAGE_CONTEXT_VARS,
  pageContextOf,
  resolveLocalImport,
} from "./lib/build-scripts.mjs";
import { listComponents, tagNameProblem } from "./lib/components.mjs";
import {
  countNonBlankLines,
  maskKeepingLines,
  parseMarkup,
  walkElements,
} from "./lib/markup.mjs";

const HELP = `Usage: node audit-components.mjs [--json] [--allow-js] [--root <dir>]
                                  [--max-page-lines <n>] [--max-component-lines <n>]

Checks that pages read like a list of component tags rather than big blocks of HTML, that components are split
with balance, and that new code is TypeScript. Run it with bascik --check before calling a page done. Each finding
names file:line and what to do. Exit code 1 when there is a warning, 2 on a usage error.

Rules:
  oversized-page       A page with more than 80 lines of markup (scripts and styles not counted)
  oversized-component  A component with more than 120 lines of markup, or 300 lines in all
  inline-section       A 12+ line section, header, footer, nav, form, or similar in a page that has a nameable job
                       (a label, id, class, or heading): make it a component and leave its tag in the page
  repeated-block       The same block of 4+ elements pasted twice or more: make it one component with props
  repeated-pattern     The same heading group (an eyebrow, heading, and intro, say) written by hand in 3+ files,
                       even with different modifier classes or inline links: make it one component with props
  repeated-text        The same sentence or fact (20+ characters, such as an address) typed into 2+ files: keep it
                       in one component or one data file so a change is one edit
  constant-prop        A prop that every use (3+) passes with the same value: write the value into the component
  tiny-component       A component of 3 elements or fewer, used once, with no script: inline it into its parent
  prop-drilling        A component that only forwards a prop to a child (data-bascik-attr-data-bascik-prop-*):
                       let the page fill the child through a slot, or give the value to the child directly
  js-not-ts            A browser <script>, .js companion, or .js/.mjs helper where TypeScript is expected, and a
                       page <script src="x.ts">, which Bascik does not compile (only component companions are)
  build-once           A <script data-bascik-build> in a component that reads no page context (BASCIK_PAGE_PATH,
                       BASCIK_PAGE_FILE, BASCIK_ROUTE, here or in a local module it imports): its output is the same
                       on every page, so use <script data-bascik-build-once>
  once-reads-page      A <script data-bascik-build-once> that reads page context, which is empty there: use
                       <script data-bascik-build>, which runs per page

Options:
  --allow-js                 Skip js-not-ts (only when the person asked for JavaScript)
  --max-page-lines <n>       Markup lines a page may have (default 80)
  --max-component-lines <n>  Markup lines a component may have (default 120)
  --json                     Print JSON: { root, findings, stats }
  --root <dir>               Project root (default: nearest Bascik project above the current directory)
  --help                     Show this message`;

export const DEFAULT_LIMITS = {
  maxPageLines: 80,
  maxComponentLines: 120,
  maxComponentFileLines: 300,
  minSectionLines: 12,
  minRepeatElements: 4,
  tinyMaxElements: 3,
  tinyMaxLines: 5,
};

const NODE_DIRECTIVES = [
  "data-bascik-build",
  "data-bascik-build-once",
  "data-bascik-routes",
  "data-bascik-server",
  "data-bascik-stream",
];
const BROWSER_SCRIPT_TYPES = new Set([
  "",
  "text/javascript",
  "application/javascript",
  "module",
]);
const SECTION_TAGS = new Set([
  "section",
  "header",
  "footer",
  "nav",
  "aside",
  "article",
  "form",
  "figure",
  "details",
  "fieldset",
  "table",
  "dl",
  "ul",
  "ol",
  "div",
]);
const NOT_A_BLOCK = new Set([
  "html",
  "head",
  "body",
  "main",
  "template",
  "tr",
  "thead",
  "tbody",
  "tfoot",
  "option",
  "script",
  "style",
]);
const SUFFIX = {
  section: "section",
  article: "card",
  li: "item",
  header: "header",
  footer: "footer",
  nav: "nav",
  aside: "aside",
  form: "form",
  figure: "figure",
  ul: "list",
  ol: "list",
  dl: "list",
  table: "table",
  details: "details",
  fieldset: "fields",
};
const GENERIC_NAMES = new Set([
  "container",
  "wrapper",
  "wrap",
  "inner",
  "outer",
  "row",
  "col",
  "column",
  "grid",
  "flex",
  "box",
  "content",
  "section",
  "block",
  "stack",
  "cluster",
  "main",
]);
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "the",
  "of",
  "to",
  "for",
  "our",
  "your",
  "with",
  "in",
  "on",
  "at",
  "is",
  "are",
  "today",
  "now",
]);
const INLINE_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "br",
  "code",
  "em",
  "i",
  "kbd",
  "mark",
  "s",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "wbr",
]);
const MIN_REPEATED_TEXT = 20;
const MIN_PATTERN_FILES = 3;
const MIN_CONSTANT_PROP_USES = 3;
const SKIPPED_DIRS = ["node_modules", "coverage", "test-results"];
const JS_FILE = /\.(?:js|mjs|cjs|jsx)$/i;

/** True when `file` is inside `dir` (not `dir` itself). */
const insideDir = (file, dir) => {
  const rel = relative(dir, file);
  return Boolean(rel) && !rel.startsWith("..") && !rel.startsWith("/");
};

/** A component tag name for a block, from a hint such as a class, id, label, or heading. Exported for tests. */
export function suggestTagName(tag, hint = "", fallback = "page") {
  const lower = String(hint).trim().toLowerCase();
  if (lower.includes("-") && !tagNameProblem(lower)) return lower;
  const words = lower
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word && !STOP_WORDS.has(word) && !/^\d/.test(word))
    .slice(0, 2);
  if (words.length === 0) words.push(fallback);
  const suffix = SUFFIX[tag] ?? "block";
  if (words[words.length - 1] !== suffix) words.push(suffix);
  return words.join("-");
}

const textOf = (node, source) =>
  source
    .slice(node.openEnd ?? node.start, node.end)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** The most specific name a block carries: aria-label, id, a non-generic class, then its first heading's text. */
function nameHint(node, source, { headings = true } = {}) {
  if (node.attrs["aria-label"]) return node.attrs["aria-label"];
  if (node.attrs.id && !GENERIC_NAMES.has(node.attrs.id)) return node.attrs.id;
  const cls = (node.attrs.class ?? "")
    .split(/\s+/)
    .find((name) => name && !GENERIC_NAMES.has(name.toLowerCase()));
  if (cls) return cls;
  if (!headings) return "";
  let heading = "";
  walkElements(node, (child) => {
    if (heading) return false;
    if (/^h[1-6]$/.test(child.tag)) heading = textOf(child, source);
  });
  return heading;
}

const describeOpenTag = (node) =>
  `<${node.tag}${node.attrs.class ? ` class="${node.attrs.class}"` : node.attrs.id ? ` id="${node.attrs.id}"` : ""}>`;

const insideHead = (node) => {
  for (let p = node.parent; p; p = p.parent) if (p.tag === "head") return true;
  return false;
};

const isNodeScript = (node) =>
  NODE_DIRECTIVES.some((name) => name in node.attrs);

/** Read and parse one HTML file of the project. */
function readHtml(root, file, kind) {
  const source = readFileSync(file, "utf8");
  const masked = maskKeepingLines(source);
  return {
    kind,
    path: file,
    file: relative(root, file).replace(/\\/g, "/"),
    source,
    tree: parseMarkup(source),
    markupLines: countNonBlankLines(masked),
    lines: countNonBlankLines(source),
    masked,
  };
}

function signatureOf(node, isComponent, memo) {
  if (memo.has(node)) return memo.get(node);
  let signature;
  let size;
  if (isComponent(node.tag)) {
    signature = `<${node.tag}/>`;
    size = 0;
  } else {
    const children = node.children
      .filter((child) => child.tag !== "script" && child.tag !== "style")
      .map((child) => signatureOf(child, isComponent, memo));
    const cls = (node.attrs.class ?? "").split(/\s+/).filter(Boolean).sort();
    signature = `${node.tag}${cls.length ? `.${cls.join(".")}` : ""}(${children.map((c) => c.signature).join(",")})`;
    size = 1 + children.reduce((sum, c) => sum + c.size, 0);
  }
  const result = { signature, size };
  memo.set(node, result);
  return result;
}

function checkScripts(doc, options, findings, stats) {
  const componentName =
    doc.kind === "component" ? basename(doc.path, ".html") : undefined;
  walkElements(doc.tree, (node) => {
    if (node.tag !== "script") return;
    if (isNodeScript(node)) return false;
    const type = (node.attrs.type ?? "").trim().toLowerCase();
    if (type === "text/typescript") {
      stats.tsScripts++;
      return false;
    }
    if (!BROWSER_SCRIPT_TYPES.has(type)) return false;
    const src = node.attrs.src;
    const module = type === "module";
    if (src !== undefined) {
      if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(src) || src.startsWith("/"))
        return false; // A third-party URL or a bundle written to dist/: not authored here.
      if (/\.m?ts(?:[?#].*)?$/i.test(src)) {
        stats.tsScripts++;
        if (doc.kind === "page")
          findings.push({
            rule: "js-not-ts",
            level: "warn",
            file: doc.file,
            line: node.line,
            message: `<script src="${src}"> in a page is not compiled: the browser would receive TypeScript.`,
            suggestion: `Move the behavior into a component and load ${basename(src)} from the component's folder with <script${module ? ' type="module"' : ""} src="${basename(src)}">, or inline it as <script type="text/typescript">.`,
          });
        return false;
      }
      stats.jsScripts++;
      if (options.allowJs) return false;
      const tsName = src.replace(/\.(?:m?js|cjs|jsx)(?=$|[?#])/i, ".ts");
      findings.push({
        rule: "js-not-ts",
        level: "warn",
        file: doc.file,
        line: node.line,
        message: `<script src="${src}"> loads JavaScript; new browser code is TypeScript.`,
        suggestion:
          doc.kind === "component"
            ? `Rename ${src} to ${tsName} and point the src at it; Bascik strips the types when it inlines the file (erasable syntax, no setup).`
            : `Move the behavior into a component with a ${tsName} companion, or inline it as <script type="text/typescript">; a page's own .ts src is not compiled.`,
      });
      return false;
    }
    if (!node.body) return false;
    stats.jsScripts++;
    if (options.allowJs) return false;
    let suggestion;
    if (doc.kind === "component")
      suggestion = module
        ? `Move it to ${componentName}.ts and load it with <script type="module" src="${componentName}.ts"> (inline type="text/typescript" blocks are classic scripts, so they cannot hold import or export).`
        : `Mark it <script type="text/typescript"> and add types (erasable syntax works with no setup), or move it to ${componentName}.ts beside the template and load it with <script src="${componentName}.ts">.`;
    else
      suggestion = module
        ? `Move it into a component and load its .ts companion with <script type="module" src="name.ts">; a page's own <script src="x.ts"> is not compiled.`
        : `Mark it <script type="text/typescript"> and add types, or move the behavior into a component with a .ts companion.`;
    findings.push({
      rule: "js-not-ts",
      level: "warn",
      file: doc.file,
      line: node.line,
      message: `Inline ${module ? "module " : ""}<script> is JavaScript; new browser code is TypeScript.`,
      suggestion,
    });
    return false;
  });
}

/**
 * build-once: a component's data-bascik-build script whose output cannot depend on the page. once-reads-page: a
 * data-bascik-build-once script that reads page context, which is empty there. A script whose `src=` file or local
 * import cannot be read is left alone: the build reports a missing file.
 */
function checkBuildScripts(doc, root, importRoot, findings) {
  const where = doc.kind === "component" ? `<${doc.tag}>` : "this page";
  walkElements(doc.tree, (node) => {
    if (node.tag !== "script") return;
    const once = "data-bascik-build-once" in node.attrs;
    const build = "data-bascik-build" in node.attrs;
    if (!once && !(build && doc.kind === "component")) return false;
    const fromDir = dirname(doc.path);
    let code = node.body ?? "";
    let codeDir = fromDir;
    const src = node.attrs.src;
    if (src !== undefined) {
      const target = resolveLocalImport(src, fromDir, importRoot);
      if (!target?.found) return false;
      try {
        code = readFileSync(target.file, "utf8");
      } catch {
        return false;
      }
      codeDir = dirname(target.file);
    }
    const context = pageContextOf(code, { fromDir: codeDir, importRoot });
    if (once && context.reads === true) {
      const from = context.via
        ? ` (in ${relative(root, context.via).replace(/\\/g, "/")})`
        : "";
      findings.push({
        rule: "once-reads-page",
        level: "warn",
        file: doc.file,
        line: node.line,
        message: `<script data-bascik-build-once> in ${where} reads ${context.vars.join(", ")}${from}, which is empty there: one run serves every page.`,
        suggestion:
          "Use <script data-bascik-build>, which runs once per page with that page's context, or stop reading the page if the output is the same everywhere.",
      });
    } else if (!once && context.reads === false) {
      findings.push({
        rule: "build-once",
        level: "warn",
        file: doc.file,
        line: node.line,
        message: `<script data-bascik-build> in ${where} reads no page context (${PAGE_CONTEXT_VARS.join(", ")}), so it prints the same markup on every page that uses it.`,
        suggestion:
          "Use <script data-bascik-build-once>: it runs once when the component is registered, every page shares the output, and the markup is scoped like the template. Keep data-bascik-build only when the output depends on the page.",
      });
    }
    return false;
  });
}

function checkJsFiles(root, layout, options, findings) {
  const skipped = [
    layout.outDir,
    ...layout.localRoots,
    ...SKIPPED_DIRS.map((dir) => join(root, dir)),
  ];
  for (const path of walkFiles(root, [".js", ".mjs", ".cjs", ".jsx"])) {
    if (!JS_FILE.test(path) || /\.min\.js$/i.test(path)) continue;
    if (skipped.some((dir) => insideDir(path, dir))) continue;
    const file = relative(root, path).replace(/\\/g, "/");
    const name = basename(path);
    const tsName = name.replace(/\.(?:js|mjs|cjs|jsx)$/i, ".ts");
    if (name === "bascik.config.js") {
      findings.push({
        rule: "js-not-ts",
        level: "warn",
        file,
        line: 1,
        message: "bascik.config.js is JavaScript.",
        suggestion:
          "Rename it to bascik.config.ts and import defineConfig from @bascik/bascik/config for typed options. Delete the .js file: when both exist, bascik.config.js wins.",
      });
      continue;
    }
    if (insideDir(path, layout.pagesDir)) {
      findings.push({
        rule: "js-not-ts",
        level: "info",
        file,
        line: 1,
        message: `${name} is a public JavaScript file copied to dist as is.`,
        suggestion: `If you wrote it, move the behavior into a component with a ${tsName} companion. Vendored or generated files are fine.`,
      });
      continue;
    }
    const isToolConfig = /\.config\.[cm]?js$/i.test(name);
    findings.push({
      rule: "js-not-ts",
      level: isToolConfig ? "info" : "warn",
      file,
      line: 1,
      message: `${name} is JavaScript; new code is TypeScript.`,
      suggestion: isToolConfig
        ? `Use ${tsName} if the tool reads TypeScript config.`
        : `Rename it to ${tsName}, add types, and update its imports (with the .ts extension). Node runs it directly; keep to erasable syntax (no enum or namespace).`,
    });
  }
}

/** Audit the project at `root`. Returns `{ findings, stats }`. Exported for tests. */
export async function auditProject(root, options = {}) {
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS))
    if (options[key] !== undefined) limits[key] = options[key];

  const config = await loadProjectConfig(root);
  if (config?.error && !options.quiet)
    process.stderr.write(
      `audit-components: could not load ${config.path} (${config.error.message}); using the default folders.\n`,
    );
  const configModule = config?.module;
  const pagesDir = pagesDirectory(root, configModule);
  if (!existsSync(pagesDir)) {
    const error = new Error(
      `no pages directory at ${relative(root, pagesDir).replace(/\\/g, "/") || "."} (looked in ${root}). Run it from the project root or pass --root.`,
    );
    error.usage = true;
    throw error;
  }
  const roots = componentRoots(root, configModule);
  const isLocal = (path) => !relative(root, path).startsWith("..");
  const localRoots = roots.filter(isLocal);
  const outDir = join(root, configModule?.default?.directory?.out ?? "dist");

  const inventory = listComponents(roots, root);
  const tags = new Set(inventory.map((c) => c.tag));
  const isComponent = (tag) => tags.has(tag);

  const pages = walkFiles(pagesDir, [".html"]).map((file) =>
    readHtml(root, file, "page"),
  );
  const components = inventory.map((c) => ({
    ...readHtml(root, join(root, c.file), "component"),
    tag: c.tag,
    info: c,
    local: isLocal(join(root, c.file)),
  }));
  const docs = [...pages, ...components];

  const findings = [];
  const stats = {
    pages: pages.length,
    components: components.length,
    largestFile: { file: "", lines: 0 },
    medianPageLines: 0,
    tsScripts: 0,
    jsScripts: 0,
  };
  for (const doc of docs)
    if (doc.lines > stats.largestFile.lines)
      stats.largestFile = { file: doc.file, lines: doc.lines };
  const pageLines = pages.map((p) => p.lines).sort((a, b) => a - b);
  if (pageLines.length)
    stats.medianPageLines =
      pageLines.length % 2
        ? pageLines[(pageLines.length - 1) / 2]
        : (pageLines[pageLines.length / 2 - 1] +
            pageLines[pageLines.length / 2]) /
          2;

  // oversized-page and oversized-component
  for (const doc of pages) {
    if (doc.markupLines <= limits.maxPageLines) continue;
    findings.push({
      rule: "oversized-page",
      level: "warn",
      file: doc.file,
      line: 1,
      message: `${doc.file} has ${doc.markupLines} lines of markup (limit ${limits.maxPageLines}), too long to read at a glance.`,
      suggestion: `Give each part with its own job a component and leave its tag here, so the page reads as a list of tags (<site-header />, <pricing-section />, <site-footer />). If it is long prose, move the text to content/${basename(doc.file, ".html")}.md and render it with a build script.`,
    });
  }
  for (const doc of components) {
    if (!doc.local) continue;
    const tooMuchMarkup = doc.markupLines > limits.maxComponentLines;
    if (!tooMuchMarkup && doc.lines <= limits.maxComponentFileLines) continue;
    findings.push({
      rule: "oversized-component",
      level: "warn",
      file: doc.file,
      line: 1,
      message: tooMuchMarkup
        ? `<${doc.tag}> has ${doc.markupLines} lines of markup (limit ${limits.maxComponentLines}).`
        : `<${doc.tag}> is ${doc.lines} lines (limit ${limits.maxComponentFileLines}), most of it style or script.`,
      suggestion: tooMuchMarkup
        ? `Split out the parts that have their own job as child components placed here by tag, or let pages pass content in through slots. Keep a part inline when it only makes sense inside <${doc.tag}>.`
        : `Move the <style> to ${doc.tag}.css and the script to ${doc.tag}.ts beside the template (<script src="${doc.tag}.ts">).`,
    });
  }

  // inline-section: pages only. Component usages are never flagged, but their slot content is read.
  for (const doc of pages) {
    walkElements(doc.tree, (node) => {
      if (node.tag === "head" || node.tag === "script" || node.tag === "style")
        return false;
      if (isComponent(node.tag) || !SECTION_TAGS.has(node.tag)) return;
      const lines = countNonBlankLines(doc.masked, node.start, node.end);
      if (lines < limits.minSectionLines) return false;
      const hint = nameHint(node, doc.source);
      if (!hint) return; // An unnamed wrapper: look inside it.
      const name = suggestTagName(node.tag, hint, "page");
      findings.push({
        rule: "inline-section",
        level: "warn",
        file: doc.file,
        line: node.line,
        message: `${describeOpenTag(node)} is ${lines} lines of markup inline in the page (lines ${node.line}-${node.endLine}).`,
        suggestion: `Move it to ${relative(root, join(localRoots[0] ?? roots[0], name, `${name}.html`)).replace(/\\/g, "/")} and write <${name} /> here. Turn text that differs per use into props and rich content into slots; keep it inline only if it is short or only makes sense in this page.`,
      });
      return false;
    });
  }

  // repeated-block: the same structure (tags and classes; text ignored) in two or more places.
  const memo = new Map();
  const groups = new Map();
  for (const doc of docs) {
    walkElements(doc.tree, (node) => {
      if (node.tag === "head" || node.tag === "script" || node.tag === "style")
        return false;
      if (NOT_A_BLOCK.has(node.tag) || isComponent(node.tag)) return;
      const { signature, size } = signatureOf(node, isComponent, memo);
      if (size < limits.minRepeatElements) return;
      if (!groups.has(signature)) groups.set(signature, { size, places: [] });
      groups.get(signature).places.push({ doc, node });
    });
  }
  const reported = new Set();
  const covered = (node) => {
    for (let p = node; p; p = p.parent) if (reported.has(p)) return true;
    return false;
  };
  const repeated = [...groups.values()]
    .filter((group) => group.places.length > 1)
    .sort((a, b) => b.size - a.size);
  for (const group of repeated) {
    const places = group.places
      .filter((place) => !covered(place.node))
      .sort(
        (a, b) =>
          a.doc.file.localeCompare(b.doc.file) || a.node.line - b.node.line,
      );
    if (places.length < 2) continue;
    for (const place of places) reported.add(place.node);
    const first = places[0];
    const files = new Set(places.map((p) => p.doc.file));
    const name = suggestTagName(
      first.node.tag,
      nameHint(first.node, first.doc.source, { headings: false }),
      "item",
    );
    findings.push({
      rule: "repeated-block",
      level: "warn",
      file: first.doc.file,
      line: first.node.line,
      message: `The same ${describeOpenTag(first.node)} block (${group.size} elements) appears ${places.length} times in ${files.size} file${files.size === 1 ? "" : "s"}: ${places.map((p) => `${p.doc.file}:${p.node.line}`).join(", ")}.`,
      suggestion: `Make it one component, for example <${name}>: copy one block into ${relative(root, join(localRoots[0] ?? roots[0], name, `${name}.html`)).replace(/\\/g, "/")}, turn the text that changes into props (<h3 data-bascik-prop-title></h3>) or slots, and replace each copy with <${name} data-bascik-prop-title="..." />. If the copies come from data, print the tag from one build script loop instead.`,
    });
  }

  // repeated-pattern: the same heading group (its block children with their classes; the outer element's classes
  // and inline children ignored) written by hand in several files, which the exact check above misses.
  const isBlockChild = (child) =>
    !INLINE_TAGS.has(child.tag) &&
    child.tag !== "script" &&
    child.tag !== "style" &&
    !isComponent(child.tag);
  const describeChild = (child) =>
    `<${child.tag}${child.attrs.class ? ` class="${child.attrs.class}"` : ""}>`;
  const patterns = new Map();
  for (const doc of docs) {
    walkElements(doc.tree, (node) => {
      if (node.tag === "head" || node.tag === "script" || node.tag === "style")
        return false;
      if (NOT_A_BLOCK.has(node.tag) || isComponent(node.tag)) return;
      if (covered(node)) return false;
      const kids = node.children.filter(isBlockChild);
      if (kids.length < 3 || !kids.some((kid) => /^h[1-6]$/.test(kid.tag)))
        return;
      const shape = `${node.tag}(${kids
        .map(
          (kid) =>
            `${kid.tag}${(kid.attrs.class ?? "")
              .split(/\s+/)
              .filter(Boolean)
              .sort()
              .map((cls) => `.${cls}`)
              .join("")}`,
        )
        .join(",")})`;
      if (!patterns.has(shape)) patterns.set(shape, []);
      patterns.get(shape).push({ doc, node, kids });
    });
  }
  for (const places of patterns.values()) {
    const files = new Set(places.map((p) => p.doc.file));
    if (files.size < MIN_PATTERN_FILES) continue;
    places.sort(
      (a, b) =>
        a.doc.file.localeCompare(b.doc.file) || a.node.line - b.node.line,
    );
    for (const place of places) reported.add(place.node);
    const first = places[0];
    const hinted = places
      .map((p) => nameHint(p.node, p.doc.source, { headings: false }))
      .find((hint) => hint.includes("-") && !tagNameProblem(hint));
    const name = hinted ?? "section-head";
    findings.push({
      rule: "repeated-pattern",
      level: "warn",
      file: first.doc.file,
      line: first.node.line,
      message: `The same heading group (<${first.node.tag}> with ${first.kids.map(describeChild).join(", ")}) is written by hand ${places.length} times in ${files.size} files: ${places.map((p) => `${p.doc.file}:${p.node.line}`).join(", ")}.`,
      suggestion: `Make it one component, <${name}>, with a prop for each part (<p data-bascik-prop-label></p>, <h2 data-bascik-prop-title></h2>, <p data-bascik-prop-text></p>) and a slot for extras such as a link, then write <${name} data-bascik-prop-title="..." /> in each place. A modifier such as "centered" becomes a class on a wrapper or a prop that lands in data-bascik-attr-class.`,
    });
  }

  // repeated-text: the same sentence or fact typed into more than one file. Prop placeholders are not counted.
  const textPlaces = new Map();
  for (const doc of docs) {
    walkElements(doc.tree, (node) => {
      if (
        node.tag === "head" ||
        node.tag === "script" ||
        node.tag === "style" ||
        node.tag === "template"
      )
        return false;
      if (isComponent(node.tag) || INLINE_TAGS.has(node.tag)) return;
      if (covered(node)) return false;
      if (!node.children.every((child) => INLINE_TAGS.has(child.tag))) return;
      if (
        Object.keys(node.attrs).some((name) =>
          name.startsWith("data-bascik-prop-"),
        )
      )
        return false;
      const text = textOf(node, doc.masked);
      if (text.length < MIN_REPEATED_TEXT || !/[a-z]/i.test(text)) return false;
      if (!textPlaces.has(text)) textPlaces.set(text, []);
      textPlaces.get(text).push({ doc, node });
      return false;
    });
  }
  for (const [text, places] of textPlaces) {
    const files = new Set(places.map((p) => p.doc.file));
    if (files.size < 2) continue;
    places.sort(
      (a, b) =>
        a.doc.file.localeCompare(b.doc.file) || a.node.line - b.node.line,
    );
    const first = places[0];
    const hint = nameHint(first.node, first.doc.source, { headings: false });
    const name =
      hint.includes("-") && !tagNameProblem(hint)
        ? hint
        : first.node.tag === "address"
          ? "site-address"
          : suggestTagName(first.node.tag, hint || text, "shared");
    const shown = text.length > 80 ? `${text.slice(0, 77)}...` : text;
    findings.push({
      rule: "repeated-text",
      level: "warn",
      file: first.doc.file,
      line: first.node.line,
      message: `"${shown}" is typed into ${files.size} files: ${places.map((p) => `${p.doc.file}:${p.node.line}`).join(", ")}.`,
      suggestion: `Keep it in one place so a change is one edit: a small component such as <${name} /> used in each spot, or a value in one data file (src/lib/site.ts) that build scripts read. Facts like an address, hours, prices, or a phone number drift apart when they are copied.`,
    });
  }

  // tiny-component: tiny, used once, no behavior of its own, in this project's own folders.
  const usageFiles = walkFiles(root, [
    ".html",
    ".ts",
    ".mts",
    ".js",
    ".mjs",
    ".md",
  ]).filter(
    (file) =>
      !insideDir(file, outDir) &&
      !SKIPPED_DIRS.some((dir) => insideDir(file, join(root, dir))),
  );
  const texts = usageFiles.map((file) => ({
    file: relative(root, file).replace(/\\/g, "/"),
    source: readFileSync(file, "utf8"),
  }));
  const parsedByFile = new Map(docs.map((doc) => [doc.file, doc]));
  for (const doc of components) {
    if (!doc.local) continue;
    const info = doc.info;
    if (
      info.hasClientScript ||
      info.directives?.length ||
      info.companions?.some((c) => /\.(?:m?ts|m?js)$/.test(c))
    )
      continue;
    let elements = 0;
    let composes = false;
    walkElements(doc.tree, (node) => {
      if (node.tag === "script" || node.tag === "style") return false;
      if (isComponent(node.tag)) composes = true;
      else elements++;
    });
    if (composes) continue; // Arranging other components is a job of its own.
    const markupWithoutStyle = countNonBlankLines(
      doc.masked.replace(/<style\b[\s\S]*?<\/style\s*>/gi, (m) =>
        m.replace(/[^\n]/g, " "),
      ),
    );
    if (
      elements > limits.tinyMaxElements ||
      markupWithoutStyle > limits.tinyMaxLines
    )
      continue;
    const pattern = new RegExp(`<${doc.tag}(?=[\\s/>])`, "gi");
    const uses = [];
    for (const { file, source } of texts) {
      if (file === doc.file) continue;
      for (const m of source.matchAll(pattern))
        uses.push({
          file,
          line: source.slice(0, m.index).split("\n").length,
          index: m.index,
        });
    }
    if (uses.length !== 1) continue;
    const [use] = uses;
    const parsed = parsedByFile.get(use.file);
    let inHead = false;
    if (parsed)
      walkElements(parsed.tree, (node) => {
        if (node.start === use.index && insideHead(node)) inHead = true;
      });
    if (inHead) continue;
    findings.push({
      rule: "tiny-component",
      level: "warn",
      file: doc.file,
      line: 1,
      message: `<${doc.tag}> is ${elements} element${elements === 1 ? "" : "s"} with no script and is used once (${use.file}:${use.line}).`,
      suggestion: `Inline its markup at ${use.file}:${use.line} and delete the component (move any CSS to the parent). A component earns its file with reuse, behavior, or a job worth a name; keep it if a second use is coming.`,
    });
  }

  // constant-prop: a prop every use passes with the same value is not a prop. Uses printed from code are unknown,
  // so a component that also appears in a script or helper is skipped.
  const htmlFiles = new Set(docs.map((doc) => doc.file));
  for (const doc of components) {
    if (!doc.local) continue;
    const uses = [];
    for (const other of docs)
      walkElements(other.tree, (node) => {
        if (node.tag === doc.tag) uses.push({ doc: other, node });
      });
    if (uses.length < MIN_CONSTANT_PROP_USES) continue;
    if (new Set(uses.map((u) => u.doc.file)).size < 2) continue;
    const pattern = new RegExp(`<${doc.tag}(?=[\\s/>])`, "i");
    if (
      texts.some(
        ({ file, source }) => !htmlFiles.has(file) && pattern.test(source),
      )
    )
      continue;
    const [firstUse] = uses;
    for (const [attr, value] of Object.entries(firstUse.node.attrs)) {
      const prop = /^data-bascik-prop-(.+)$/.exec(attr)?.[1];
      if (!prop || value === "") continue;
      if (!uses.every((u) => u.node.attrs[attr] === value)) continue;
      let line = 1;
      walkElements(doc.tree, (node) => {
        if (line === 1 && node.attrs[attr] === "") line = node.line;
      });
      findings.push({
        rule: "constant-prop",
        level: "warn",
        file: doc.file,
        line,
        message: `<${doc.tag}> gets ${prop}="${value}" from all ${uses.length} uses (${uses.map((u) => `${u.doc.file}:${u.node.line}`).join(", ")}).`,
        suggestion: `Write "${value}" into <${doc.tag}> itself (as the text at line ${line}) and drop ${attr} from each use; a prop is for what changes between uses. If several components share the value, keep it in one data file (src/lib/site.ts).`,
      });
    }
  }

  // prop-drilling: data-bascik-attr-data-bascik-prop-<child>="<own prop>" with no use of the prop in the component.
  const forwards = new Map(); // `${tag}:${prop}` -> { child, childProp, line, file }
  for (const doc of components) {
    const uses = new Set();
    const edges = [];
    walkElements(doc.tree, (node) => {
      if (node.tag === "script" || node.tag === "style") return false;
      for (const [name, value] of Object.entries(node.attrs)) {
        const forward = /^data-bascik-attr-data-bascik-prop-(.+)$/.exec(name);
        if (forward && isComponent(node.tag)) {
          edges.push({
            prop: value.toLowerCase(),
            child: node.tag,
            childProp: forward[1],
            line: node.line,
          });
          continue;
        }
        const own = /^data-bascik-prop-(.+)$/.exec(name);
        if (own && value === "") uses.add(own[1]);
        if (/^data-bascik-attr-/.test(name)) uses.add(value.toLowerCase());
      }
    });
    for (const edge of edges)
      if (!uses.has(edge.prop))
        forwards.set(`${doc.tag}:${edge.prop}`, { ...edge, file: doc.file });
  }
  for (const [key, edge] of forwards) {
    const tag = key.slice(0, key.indexOf(":"));
    const chain = [`<${tag}>`, `<${edge.child}>`];
    const seen = new Set([key]);
    let next = `${edge.child}:${edge.childProp}`;
    let lastProp = edge.childProp;
    while (forwards.has(next) && !seen.has(next)) {
      seen.add(next);
      const step = forwards.get(next);
      chain.push(`<${step.child}>`);
      lastProp = step.childProp;
      next = `${step.child}:${step.childProp}`;
    }
    const receiver = chain[chain.length - 1];
    findings.push({
      rule: "prop-drilling",
      level: "warn",
      file: edge.file,
      line: edge.line,
      message: `<${tag}> takes the ${edge.prop} prop only to pass it down: ${chain.join(" -> ")}, where ${lastProp} is rendered.`,
      suggestion: `Let the page place ${receiver} itself, inside a slot of <${tag}> (<div data-bascik-slot></div> in the template, or a named slot), and give it the value there. If the layers are not separate jobs, merge them into one component.`,
    });
  }

  // build-once and once-reads-page
  const importRoot = resolve(
    root,
    configModule?.default?.scripts?.importRoot ?? "src",
  );
  for (const doc of docs) checkBuildScripts(doc, root, importRoot, findings);

  // js-not-ts
  for (const doc of docs) checkScripts(doc, options, findings, stats);
  if (!options.allowJs)
    checkJsFiles(root, { outDir, localRoots, pagesDir }, options, findings);

  findings.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.rule.localeCompare(b.rule),
  );
  return { findings, stats };
}

function positiveInteger(value, flag) {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) {
    const error = new Error(
      `${flag} must be a positive whole number, got "${value}".`,
    );
    error.usage = true;
    throw error;
  }
  return Number(value);
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        json: { type: "boolean", default: false },
        "allow-js": { type: "boolean", default: false },
        "max-page-lines": { type: "string" },
        "max-component-lines": { type: "string" },
        root: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    fail(`audit-components: ${error.message}. Run with --help.`, 2);
  }
  const { values } = parsed;
  if (values.help) return console.log(HELP);
  let maxPageLines;
  let maxComponentLines;
  try {
    maxPageLines = positiveInteger(
      values["max-page-lines"],
      "--max-page-lines",
    );
    maxComponentLines = positiveInteger(
      values["max-component-lines"],
      "--max-component-lines",
    );
  } catch (error) {
    fail(`audit-components: ${error.message}`, 2);
  }

  const root = values.root ? findProjectRoot(values.root) : findProjectRoot();
  let result;
  try {
    result = await auditProject(root, {
      allowJs: values["allow-js"],
      maxPageLines,
      maxComponentLines,
    });
  } catch (error) {
    fail(`audit-components: ${error.message}`, error.usage ? 2 : 1);
  }
  const { findings, stats } = result;
  if (values.json) {
    console.log(JSON.stringify({ root, findings, stats }, null, 2));
  } else {
    console.log(
      `${stats.pages} page${stats.pages === 1 ? "" : "s"}, ${stats.components} component${stats.components === 1 ? "" : "s"}; browser scripts: ${stats.tsScripts} TypeScript, ${stats.jsScripts} JavaScript.`,
    );
    for (const f of findings) {
      console.log(
        `  ${f.level.padEnd(4)}  ${f.rule}  ${f.file}:${f.line}  ${f.message}`,
      );
      console.log(`    -> ${f.suggestion}`);
    }
    if (findings.length === 0)
      console.log("No component structure problems found.");
  }
  process.exitCode = findings.some((f) => f.level === "warn") ? 1 : 0;
}

if (isMain(import.meta.url)) await main();
