#!/usr/bin/env node
// Test hook carryover: collect every test hook (data-testid, data-test, data-test-id, data-cy, data-qa) in production's
// rendered DOM and in the legacy source, and require each one on the target with the same attribute name and value,
// on the same element (matched by tag, accessible name, text and position). Reports every missing or moved hook.
// Dependency-free; Node.js 22.18+; needs playwright (or @playwright/test) in your project.
//
// Why: the existing end-to-end suite finds elements by these hooks. A hook dropped, moved to another element or
// renamed in the refactor breaks those tests silently, or makes them pass against the wrong element.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { inPage } from "./lib/dom.mjs";
import {
  casesOf,
  finding,
  masksOf,
  normalize,
  parseArgsFor,
  result,
  routesOf,
  settleOf,
  runCli,
  withPage,
} from "./lib/checks.mjs";
import { fail, isMain } from "./lib/cli.mjs";

export const CHECK = "testid-carryover";

/** The attributes end-to-end suites use as test hooks. */
export const HOOK_ATTRS = Object.freeze([
  "data-testid",
  "data-test-id",
  "data-test",
  "data-cy",
  "data-qa",
]);

const HELP = `Usage: node testid-carryover.mjs --prod <url> --target <url> --route <path>... --legacy-src <dir> [options]

Collects the test hooks (${HOOK_ATTRS.join(", ")}) in production's rendered DOM, hidden elements included, and requires
each on the target with the same attribute name and value on the same element (tag, accessible name, text and
position among identical elements), and on no more elements than in production (a hook copied onto a wrapper breaks
a strict getByTestId locator). Static hooks in the legacy source that the first render never shows (a box that
appears on scroll, a modal) must be somewhere on the target's rendered pages or in its source, on the same kind of
element (the Close button's hook on a <button>, not on the modal's heading). Dynamic values (data-testid={id}) are left
to the rendered comparison. Exits 1 on any finding.

Options:
  --prod <url>          Live production origin
  --target <url>        Bascik origin, such as http://localhost:8080 (a production build: bascik --server)
  --route <path>        Route to compare (repeatable, required)
  --legacy-src <dir>    The legacy repository (required: without it the source half would be skipped)
  --target-src <dir>    The Bascik project (default .)
  --settle-ms <ms>      Least time after navigation before measuring (default 5000)
  --matrix <file>       Breakpoint matrix JSON (default docs/migration/breakpoints.json)
  --out <dir>           Report folder (default artifacts/checks)
  --json                Print the report as JSON
  --help                Show this message`;

const SOURCE_EXTENSIONS =
  /\.(?:jsx?|tsx?|mjs|cjs|html?|vue|svelte|astro|hbs|handlebars|ejs|erb|php|njk|liquid|twig|pug|mdx)$/;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  ".cache",
  ".bascik",
]);

const HOOK_RE =
  /(?<![\w-])(data-(?:testid|test-id|test|cy|qa))(?![\w-])\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(?:"([^"]*)"|'([^']*)'|`([^`$]*)`)\s*\}|(\{))/g;

/**
 * The test hooks in one source file's text: [{ attr, value, dynamic, file, line, tag, text }]. Static values are read
 * from "x", 'x', {"x"}, {'x'} and {`x`}; anything computed ({id}, {`plan-${id}`}) is kept with value null and dynamic
 * true. `tag` is the element the attribute sits on as written (a JSX component keeps its capital: Button), and `text`
 * the text right after its opening tag, when there is any.
 */
export function collectSourceHooks(text, file) {
  const hooks = [];
  for (const m of text.matchAll(HOOK_RE)) {
    const value = m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6];
    const line = text.slice(0, m.index).split("\n").length;
    const open = text.slice(0, m.index).lastIndexOf("<");
    const tag =
      open >= 0
        ? (/^<([A-Za-z][\w.:-]*)/.exec(text.slice(open))?.[1] ?? null)
        : null;
    const close = text.indexOf(">", m.index);
    const after =
      close >= 0 ? /^([^<{]*)/.exec(text.slice(close + 1))?.[1] : "";
    const element = { tag, text: normalize(after ?? "") };
    hooks.push(
      value === undefined
        ? { attr: m[1], value: null, dynamic: true, file, line, ...element }
        : { attr: m[1], value, dynamic: false, file, line, ...element },
    );
  }
  return hooks;
}

/** A plain HTML element name as written in a source (button, h2), not a component (Button, promo-card), or null. */
const htmlTag = (tag) =>
  tag && /^[a-z][a-z0-9]*$/.test(tag) ? tag.toLowerCase() : null;

/** Every source file under `root` (skipping dependencies and build output), with paths relative to `root`. */
function sourceFiles(root, dir = root) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(root, full));
    else if (SOURCE_EXTENSIONS.test(entry.name)) out.push(full);
  }
  return out;
}

/** The hooks in every source file under `root`. */
export function scanSource(root) {
  if (!existsSync(root)) throw new Error(`${root}: source folder not found`);
  return sourceFiles(root).flatMap((file) =>
    collectSourceHooks(
      readFileSync(file, "utf8"),
      relative(root, file).split(sep).join("/"),
    ),
  );
}

const describe = (a) =>
  `${a.tag}${a.name || a.text ? ` "${a.name || a.text}"` : ""}${a.index ? ` (#${a.index + 1})` : ""}`;
const sameAnchor = (a, b) =>
  a.tag === b.tag &&
  normalize(a.name) === normalize(b.name) &&
  normalize(a.text) === normalize(b.text) &&
  (a.index ?? 0) === (b.index ?? 0);

/**
 * Compares production's rendered hooks with the target's ([{ attr, value, anchor }]). A hook the target lacks under
 * the same attribute name is missing (a hook kept under another name is still missing: tests query the attribute);
 * a hook on another element is moved.
 */
export function diffHooks(prod, target) {
  const findings = [];
  const used = new Set();
  for (const p of prod) {
    const hook = `${p.attr}="${p.value}"`;
    const same = target
      .map((t, i) => ({ t, i }))
      .filter(
        ({ t, i }) => !used.has(i) && t.attr === p.attr && t.value === p.value,
      );
    if (!same.length) {
      const renamed = target.find((t) => t.value === p.value);
      findings.push(
        finding(
          CHECK,
          "missing",
          `${hook} on ${describe(p.anchor)} is missing on the target${renamed ? ` (the target has ${renamed.attr}="${renamed.value}" instead; tests query ${p.attr})` : ""}`,
          { attr: p.attr, value: p.value, anchor: describe(p.anchor) },
        ),
      );
      continue;
    }
    const exact = same.find(({ t }) => sameAnchor(t.anchor, p.anchor));
    const pick = exact ?? same[0];
    used.add(pick.i);
    if (!exact)
      findings.push(
        finding(
          CHECK,
          "moved",
          `${hook} is on ${describe(p.anchor)} in production but on ${describe(pick.t.anchor)} on the target`,
          { attr: p.attr, value: p.value, anchor: describe(p.anchor) },
        ),
      );
  }
  // A hook on more elements than in production: getByTestId is strict, so the suite's fill() or click() fails.
  const count = (list) => {
    const n = new Map();
    for (const h of list) {
      const id = `${h.attr}="${h.value}"`;
      n.set(id, (n.get(id) ?? 0) + 1);
    }
    return n;
  };
  const prodCount = count(prod);
  for (const [id, n] of count(target)) {
    const m = prodCount.get(id) ?? 0;
    if (!m || n <= m) continue;
    const on = target
      .filter((t) => `${t.attr}="${t.value}"` === id)
      .map((t) => describe(t.anchor));
    findings.push(
      finding(
        CHECK,
        "duplicated",
        `${id} is on ${n} elements on the target (${on.join(", ")}) and on ${m} in production: a strict locator such as getByTestId resolves to ${n} elements and the test fails`,
        { hook: id, prod: m, target: n },
      ),
    );
  }
  return findings;
}

/**
 * Static legacy source hooks found nowhere on the target ([{ attr, value }] from its rendered pages and its source):
 * missing, located at the legacy file and line; found only on another kind of HTML element than the legacy source
 * puts it on: wrong-element. Dynamic hooks are skipped.
 */
export function diffSourceHooks(legacy, target) {
  const have = new Set(target.map((t) => `${t.attr}=${t.value}`));
  const findings = [];
  const seen = new Set();
  for (const h of legacy) {
    if (h.dynamic || h.value === null) continue;
    const id = `${h.attr}=${h.value}`;
    if (seen.has(id)) continue;
    if (have.has(id)) {
      // The same hook on another kind of element: the test that clicks the legacy <button> now clicks a heading.
      const want = htmlTag(h.tag);
      const there = target
        .filter((t) => `${t.attr}=${t.value}` === id)
        .map((t) => ({
          tag: htmlTag(t.anchor?.tag?.toLowerCase() ?? t.tag),
          text: t.anchor?.text ?? t.text ?? "",
        }));
      if (
        want &&
        there.length &&
        there.every((t) => t.tag) &&
        !there.some((t) => t.tag === want)
      ) {
        seen.add(id);
        findings.push(
          finding(
            CHECK,
            "wrong-element",
            `${h.attr}="${h.value}" is on a <${want}>${h.text ? ` ("${h.text}")` : ""} in the legacy source (${h.file}:${h.line}), but on ${there.map((t) => `<${t.tag}>${t.text ? ` ("${t.text}")` : ""}`).join(", ")} on the target`,
            { attr: h.attr, value: h.value, file: h.file, line: h.line },
          ),
        );
      }
      continue;
    }
    seen.add(id);
    findings.push(
      finding(
        CHECK,
        "missing",
        `${h.attr}="${h.value}" from the legacy source (${h.file}:${h.line}) is not on the target's pages or in its source`,
        { attr: h.attr, value: h.value, file: h.file, line: h.line },
      ),
    );
  }
  return findings;
}

/** In the page: every element with a hook attribute, with its anchor and position among identical elements. */
function collectHooks(arg) {
  const out = [];
  const counts = new Map();
  const selector = arg.attrs.map((a) => `[${a}]`).join(", ");
  for (const el of document.querySelectorAll(selector)) {
    const anchor = {
      tag: tagOf(el),
      role: roleOf(el),
      name: accName(el).slice(0, 70),
      text: norm(el.textContent).slice(0, 70),
    };
    const id = `${anchor.tag}|${anchor.name}|${anchor.text}`;
    anchor.index = counts.get(id) ?? 0;
    counts.set(id, anchor.index + 1);
    for (const attr of arg.attrs)
      if (el.hasAttribute(attr))
        out.push({ attr, value: el.getAttribute(attr), anchor });
  }
  return out;
}

/** Resolves to { check, ok, findings }. Options: prod, target, routes, cases, legacySrc, targetSrc. */
export async function runCheck(browser, options) {
  if (!options.legacySrc)
    throw new Error(
      "testid-carryover needs legacySrc (--legacy-src): the legacy source's hooks are half of the check",
    );
  const legacy = scanSource(options.legacySrc);
  const targetSource = existsSync(join(options.targetSrc ?? ".", "src"))
    ? scanSource(join(options.targetSrc ?? ".", "src"))
    : [];
  const findings = [];
  const seen = new Set();
  const add = (f) => {
    const id = `${f.kind}|${f.message}`;
    if (seen.has(id)) return;
    seen.add(id);
    findings.push(f);
  };
  const prodRendered = new Set();
  const targetRendered = [];
  for (const route of routesOf(options))
    for (const c of casesOf(options)) {
      const hooks = (origin) =>
        withPage(
          browser,
          origin,
          route,
          c,
          (page) => inPage(page, collectHooks, { attrs: HOOK_ATTRS }),
          masksOf(options),
          settleOf(options),
        );
      const prod = await hooks(options.prod);
      const target = await hooks(options.target);
      for (const h of prod) prodRendered.add(`${h.attr}=${h.value}`);
      targetRendered.push(...target);
      for (const f of diffHooks(prod, target))
        add({ ...f, route, width: c.width });
    }
  // Hooks production renders are compared above, element by element; the source half covers the rest.
  const unrendered = legacy.filter(
    (h) => !prodRendered.has(`${h.attr}=${h.value}`),
  );
  for (const f of diffSourceHooks(unrendered, [
    ...targetRendered,
    ...targetSource,
  ]))
    add(f);
  return result(CHECK, findings);
}

export function parseCliArgs(argv) {
  const args = parseArgsFor(argv, {
    extra: {
      "legacy-src": { type: "string" },
      "target-src": { type: "string" },
    },
  });
  if (args.help) return args;
  const { "legacy-src": legacySrc, "target-src": targetSrc, ...rest } = args;
  if (!legacySrc)
    throw new Error(
      "--legacy-src <dir> is required: the legacy source's test hooks are half of the check",
    );
  return { ...rest, legacySrc, targetSrc: targetSrc ?? "." };
}

if (isMain(import.meta.url)) {
  try {
    await runCli({ check: CHECK, help: HELP, parseCliArgs, runCheck });
  } catch (error) {
    fail(`${CHECK}: ${error.message}`);
  }
}
