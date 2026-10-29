#!/usr/bin/env node
// Test id coverage: on the Bascik target, every interactive element, form, landmark and component root needs a
// data-testid. A component root's id is the component name; its parts are <component>-<part>; repeated instances
// share their ids and tests pick one with nth() or filter({ hasText }). Reports each gap with the source file to edit.
// Dependency-free; Node.js 22.18+; needs playwright (or @playwright/test) in your project.
//
// Why: the target's own end-to-end tests need stable hooks, and class and id names are hashed in production builds.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { inPage } from "./lib/dom.mjs";
import {
  casesOf,
  finding,
  parseArgsFor,
  result,
  routesOf,
  runCli,
  withPage,
} from "./lib/checks.mjs";
import { componentUsage, pageFor } from "./repeated-sections.mjs";
import { fail, isMain } from "./lib/cli.mjs";

export const CHECK = "testid-coverage";

/** Elements that need a data-testid on the target: interactive elements, forms, dialogs and landmarks. */
export const COVERAGE_SELECTOR = [
  "button",
  "a[href]",
  'input:not([type="hidden"])',
  "select",
  "textarea",
  "summary",
  "form",
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="dialog"]',
  "dialog",
  "header",
  "nav",
  "main",
  "footer",
  "aside",
].join(", ");

const HELP = `Usage: node testid-coverage.mjs --target <url> --route <path>... [options]

Checks the target only. Every rendered interactive element, form, dialog and landmark needs a data-testid; each gap
names the source file and line to edit. Every component in src/components needs its root's data-testid set to the
component name, and each part's data-testid starts with "<component>-". Repeated instances share their ids by design.
Exits 1 on any finding.

Options:
  --target <url>        Bascik origin, such as http://localhost:8080 (a production build: bascik --server)
  --route <path>        Route to check (repeatable, required)
  --target-src <dir>    The Bascik project, holding src/pages and src/components (default .)
  --matrix <file>       Breakpoint matrix JSON (default docs/migration/breakpoints.json)
  --out <dir>           Report folder (default artifacts/checks)
  --json                Print the report as JSON
  --help                Show this message`;

const INTERACTIVE_TAGS = new Set([
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "form",
  "dialog",
  "header",
  "nav",
  "main",
  "footer",
  "aside",
]);
const INTERACTIVE_ROLES = new Set(["button", "tab", "menuitem", "dialog"]);

const TAG_RE =
  /<([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g;

/** Blanks comments, style, script and template-less blocks, keeping newlines so line numbers stay right. */
function blank(html) {
  const keepLines = (m) => m.replace(/[^\n]/g, " ");
  return html
    .replace(/<!--[\s\S]*?-->/g, keepLines)
    .replace(/<style\b[\s\S]*?<\/style>/gi, keepLines)
    .replace(/<script\b[\s\S]*?<\/script>/gi, keepLines);
}

/** The attributes of one tag as a map. */
function attrsOf(text) {
  const attrs = {};
  for (const m of text.matchAll(
    /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g,
  ))
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return attrs;
}

/** Opening tags in a source file: [{ tag, attrs, line, index }]. */
export function openingTags(html) {
  const text = blank(html);
  const tags = [];
  for (const m of text.matchAll(TAG_RE))
    tags.push({
      tag: m[1].toLowerCase(),
      attrs: attrsOf(m[2] ?? ""),
      line: text.slice(0, m.index).split("\n").length,
      index: m.index,
    });
  return tags;
}

const needsId = (t) =>
  (INTERACTIVE_TAGS.has(t.tag) &&
    !(t.tag === "input" && t.attrs.type === "hidden")) ||
  (t.tag === "a" && "href" in t.attrs) ||
  INTERACTIVE_ROLES.has(t.attrs.role);

/**
 * Audits one component's source: the root's data-testid must be the component name (component-root), every part with
 * a data-testid must start with "<name>-" (part-name), and every interactive part needs one (missing).
 */
export function auditComponent(name, html, file) {
  const findings = [];
  const tags = openingTags(html);
  const root = tags[0];
  if (!root) return findings;
  const rootId = root.attrs["data-testid"];
  if (rootId !== name)
    findings.push(
      finding(
        CHECK,
        "component-root",
        `${file}:${root.line}: the root <${root.tag}> of ${name} needs data-testid="${name}"${rootId ? ` (it has "${rootId}")` : ""}`,
        { file, line: root.line, component: name },
      ),
    );
  for (const t of tags.slice(1)) {
    const id = t.attrs["data-testid"];
    if (id !== undefined && !id.startsWith(`${name}-`))
      findings.push(
        finding(
          CHECK,
          "part-name",
          `${file}:${t.line}: <${t.tag} data-testid="${id}"> is a part of ${name}; name it ${name}-<part>, such as "${name}-${id.replace(new RegExp(`^${name}-?`), "") || "part"}"`,
          { file, line: t.line, component: name },
        ),
      );
    else if (id === undefined && needsId(t))
      findings.push(
        finding(
          CHECK,
          "missing",
          `${file}:${t.line}: <${t.tag}> in ${name} needs a data-testid such as "${name}-${t.tag}"`,
          { file, line: t.line, component: name },
        ),
      );
  }
  return findings;
}

const posix = (p) => p.split(sep).join("/");

/** The components under src/components: [{ name, file }] with file relative to root. */
export function components(root) {
  const dir = join(root, "src", "components");
  if (!existsSync(dir) || !statSync(dir).isDirectory())
    throw new Error(
      `${posix(join(root, "src/components"))} not found: pass the Bascik project with --target-src (it holds src/components)`,
    );
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const file = join(dir, entry.name, `${entry.name}.html`);
      if (existsSync(file))
        out.push({ name: entry.name, file: posix(relative(root, file)) });
    } else if (entry.name.endsWith(".html"))
      out.push({
        name: entry.name.replace(/\.html$/, ""),
        file: posix(relative(root, join(dir, entry.name))),
      });
  }
  return out;
}

/** Audits every component under root/src/components. */
export function auditSource(root) {
  return components(root).flatMap(({ name, file }) =>
    auditComponent(name, readFileSync(join(root, file), "utf8"), file),
  );
}

/** In the page: every element that needs a data-testid and has none, with what finds it in the source. */
function collectGaps(arg) {
  const out = [];
  for (const el of document.querySelectorAll(arg.selector)) {
    if (el.hasAttribute("data-testid")) continue;
    if (el.closest("template")) continue;
    out.push({
      tag: el.localName,
      text: norm(el.textContent).slice(0, 60),
      name: accName(el).slice(0, 60),
      attrs: Object.fromEntries(
        ["href", "type", "name", "id", "role", "action", "aria-label"]
          .filter((a) => el.hasAttribute(a))
          .map((a) => [a, el.getAttribute(a)]),
      ),
    });
  }
  return out;
}

/** The text right after an opening tag up to the next tag, for matching a rendered element to its source. */
const textAfter = (html, tag) => {
  const rest = html.slice(tag.index);
  const close = rest.indexOf(">");
  return (rest.slice(close + 1).split("<")[0] ?? "")
    .replace(/\s+/g, " ")
    .trim();
};

/**
 * The source file and line of a rendered gap: the best-scoring opening tag without a data-testid among the
 * components and the route's page, by tag, attributes and text. Falls back to the route's page.
 */
export function locate(gap, files, page) {
  let best = null;
  let sameTag = 0;
  for (const { file, html, tags } of files)
    for (const t of tags) {
      if (t.tag !== gap.tag || "data-testid" in t.attrs) continue;
      sameTag++;
      let score = 1;
      let evidence = false;
      for (const [k, v] of Object.entries(gap.attrs))
        if (t.attrs[k] === v) {
          score += 2;
          evidence = true;
        } else if (k in t.attrs) score -= 2;
      const text = textAfter(html, t);
      if (text && gap.text.startsWith(text)) {
        score += 3;
        evidence = true;
      }
      if (file === page) score += 0.5;
      if (!best || score > best.score)
        best = { file, line: t.line, score, evidence };
    }
  // A file and line only for a real match: a shared attribute or text, or the only tag of its kind. Otherwise the
  // element likely comes from a script, a layout or data, and a guessed line would send the fix to the wrong element.
  if (best && (best.evidence || sameTag === 1))
    return { file: best.file, line: best.line };
  return { file: page, line: undefined, unmatched: true };
}

/** Resolves to { check, ok, findings }. Options: target, routes, cases, targetSrc. */
export async function runCheck(browser, options) {
  const root = options.targetSrc ?? ".";
  const findings = auditSource(root);
  const usage = componentUsage(root);
  const { pages } = usage;
  const sources = [
    ...components(root).map(({ file }) => file),
    ...Object.keys(pages),
  ].map((file) => {
    const html = readFileSync(join(root, file), "utf8");
    return { file, html: blank(html), tags: openingTags(html) };
  });
  const seen = new Set();
  for (const route of routesOf(options)) {
    const page = pageFor(usage, route) ?? "src/pages";
    for (const c of casesOf(options)) {
      const gaps = await withPage(browser, options.target, route, c, (p) =>
        inPage(p, collectGaps, { selector: COVERAGE_SELECTOR }),
      );
      for (const gap of gaps) {
        const at = locate(
          gap,
          sources.filter(
            (s) => s.file === page || s.file.startsWith("src/components/"),
          ),
          page,
        );
        const where = at.line ? `${at.file}:${at.line}` : at.file;
        const hint = at.unmatched
          ? `no tag in ${at.file} or src/components matches it (it may come from a script or a layout); find where it is rendered and add one there`
          : `add one in ${where}`;
        const label = `<${gap.tag}>${gap.name || gap.text ? ` "${gap.name || gap.text}"` : ""}`;
        const id = `${route}|${where}|${label}`;
        if (seen.has(id)) continue;
        seen.add(id);
        findings.push(
          finding(
            CHECK,
            "missing",
            `${label} on ${route} has no data-testid; ${hint}`,
            { file: at.file, line: at.line, route, width: c.width },
          ),
        );
      }
    }
  }
  return result(CHECK, findings);
}

export function parseCliArgs(argv) {
  const args = parseArgsFor(argv, {
    extra: { "target-src": { type: "string" } },
    need: ["target", "route"],
  });
  if (args.help) return args;
  const { "target-src": targetSrc, ...rest } = args;
  return { ...rest, targetSrc: targetSrc ?? "." };
}

if (isMain(import.meta.url)) {
  try {
    await runCli({ check: CHECK, help: HELP, parseCliArgs, runCheck });
  } catch (error) {
    fail(`${CHECK}: ${error.message}`);
  }
}
