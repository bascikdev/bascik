#!/usr/bin/env node
// Geometry diff: open production and the Bascik target side by side at every breakpoint matrix width and compare
// the box of every visible heading, paragraph, button and link, matched by tag plus the text a reader sees.
// Dependency-free; Node.js 22.22+; needs playwright (or @playwright/test) in your project. Read-only: it only loads
// pages and writes the optional --out report.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadMatrix } from "./lib/matrix.mjs";
import {
  POLITE_HELP,
  POLITE_OPTIONS,
  politeBrowser,
  politeFlags,
} from "./lib/capture.mjs";
import {
  byKeyMatch,
  DEFAULT_SETTLE_MS,
  pixels,
  validateMask,
  withPage,
} from "./lib/checks.mjs";
import { loadPlaywright } from "./lib/project-deps.mjs";
import { fail, isMain } from "./lib/cli.mjs";

export { loadMatrix };

const HELP = `Usage: node geometry-diff.mjs --prod <url> --target <url> [--route <path>]... [--matrix <file>]
                              [--thresholds dx,dy,dw] [--mask <selector>]... [--settle-ms <n>]
                              [--out <dir>] [--json]

Compares element boxes (h1-h4, p, button, a) between production and the target at every matrix case.
A node is flagged when |dx| > 6, |dy| > 12 or |dw| > 12 CSS pixels (change with --thresholds), or when it exists
on one side only. Exits 1 when anything is flagged.

Each side is captured the way the parity checks capture it: the page is scrolled through and back (lazy images
load, scroll-triggered reveals run), then waits --settle-ms after navigation and for the DOM to go quiet.

Options:
  --prod <url>         Live production origin, such as https://www.example.com
  --target <url>       Bascik origin, such as http://localhost:8080 (a production build: bascik --server)
  --route <path>       Route to compare (repeatable, default /)
  --matrix <file>      Breakpoint matrix JSON (default docs/migration/breakpoints.json)
  --thresholds <list>  dx,dy,dw in CSS pixels (default 6,12,12)
  --mask <selector>    Documented dynamic region, such as a rotating carousel: its nodes are left out on both sides
                       and the settle wait ignores changes inside it (repeatable)
  --settle-ms <n>      Least time after navigation before the boxes are read, then 0.75 s without a DOM change
                       outside the masks, as every parity check waits (default ${DEFAULT_SETTLE_MS}; 0 for a site with
                       no timers)
  --out <dir>          Write geometry.json there
  --json               Print the full report as JSON
${POLITE_HELP}
  --help               Show this message`;

export const DEFAULT_THRESHOLDS = Object.freeze({ dx: 6, dy: 12, dw: 12 });

/**
 * Every visible h1-h4, p, button and a, keyed by `TAG:text`, with its rounded box: the text a reader sees (rendered
 * descendants only, text in a display: contents wrapper included), cut after 70 characters that are not whitespace, so
 * both sides cut at the same place; diffGeometry matches keys with whitespace removed. The first occurrence wins. Hidden, transparent, empty and smaller-than-5px nodes are skipped, and so are nodes
 * inside one of `masks` (CSS selectors of documented dynamic regions).
 *
 * Self-contained so Playwright can serialize it into the page: `page.evaluate(collectNodes)`. Pass a document and
 * a window to run it elsewhere.
 */
export function collectNodes(doc = document, view = window, masks = []) {
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const masked = (el) =>
    masks.some((m) => {
      try {
        return Boolean(el.closest(m));
      } catch {
        return false;
      }
    });
  const MAX = 70;
  // Whether `node` shows its own text: rendered, not visibility hidden, not transparent. A display: contents element
  // has no box (checkVisibility() is false for it), so its nearest ancestor with a box decides.
  const shown = (node) => {
    const cs = view.getComputedStyle(node);
    if (cs.display === "contents")
      return (
        cs.visibility === "visible" &&
        (!node.parentElement || shown(node.parentElement))
      );
    return typeof node.checkVisibility === "function"
      ? node.checkVisibility({
          opacityProperty: true,
          visibilityProperty: true,
        })
      : cs.display !== "none" &&
          cs.visibility !== "hidden" &&
          cs.opacity !== "0";
  };
  // The text a reader sees in `el`, as keyText in lib/dom.mjs reads it (keep the two in step): rendered descendants
  // only, each <time datetime> read as its datetime, whitespace collapsed, cut after MAX characters that are not
  // whitespace, so React markup (no whitespace between elements) and formatted HTML cut at the same place.
  const textOf = (el) => {
    const seen = new Map();
    const visible = (node) => {
      if (node === el) return true;
      if (!seen.has(node)) seen.set(node, shown(node));
      return seen.get(node);
    };
    let out = "";
    let kept = 0;
    const add = (text) => {
      out += text;
      kept += text.replace(/\s+/g, "").length;
    };
    const walk = (node) => {
      if (kept >= MAX) return;
      if (node.nodeType === 3) {
        if (visible(node.parentElement ?? el)) add(node.textContent || "");
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = String(node.tagName).toUpperCase();
      if (["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(tag)) return;
      if (tag === "TIME" && node.hasAttribute("datetime")) {
        if (visible(node)) add(` ${node.getAttribute("datetime")} `);
        return;
      }
      for (const child of node.childNodes) walk(child);
    };
    walk(el);
    const value = norm(out);
    let count = 0;
    let i = 0;
    for (; i < value.length && count < MAX; i++)
      if (!/\s/.test(value[i])) count++;
    return value.slice(0, i).trim();
  };
  const map = new Map();
  for (const el of doc.querySelectorAll("h1, h2, h3, h4, p, button, a")) {
    if (masks.length && masked(el)) continue;
    const cs = view.getComputedStyle(el);
    if (
      cs.display === "none" ||
      cs.visibility === "hidden" ||
      cs.opacity === "0"
    )
      continue;
    const r = el.getBoundingClientRect();
    if (r.width < 5 || r.height < 5) continue;
    const text = textOf(el);
    if (!text) continue;
    const key = `${el.tagName}:${text}`;
    if (!map.has(key))
      map.set(key, {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
  }
  return Object.fromEntries(map);
}

/**
 * Compares two collectNodes snapshots. `moved` lists nodes whose delta exceeds a threshold (target minus
 * production), `missing` nodes only production has, `extra` nodes only the target has.
 */
export function diffGeometry(prod, target, thresholds = DEFAULT_THRESHOLDS) {
  const moved = [];
  const missing = [];
  // Keys are compared with whitespace removed (keyMatch): React markup and formatted HTML key one element alike.
  const targets = byKeyMatch(target);
  const prods = byKeyMatch(prod);
  for (const [key, p] of Object.entries(prod)) {
    const t = targets.get(key);
    if (!t) {
      missing.push(key);
      continue;
    }
    const dx = t.x - p.x;
    const dy = t.y - p.y;
    const dw = t.w - p.w;
    if (
      Math.abs(dx) > thresholds.dx ||
      Math.abs(dy) > thresholds.dy ||
      Math.abs(dw) > thresholds.dw
    )
      moved.push({ key, dx, dy, dw, prod: p, target: t });
  }
  const extra = Object.keys(target).filter((key) => !prods.has(key));
  return {
    ok: moved.length === 0 && missing.length === 0 && extra.length === 0,
    moved,
    missing,
    extra,
  };
}

export function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      prod: { type: "string" },
      target: { type: "string" },
      route: { type: "string", multiple: true },
      matrix: { type: "string" },
      thresholds: { type: "string" },
      mask: { type: "string", multiple: true },
      "settle-ms": { type: "string" },
      out: { type: "string" },
      json: { type: "boolean", default: false },
      ...POLITE_OPTIONS,
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return { help: true };
  if (!values.prod) throw new Error("--prod <url> is required");
  if (!values.target) throw new Error("--target <url> is required");
  const polite = politeFlags(values, values);
  for (const selector of values.mask ?? []) validateMask(selector);
  const settleMs = pixels(
    "--settle-ms",
    values["settle-ms"],
    DEFAULT_SETTLE_MS,
    "milliseconds",
  );
  let thresholds = { ...DEFAULT_THRESHOLDS };
  if (values.thresholds !== undefined) {
    const parts = values.thresholds.split(",").map((s) => Number(s.trim()));
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n) || n < 0))
      throw new Error(
        `--thresholds must be three numbers dx,dy,dw such as 6,12,12 (got "${values.thresholds}")`,
      );
    thresholds = { dx: parts[0], dy: parts[1], dw: parts[2] };
  }
  return {
    prod: values.prod,
    target: values.target,
    route: values.route ?? ["/"],
    matrix: values.matrix ?? "docs/migration/breakpoints.json",
    thresholds,
    mask: values.mask ?? [],
    settleMs,
    out: values.out,
    json: values.json,
    polite,
  };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) return console.log(HELP);
  const cases = loadMatrix(args.matrix);
  const { chromium } = await loadPlaywright();
  const browser = politeBrowser(await chromium.launch(), {
    prod: args.prod,
    target: args.target,
    ...args.polite,
  });
  const results = [];
  try {
    for (const route of args.route) {
      for (const matrixCase of cases) {
        // Captured like every parity check (withPage): settled, quiet outside the masks, settled again.
        const snap = (origin) =>
          withPage(
            browser,
            origin,
            route,
            matrixCase,
            (page) =>
              page.evaluate(
                `(${collectNodes})(document, window, ${JSON.stringify(args.mask)})`,
              ),
            args.mask,
            args.settleMs,
          );
        const [prod, target] = [await snap(args.prod), await snap(args.target)];
        const diff = diffGeometry(prod, target, args.thresholds);
        results.push({
          route,
          width: matrixCase.width,
          height: matrixCase.height,
          ...diff,
        });
        if (!args.json) {
          const label = `${route} ${matrixCase.width}x${matrixCase.height}`;
          if (diff.ok) console.log(`ok    ${label}`);
          else {
            console.log(`FAIL  ${label}`);
            for (const m of diff.moved)
              console.log(
                `        moved   ${m.key}  dx=${m.dx} dy=${m.dy} dw=${m.dw}`,
              );
            for (const key of diff.missing)
              console.log(`        missing ${key}`);
            for (const key of diff.extra) console.log(`        extra   ${key}`);
          }
        }
      }
    }
  } finally {
    await browser.close();
  }
  const report = {
    thresholds: args.thresholds,
    ok: results.every((r) => r.ok),
    results,
  };
  if (args.out) {
    mkdirSync(args.out, { recursive: true });
    writeFileSync(
      join(args.out, "geometry.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  }
  if (args.json) console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    fail(`geometry-diff: ${error.message}`);
  }
}
