#!/usr/bin/env node
// Run checks: the one command that runs every parity check per route and matrix case: production defects first, then
// interactions, open states, repeated sections, text styles, spacing, alignment, overlaps, test hook carryover and
// coverage, and presence by route. Writes <out>/<route>/report.json for the review page and exits 1 on any finding.
// Dependency-free; Node.js 22.18+; needs playwright (or @playwright/test) and sharp in your project.
//
// Why: agents treated "no flags" from the scripts they happened to run as PASS. One command with every check leaves
// nothing to forget, and a check that crashed is a finding, never a pass.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadMatrix } from "./lib/matrix.mjs";
import { loadPlaywright } from "./lib/project-deps.mjs";
import {
  DEFAULT_MATRIX,
  DEFAULT_OUT,
  DEFAULT_SETTLE_MS,
  formatFinding,
  pixels,
  routeSlug,
  validateMask,
  validateRoute,
} from "./lib/checks.mjs";
import * as productionDefects from "./production-defects.mjs";
import * as interactionCrawl from "./interaction-crawl.mjs";
import * as stateCapture from "./state-capture.mjs";
import * as repeatedSections from "./repeated-sections.mjs";
import * as textStyleDiff from "./text-style-diff.mjs";
import * as spacingDiff from "./spacing-diff.mjs";
import * as alignmentDiff from "./alignment-diff.mjs";
import * as overlapDiff from "./overlap-diff.mjs";
import * as testidCarryover from "./testid-carryover.mjs";
import * as testidCoverage from "./testid-coverage.mjs";
import * as presenceByRoute from "./presence-by-route.mjs";
import { fail, isMain } from "./lib/cli.mjs";

const MODULES = [
  productionDefects,
  interactionCrawl,
  stateCapture,
  repeatedSections,
  textStyleDiff,
  spacingDiff,
  alignmentDiff,
  overlapDiff,
  testidCarryover,
  testidCoverage,
  presenceByRoute,
];

/** Every parity check, in the order they run. Each is its own script with the same name. */
export const CHECKS = Object.freeze(MODULES.map((m) => m.CHECK));

const HELP = `Usage: node run-checks.mjs --prod <url> --target <url> --route <path>... --legacy-src <dir> [options]

Runs every parity check on every route at every matrix case, in this order:
${CHECKS.map((c, i) => `  ${String(i + 1).padStart(2)}. ${c}`).join("\n")}
production-defects runs first: a parity finding on an element production gets wrong, at that route and width, is
listed as corrected instead of failing (the ledger row says "production defect: fix in target"); a copied defect
still fails. Writes <out>/<route>/report.json ({ route, ok, findings, corrected, productionDefects, checks, states })
for review-page.mjs. Exits 1 on any finding, and a check that crashed is a finding. "No findings" is not a PASS on its
own: the route still needs a visual review and a human sign-off.

Runtime: every page waits until ${DEFAULT_SETTLE_MS / 1000} s after it started loading (--settle-ms, so a modal or banner on a timer is
on both sides) and then until it has been quiet for 0.75 s, and the interaction crawl and state capture reload the
page once per interactive element on each side, so expect about two minutes per route per matrix case on a typical
marketing page (state-capture and interaction-crawl take most of it). Run every check anyway: a check skipped to save
time is a check that passes nothing. A check that crashes on a navigation timeout (a loaded host, a slow network) is
run once more, and the report notes the retry; a second crash is a finding.

Options:
  --prod <url>                Live production origin
  --target <url>              Bascik origin, such as http://localhost:8080 (a production build: bascik --server)
  --route <path>              Route to check (repeatable, required; pass every route that shares components)
  --legacy-src <dir>          The legacy repository, for testid-carryover (required unless it is skipped)
  --target-src <dir>          The Bascik project, holding src/pages and src/components (default .)
  --matrix <file>             Breakpoint matrix JSON (default docs/migration/breakpoints.json)
  --spacing-tolerance <px>    spacing-diff tolerance (default 2)
  --overlap-tolerance <px>    overlap-diff tolerance (default 1)
  --mask <selector>           A documented dynamic region every check leaves out, such as an autoplay carousel, an
                              autoplay video, a rotating ticker or a relative clock (repeatable; log each one in the
                              decisions ledger). Never mask a modal or banner on a timer: --settle-ms waits for it
  --settle-ms <ms>            Least time after navigation before a page is measured (default ${DEFAULT_SETTLE_MS}); raise it for
                              a layer on a longer timer, 0 for a site with none
  --dismiss <selector>        Another control presence-by-route uses to dismiss a layer (repeatable)
  --ledger <file>             Append production defects to this decisions ledger
  --only <check>              Run only these checks (repeatable or comma separated)
  --skip <check>              Skip these checks (repeatable or comma separated)
  --out <dir>                 Report folder (default artifacts/checks)
  --help                      Show this message`;

function checkList(flag, values) {
  const names = (values ?? []).flatMap((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const name of names)
    if (!CHECKS.includes(name))
      throw new Error(
        `${flag} ${name}: no such check; use one of ${CHECKS.join(", ")}`,
      );
  return names;
}

export function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      prod: { type: "string" },
      target: { type: "string" },
      route: { type: "string", multiple: true },
      matrix: { type: "string" },
      "target-src": { type: "string" },
      "legacy-src": { type: "string" },
      "spacing-tolerance": { type: "string" },
      "overlap-tolerance": { type: "string" },
      mask: { type: "string", multiple: true },
      "settle-ms": { type: "string" },
      dismiss: { type: "string", multiple: true },
      ledger: { type: "string" },
      only: { type: "string", multiple: true },
      skip: { type: "string", multiple: true },
      out: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return { help: true };
  if (!values.prod) throw new Error("--prod <url> is required");
  if (!values.target) throw new Error("--target <url> is required");
  if (!values.route?.length)
    throw new Error("--route <path> is required (repeatable)");
  const seen = new Set();
  for (const route of values.route) {
    validateRoute(route);
    if (seen.has(route)) throw new Error(`--route ${route} is given twice`);
    seen.add(route);
  }
  for (const selector of values.mask ?? []) validateMask(selector);
  const only = checkList("--only", values.only);
  const skip = checkList("--skip", values.skip);
  const run = (
    only.length ? CHECKS.filter((c) => only.includes(c)) : [...CHECKS]
  ).filter((c) => !skip.includes(c));
  if (!run.length) throw new Error("--only and --skip leave no check to run");
  if (run.includes("testid-carryover") && !values["legacy-src"])
    throw new Error(
      "--legacy-src <dir> is required while testid-carryover runs (its legacy source hooks are half of the check); pass --skip testid-carryover only when there is no legacy repository",
    );
  return {
    prod: values.prod,
    target: values.target,
    route: values.route,
    matrix: values.matrix ?? DEFAULT_MATRIX,
    targetSrc: values["target-src"] ?? ".",
    legacySrc: values["legacy-src"],
    spacingTolerance: pixels(
      "--spacing-tolerance",
      values["spacing-tolerance"],
      2,
    ),
    overlapTolerance: pixels(
      "--overlap-tolerance",
      values["overlap-tolerance"],
      1,
    ),
    mask: values.mask ?? [],
    settleMs: pixels(
      "--settle-ms",
      values["settle-ms"],
      DEFAULT_SETTLE_MS,
      "milliseconds",
    ),
    dismiss: values.dismiss ?? [],
    ledger: values.ledger,
    out: values.out ?? DEFAULT_OUT,
    only: run,
  };
}

/** Whether a finding belongs to a route: its own route, one of its routes, or no route at all. */
const onRoute = (f, route) =>
  f.route === route ||
  (Array.isArray(f.routes) && f.routes.includes(route)) ||
  (f.route === undefined && !Array.isArray(f.routes));

/**
 * One route's report from the check results ([{ check, ok, findings, ... } or { check, error }]). It passes only when
 * every expected check ran and none has a finding. A crashed or missing check is an "error" finding. A parity finding
 * on an element production-defects found wrong at that route and width moves to `corrected`.
 */
export function buildRouteReport(route, results, { expected = CHECKS } = {}) {
  const raw = [];
  const checks = {};
  const byName = new Map(results.map((r) => [r.check, r]));
  const defects = [];
  for (const name of [...expected, ...results.map((r) => r.check)]) {
    if (name in checks) continue;
    const r = byName.get(name);
    if (!r) {
      checks[name] = { ok: false, error: "did not run" };
      raw.push({
        check: name,
        kind: "error",
        message: `${name} did not run`,
        route,
      });
      continue;
    }
    if (r.error) {
      checks[name] = { ok: false, error: r.error };
      raw.push({ check: name, kind: "error", message: r.error, route });
      continue;
    }
    const own = (r.findings ?? [])
      .filter((f) => onRoute(f, route))
      .map((f) => ({ ...f, route: f.route ?? route }));
    for (const d of r.defects ?? []) if (d.route === route) defects.push(d);
    checks[name] = {
      ok: own.length === 0,
      findings: own.length,
      ...(r.retried ? { retried: r.retried } : {}),
    };
    raw.push(...own);
  }
  const { kept, corrected } = productionDefects.applyCorrections(raw, defects);
  return {
    route,
    ok: results.length > 0 && kept.length === 0,
    findings: kept,
    corrected,
    productionDefects: defects,
    checks,
    states: results
      .flatMap((r) => r.states ?? [])
      .filter((s) => s.route === undefined || s.route === route),
  };
}

const STATE_ORDER = ["rest", "hover", "focus-visible"];

/**
 * The terminal lines for a list of findings: one per finding, except that one style difference found in several
 * states (rest, hover, focus-visible) of one element at one width is one line naming the states.
 */
export function formatFindings(findings) {
  const groups = new Map();
  const lines = [];
  for (const f of findings) {
    if (f.state === undefined || f.property === undefined) {
      lines.push(formatFinding(f));
      continue;
    }
    const id = JSON.stringify([
      f.check,
      f.kind,
      f.route,
      f.width,
      f.key,
      f.property,
      f.prod,
      f.target,
    ]);
    if (!groups.has(id)) {
      groups.set(id, { first: f, states: [] });
      lines.push(id);
    }
    groups.get(id).states.push(f.state);
  }
  return lines.map((line) => {
    const group = groups.get(line);
    if (!group) return line;
    const { first, states } = group;
    if (states.length === 1) return formatFinding(first);
    const sorted = [...states].sort(
      (a, b) => STATE_ORDER.indexOf(a) - STATE_ORDER.indexOf(b),
    );
    return formatFinding({
      ...first,
      state: undefined,
      message: `${first.key} (${sorted.join(", ")}): ${first.property} is "${first.prod}" in production and "${first.target}" on the target`,
    });
  });
}

/** A crash a second try can get past: a navigation or wait that timed out, or a connection that dropped. */
export function isTransient(error) {
  return /Timeout \d+ms exceeded|net::ERR_|Target page, context or browser has been closed|ECONNRESET/.test(
    String(error?.message ?? error),
  );
}

/**
 * Runs one check module over all routes and cases at once (repeated-sections and presence-by-route compare routes with
 * each other), turning a crash into an error result. A transient crash (isTransient: a navigation timeout on a loaded
 * host) is retried once; the result then says so in `retried`, and a second crash is the error.
 */
export async function runOne(name, browser, options, modules = MODULES) {
  const mod = modules.find((m) => m.CHECK === name);
  let retried;
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await mod.runCheck(browser, options);
      return retried ? { ...r, retried } : r;
    } catch (error) {
      const first = error.message.split("\n")[0];
      if (attempt === 1 && isTransient(error)) {
        retried = `${name} crashed once and was run again: ${first}`;
        continue;
      }
      return {
        check: name,
        error: `${name} crashed: ${first}`,
        ...(retried ? { retried } : {}),
      };
    }
  }
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) return console.log(HELP);
  const cases = loadMatrix(args.matrix);
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  const results = [];
  try {
    const base = {
      prod: args.prod,
      target: args.target,
      routes: args.route,
      cases,
      out: args.out,
      targetSrc: args.targetSrc,
      legacySrc: args.legacySrc,
      masks: args.mask,
      settleMs: args.settleMs,
      dismiss: args.dismiss,
    };
    for (const name of args.only) {
      const options = { ...base };
      if (name === "spacing-diff") options.tolerance = args.spacingTolerance;
      if (name === "overlap-diff") options.tolerance = args.overlapTolerance;
      if (name === "production-defects" && args.ledger)
        options.ledger = args.ledger;
      const started = Date.now();
      const r = await runOne(name, browser, options);
      results.push(r);
      const n = r.error ? "crashed" : `${r.findings.length} finding(s)`;
      console.log(
        `${r.error || r.findings.length ? "FAIL" : "ok  "}  ${name}  ${n}  (${((Date.now() - started) / 1000).toFixed(1)} s)${r.retried ? "  (retried once after a crash)" : ""}`,
      );
    }
  } finally {
    await browser.close();
  }
  let allOk = true;
  for (const route of args.route) {
    const report = buildRouteReport(route, results, { expected: args.only });
    const dir = join(args.out, routeSlug(route));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "report.json");
    writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
    console.log(`${report.ok ? "ok  " : "FAIL"}  ${route}  (${file})`);
    for (const line of formatFindings(report.findings))
      console.log(`        ${line}`);
    if (report.corrected.length)
      console.log(
        `        ${report.corrected.length} finding(s) on production defects the target fixes (see productionDefects)`,
      );
    allOk &&= report.ok;
  }
  if (!allOk) process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    fail(`run-checks: ${error.message}`);
  }
}
