#!/usr/bin/env node
// Alignment diff: per matrix case, compare text-align, the rendered line count and the text's left and right offset
// from its containing block and from the page edges for every heading, paragraph, button, link, list item, label,
// caption and cell, and flag only the cases where they differ, naming the width. Dependency-free; Node.js 22.18+; needs playwright (or @playwright/test) in your project.
//
// Why: text was misaligned at certain breakpoints only, and one screenshot per route never showed it.
import { inPage } from "./lib/dom.mjs";
import {
  casesOf,
  finding,
  masksOf,
  parseArgsFor,
  pixels,
  result,
  routesOf,
  runCli,
  withPage,
} from "./lib/checks.mjs";
import { fail, isMain } from "./lib/cli.mjs";

export const CHECK = "alignment-diff";
export const DEFAULT_TOLERANCE = 2;
export const SELECTOR =
  'h1, h2, h3, h4, h5, h6, p, button, [role="button"], a, li, label, figcaption, td, th, dt, dd, blockquote';

const HELP = `Usage: node alignment-diff.mjs --prod <url> --target <url> --route <path>... [options]

For every visible heading, paragraph, button, link, list item, label, caption and table cell, matched by tag plus
normalized text (a repeated text per copy, in document order: "Specs", "Specs #2"), compares at each matrix case:
text-align (start and left are the same in a left-to-right page), the rendered line count, the left and right offset
of the rendered text from the element's containing block, and its left and right offset from the page edges (a
wrapper that lost its centering moves all its text together, so only the page offsets show it). Findings name the
width where they differ, so a breakpoint-only misalignment is located. Exits 1 on any finding.

Options:
  --prod <url>          Live production origin
  --target <url>        Bascik origin, such as http://localhost:8080 (a production build: bascik --server)
  --route <path>        Route to compare (repeatable, required)
  --tolerance <px>      Allowed offset difference in CSS pixels (default 2)
  --mask <selector>     A documented dynamic region to skip, such as a carousel (repeatable)
  --matrix <file>       Breakpoint matrix JSON (default docs/migration/breakpoints.json)
  --out <dir>           Report folder (default artifacts/checks)
  --json                Print the report as JSON
  --help                Show this message`;

const ALIGN = {
  start: "left",
  end: "right",
  "-webkit-left": "left",
  "-webkit-right": "right",
  "-webkit-center": "center",
};
const align = (v) => ALIGN[v] ?? v;

/**
 * Compares cases ([{ width, height, nodes: { key: { textAlign, lines, left, right, pageLeft, pageRight } } }]) on both
 * sides. Kinds: text-align, lines, left, right (from the container), page-left and page-right (from the page edges,
 * only when the container offsets match: the container moved) and missing, each with the width. A case production has and the target lacks is
 * an error, not a pass.
 */
export function diffAlignment(
  prod,
  target,
  { tolerance = DEFAULT_TOLERANCE } = {},
) {
  const findings = [];
  for (const p of prod) {
    const t =
      target.find((c) => c.width === p.width && c.height === p.height) ??
      target.find((c) => c.width === p.width);
    if (!t)
      throw new Error(
        `alignment-diff: the target has no capture for the ${p.width}x${p.height} case`,
      );
    const at = (key, kind, message, a, b) =>
      findings.push(
        finding(CHECK, kind, `${key} at ${p.width} px: ${message}`, {
          key,
          width: p.width,
          prod: a,
          target: b,
        }),
      );
    for (const [key, a] of Object.entries(p.nodes)) {
      const b = t.nodes[key];
      if (!b) {
        at(key, "missing", "in production, not on the target");
        continue;
      }
      if (align(a.textAlign) !== align(b.textAlign))
        at(
          key,
          "text-align",
          `text-align is ${a.textAlign} in production and ${b.textAlign} on the target`,
          a.textAlign,
          b.textAlign,
        );
      if (a.lines !== b.lines)
        at(
          key,
          "lines",
          `${a.lines} line(s) in production and ${b.lines} on the target`,
          a.lines,
          b.lines,
        );
      const edge = { left: "starts", right: "ends" };
      let container = false;
      for (const side of ["left", "right"])
        if (Math.abs(a[side] - b[side]) > tolerance) {
          container = true;
          at(
            key,
            side,
            `the text ${edge[side]} ${a[side]} px from the ${side} of its container in production and ${b[side]} px on the target`,
            a[side],
            b[side],
          );
        }
      // The container itself moved (a wrapper lost margin: 0 auto at one width): the text keeps its offset from the
      // container, so only its offset from the page edge shows it.
      if (!container)
        for (const side of ["left", "right"]) {
          const prop = side === "left" ? "pageLeft" : "pageRight";
          if (typeof a[prop] !== "number" || typeof b[prop] !== "number")
            continue;
          if (Math.abs(a[prop] - b[prop]) > tolerance)
            at(
              key,
              `page-${side}`,
              `the text ${edge[side]} ${a[prop]} px from the ${side} edge of the page in production and ${b[prop]} px on the target (its container moved)`,
              a[prop],
              b[prop],
            );
        }
    }
  }
  return findings;
}

/** In the page: alignment facts for every matching element. */
function measureAlignment(arg) {
  const nodes = {};
  const seen = new Map();
  const page = document.documentElement.clientWidth;
  for (const el of document.querySelectorAll(arg.selector)) {
    if (!isRendered(el) || isMasked(el, arg.masks)) continue;
    const text = norm(el.textContent);
    if (!text) continue;
    const base = textKey(el);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const key = n > 1 ? `${base} #${n}` : base;
    const rects = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (!norm(t.textContent)) continue;
      const range = document.createRange();
      range.selectNodeContents(t);
      for (const r of range.getClientRects())
        if (r.width > 0 && r.height > 0) rects.push(r);
    }
    if (!rects.length) continue;
    const tops = [];
    for (const r of rects.sort((a, b) => a.top - b.top))
      if (!tops.some((t) => Math.abs(t - r.top) < r.height / 2))
        tops.push(r.top);
    const left = Math.min(...rects.map((r) => r.left));
    const right = Math.max(...rects.map((r) => r.right));
    const container = (el.parentElement ?? el).getBoundingClientRect();
    const round = (v) => Math.round(v * 10) / 10;
    nodes[key] = {
      textAlign: getComputedStyle(el).textAlign,
      lines: tops.length,
      left: round(left - container.left),
      right: round(container.right - right),
      pageLeft: round(left + scrollX),
      pageRight: round(page - right - scrollX),
    };
  }
  return nodes;
}

/** Resolves to { check, ok, findings }. Options: prod, target, routes, cases, tolerance. */
export async function runCheck(browser, options) {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const masks = masksOf(options);
  const findings = [];
  for (const route of routesOf(options)) {
    const prod = [];
    const target = [];
    for (const c of casesOf(options)) {
      const measure = (origin) =>
        withPage(
          browser,
          origin,
          route,
          c,
          (page) =>
            inPage(page, measureAlignment, { selector: SELECTOR, masks }),
          masks,
        );
      const [p, t] = await Promise.all([
        measure(options.prod),
        measure(options.target),
      ]);
      prod.push({ width: c.width, height: c.height, nodes: p });
      target.push({ width: c.width, height: c.height, nodes: t });
    }
    for (const f of diffAlignment(prod, target, { tolerance }))
      findings.push({ ...f, route });
  }
  return result(CHECK, findings);
}

export function parseCliArgs(argv) {
  const args = parseArgsFor(argv, {
    extra: { tolerance: { type: "string" } },
  });
  if (args.help) return args;
  return {
    ...args,
    tolerance: pixels("--tolerance", args.tolerance, DEFAULT_TOLERANCE),
  };
}

if (isMain(import.meta.url)) {
  try {
    await runCli({ check: CHECK, help: HELP, parseCliArgs, runCheck });
  } catch (error) {
    fail(`${CHECK}: ${error.message}`);
  }
}
