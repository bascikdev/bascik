#!/usr/bin/env node
// Geometry diff: open production and the Bascik target side by side at every breakpoint matrix width and compare
// the box of every visible heading, paragraph, button and link, matched by tag plus normalized text.
// Dependency-free; Node.js 22.22+; needs playwright (or @playwright/test) in your project. Read-only: it only loads
// pages and writes the optional --out report.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadMatrix } from "./lib/matrix.mjs";
import { openPage, routeUrl } from "./lib/capture.mjs";
import { loadPlaywright } from "./lib/project-deps.mjs";
import { fail, isMain } from "./lib/cli.mjs";

export { loadMatrix };

const HELP = `Usage: node geometry-diff.mjs --prod <url> --target <url> [--route <path>]... [--matrix <file>]
                              [--thresholds dx,dy,dw] [--out <dir>] [--json]

Compares element boxes (h1-h4, p, button, a) between production and the target at every matrix case.
A node is flagged when |dx| > 6, |dy| > 12 or |dw| > 12 CSS pixels (change with --thresholds), or when it exists
on one side only. Exits 1 when anything is flagged.

Options:
  --prod <url>         Live production origin, such as https://www.example.com
  --target <url>       Bascik origin, such as http://localhost:8080 (a production build: bascik --server)
  --route <path>       Route to compare (repeatable, default /)
  --matrix <file>      Breakpoint matrix JSON (default docs/migration/breakpoints.json)
  --thresholds <list>  dx,dy,dw in CSS pixels (default 6,12,12)
  --out <dir>          Write geometry.json there
  --json               Print the full report as JSON
  --help               Show this message`;

export const DEFAULT_THRESHOLDS = Object.freeze({ dx: 6, dy: 12, dw: 12 });

/**
 * Every visible h1-h4, p, button and a, keyed by `TAG:normalized text` (cut at 70 characters; the first occurrence
 * wins), with its rounded box. Hidden, transparent, empty and smaller-than-5px nodes are skipped.
 *
 * Self-contained so Playwright can serialize it into the page: `page.evaluate(collectNodes)`. Pass a document and
 * a window to run it elsewhere.
 */
export function collectNodes(doc = document, view = window) {
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const map = new Map();
  for (const el of doc.querySelectorAll("h1, h2, h3, h4, p, button, a")) {
    const cs = view.getComputedStyle(el);
    if (
      cs.display === "none" ||
      cs.visibility === "hidden" ||
      cs.opacity === "0"
    )
      continue;
    const r = el.getBoundingClientRect();
    if (r.width < 5 || r.height < 5) continue;
    const text = norm(el.textContent || "");
    if (!text) continue;
    const key = `${el.tagName}:${text.slice(0, 70)}`;
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
  for (const [key, p] of Object.entries(prod)) {
    const t = target[key];
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
  const extra = Object.keys(target).filter((key) => !(key in prod));
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
      out: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return { help: true };
  if (!values.prod) throw new Error("--prod <url> is required");
  if (!values.target) throw new Error("--target <url> is required");
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
    out: values.out,
    json: values.json,
  };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) return console.log(HELP);
  const cases = loadMatrix(args.matrix);
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  const results = [];
  try {
    for (const route of args.route) {
      for (const matrixCase of cases) {
        const snap = async (origin) => {
          const { context, page } = await openPage(
            browser,
            routeUrl(origin, route),
            matrixCase,
          );
          try {
            return await page.evaluate(collectNodes);
          } finally {
            await context.close();
          }
        };
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
