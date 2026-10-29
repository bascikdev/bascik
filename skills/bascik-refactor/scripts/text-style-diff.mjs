#!/usr/bin/env node
// Text style diff: for every visible text element, links included, compare color, weight, style, family, size, line
// height, letter spacing, decoration (with its offset and thickness), transform, text fill and gradient, shadow and the
// focus ring (outline, box-shadow) at rest, under :hover and under :focus-visible (forced with CDP
// CSS.forcePseudoState), matched by tag plus normalized text.
// Dependency-free; Node.js 22.18+; needs playwright (or @playwright/test) in your project.
//
// Why: some links had the wrong color or the wrong font weight, which a geometry diff never shows, and a hover color
// only shows when something hovers.
import { inPage } from "./lib/dom.mjs";
import {
  casesOf,
  finding,
  masksOf,
  parseArgsFor,
  result,
  routesOf,
  settleOf,
  runCli,
  withPage,
} from "./lib/checks.mjs";
import { fail, isMain } from "./lib/cli.mjs";

export const CHECK = "text-style-diff";

const HELP = `Usage: node text-style-diff.mjs --prod <url> --target <url> --route <path>... [options]

Compares the text styles of every visible element with its own text (headings, paragraphs, links, buttons, labels,
list items), matched by tag plus normalized text (a repeated text is matched per copy, in document order: "Learn
more", "Learn more #2"; a <time datetime> by its datetime, so a relative date that ticked over still matches), at
rest and with :hover and :focus-visible forced through CDP CSS.forcePseudoState on the element and every ancestor, so
a link's or a card's :hover that styles the text counts. The properties: color, font weight, style, family and size,
line height, letter spacing, text decoration with its thickness and underline offset, text transform and shadow, the
text fill and a gradient painted through background-clip: text, and the focus ring (outline style, width, color and
offset, box-shadow). One finding per element, state and property; an element missing on the target is a finding too. Exits 1 on any finding.

Options:
  --prod <url>        Live production origin
  --target <url>      Bascik origin, such as http://localhost:8080 (a production build: bascik --server)
  --route <path>      Route to compare (repeatable, required)
  --mask <selector>   A documented dynamic region to skip, such as a ticking counter (repeatable; log it in the
                      decisions ledger)
  --settle-ms <ms>    Least time after navigation before measuring (default 5000)
  --matrix <file>     Breakpoint matrix JSON (default docs/migration/breakpoints.json)
  --out <dir>         Report folder (default artifacts/checks)
  --json              Print the report as JSON
  --help              Show this message`;

export const TEXT_PROPS = Object.freeze([
  "color",
  "font-weight",
  "font-style",
  "font-family",
  "font-size",
  "line-height",
  "letter-spacing",
  "text-decoration",
  "text-decoration-thickness",
  "text-underline-offset",
  "text-transform",
  "text-shadow",
  "-webkit-text-fill-color",
  // Read only where background-clip is text (a gradient headline); "n/a" elsewhere.
  "background-image",
  // The focus ring: outline-color and outline-offset count only while an outline is drawn.
  "outline-style",
  "outline-width",
  "outline-color",
  "outline-offset",
  "box-shadow",
]);

export const STATES = Object.freeze(["rest", "hover", "focus-visible"]);

/** Values that read differently but render the same: font-family quoting, case and spacing. */
function canonical(property, value) {
  if (value === undefined) return value;
  if (property === "font-family")
    return String(value)
      .split(",")
      .map((f) =>
        f
          .trim()
          .replace(/^["']|["']$/g, "")
          .toLowerCase(),
      )
      .join(", ");
  return String(value).trim();
}

/**
 * Compares { key: { rest, hover, "focus-visible" } } on both sides. One "style" finding per element, state and
 * property that differs, with both values; one "missing" finding per production element the target lacks.
 */
export function diffTextStyles(prod, target) {
  const findings = [];
  for (const [key, states] of Object.entries(prod)) {
    const other = target[key];
    if (!other) {
      findings.push(
        finding(
          CHECK,
          "missing",
          `${key} is visible text in production, but the target has no ${key.split(":")[0]} with that text`,
          { key },
        ),
      );
      continue;
    }
    for (const state of STATES) {
      const a = states[state] ?? {};
      const b = other[state] ?? {};
      for (const property of TEXT_PROPS) {
        if (
          canonical(property, a[property]) === canonical(property, b[property])
        )
          continue;
        findings.push(
          finding(
            CHECK,
            "style",
            `${key} (${state}): ${property} is "${a[property]}" in production and "${b[property]}" on the target`,
            { key, state, property, prod: a[property], target: b[property] },
          ),
        );
      }
    }
  }
  return findings;
}

/**
 * In the page: every visible element with its own text, keyed by tag and text, with a selector to force states on and
 * the selectors of its ancestors (a link's :hover, or a card's, styles the text inside). The second element with the
 * same tag and text is "#2", the third "#3", so a repeated "Learn more" is compared once per copy, in document order.
 */
function textElements(arg) {
  const out = [];
  const seen = new Map();
  for (const el of document.body.querySelectorAll("*")) {
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(tagOf(el)))
      continue;
    const own = [...el.childNodes].some(
      (n) => n.nodeType === 3 && norm(n.textContent),
    );
    if (!own || !isRendered(el) || isMasked(el, arg.masks)) continue;
    const base = textKey(el);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const ancestors = [];
    for (
      let a = el.parentElement;
      a && a !== document.documentElement;
      a = a.parentElement
    )
      ancestors.push(selectorOf(a));
    out.push({
      key: n > 1 ? `${base} #${n}` : base,
      selector: selectorOf(el),
      ancestors,
    });
  }
  return out;
}

/**
 * In the page: the text properties of the element at each selector. background-image counts only on text it paints
 * (background-clip: text), and outline-color and outline-offset only while an outline is drawn; elsewhere they read
 * "n/a", so a button's own background or the color an undrawn outline would have is not a text style.
 */
function readStyles(arg) {
  const out = {};
  for (const { key, selector } of arg.items) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const cs = getComputedStyle(el);
    const clip =
      cs.getPropertyValue("background-clip") === "text" ||
      cs.getPropertyValue("-webkit-background-clip") === "text";
    const outline = cs.getPropertyValue("outline-style") !== "none";
    out[key] = Object.fromEntries(
      arg.props.map((p) => {
        if (p === "background-image" && !clip) return [p, "n/a"];
        if ((p === "outline-color" || p === "outline-offset") && !outline)
          return [p, "n/a"];
        return [p, cs.getPropertyValue(p)];
      }),
    );
  }
  return out;
}

/**
 * The styles `props` of each item ({ key, selector, ancestors }) of a loaded page in every state:
 * { key: { rest, hover, "focus-visible" } }. Pseudo-states are forced on each element and its ancestors through CDP,
 * so no mouse or keyboard is involved and nothing else on the page changes (a menu that is open stays open).
 */
export async function forcedStyles(page, items, props) {
  const out = {};
  const rest = await inPage(page, readStyles, { items, props });
  for (const [key, styles] of Object.entries(rest)) out[key] = { rest: styles };
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
    const nodeIds = new Map();
    const nodeOf = async (selector) => {
      if (!nodeIds.has(selector))
        nodeIds.set(
          selector,
          (
            await cdp
              .send("DOM.querySelector", { nodeId: root.nodeId, selector })
              .catch(() => ({ nodeId: 0 }))
          ).nodeId,
        );
      return nodeIds.get(selector);
    };
    const nodes = [];
    for (const item of items) {
      const nodeId = await nodeOf(item.selector);
      if (nodeId) nodes.push({ item, nodeId });
    }
    // The state is forced on each text element and on every ancestor: Chromium does not carry a forced :hover up the
    // tree the way a pointer does, and a:hover on a link around a span, or .card:hover a, styles the text from above.
    const forced = new Set(nodes.map((n) => n.nodeId));
    for (const { item } of nodes)
      for (const selector of item.ancestors ?? []) {
        const nodeId = await nodeOf(selector);
        if (nodeId) forced.add(nodeId);
      }
    for (const state of ["hover", "focus-visible"]) {
      for (const nodeId of forced)
        await cdp.send("CSS.forcePseudoState", {
          nodeId,
          forcedPseudoClasses: [state],
        });
      const styles = await inPage(page, readStyles, {
        items: nodes.map((n) => n.item),
        props,
      });
      for (const [key, s] of Object.entries(styles))
        if (out[key]) out[key][state] = s;
      for (const nodeId of forced)
        await cdp.send("CSS.forcePseudoState", {
          nodeId,
          forcedPseudoClasses: [],
        });
    }
  } finally {
    await cdp.detach().catch(() => {});
  }
  return out;
}

/** The text styles of one loaded page in every state: { key: { rest, hover, "focus-visible" } } (see forcedStyles). */
export async function captureTextStyles(page, masks = []) {
  const items = await inPage(page, textElements, { masks });
  return forcedStyles(page, items, TEXT_PROPS);
}

/** Resolves to { check, ok, findings }. Options: prod, target, routes, cases, masks. */
export async function runCheck(browser, options) {
  const masks = masksOf(options);
  const findings = [];
  for (const route of routesOf(options))
    for (const c of casesOf(options)) {
      const capture = (origin) =>
        withPage(
          browser,
          origin,
          route,
          c,
          (page) => captureTextStyles(page, masks),
          masks,
          settleOf(options),
        );
      const [prod, target] = await Promise.all([
        capture(options.prod),
        capture(options.target),
      ]);
      for (const f of diffTextStyles(prod, target))
        findings.push({ ...f, route, width: c.width });
    }
  return result(CHECK, findings);
}

export function parseCliArgs(argv) {
  return parseArgsFor(argv);
}

if (isMain(import.meta.url)) {
  try {
    await runCli({ check: CHECK, help: HELP, parseCliArgs, runCheck });
  } catch (error) {
    fail(`${CHECK}: ${error.message}`);
  }
}
