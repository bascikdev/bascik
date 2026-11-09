#!/usr/bin/env node
// Capture baselines: record production alone, before any target page exists. Per route and matrix case it writes a
// full-page PNG and the collectNodes geometry (the boxes geometry-diff and compare-route compare), and with --states
// every open state state-capture finds (dropdowns, drawers, accordions, tabs) as a crop, plus an index.json that names
// each baseline by its id, <route>@<caseId>. Dependency-free; Node.js 24.21+; needs playwright (and sharp for
// --states) in your project. Read-only toward production without --states; --states clicks production's controls the
// way state-capture does (pass side-effecting ones with --skip-control).
//
// Why: phase 1 of a migration asks for production baselines of every route, case and open state, but every script
// captured both sides on every run, so each agent wrote its own driver and nothing said where a baseline goes or what
// its id is.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  hideMasks,
  launchPolite,
  masksOf,
  parseArgsFor,
  routeSlug,
  runMatrix,
  settleOf,
  SKIP_CONTROL_OPTION,
  skipControlsFrom,
  skipControlsOf,
  withPage,
} from "./lib/checks.mjs";
import { caseId } from "./lib/matrix.mjs";
import { loadPlaywright, loadSharp } from "./lib/project-deps.mjs";
import {
  cachedProd,
  openProdCache,
  prodCacheSummary,
} from "./lib/prod-cache.mjs";
import { politeSummary } from "./lib/capture.mjs";
import { collectNodes } from "./geometry-diff.mjs";
import { productionStates } from "./state-capture.mjs";
import { fail, isMain } from "./lib/cli.mjs";

export const CHECK = "capture-baselines";

/** Where the baselines go unless --out says otherwise. */
export const DEFAULT_BASELINES = "artifacts/baselines";

const HELP = `Usage: node capture-baselines.mjs --prod <url> --route <path>... [--states] [options]

Records production's baselines before any target page exists, one page at a time. For every route and matrix case it
opens the page in a fresh context with the capture settings every check uses, waits until --settle-ms after it started
loading and until the page is quiet, and writes:

  <out>/<route slug>/<caseId>.png          the full page (masked regions made invisible)
  <out>/<route slug>/<caseId>.nodes.json   collectNodes geometry: the box of every visible h1-h4, p, button and link
  <out>/<route slug>/<caseId>.state-<n>.png  with --states, each open state's crop (state-capture's discovery)
  <out>/index.json                         every baseline by id, with its files, HTTP status and open states

A baseline id is <route>@<caseId>, such as /pricing@360x812 or /@1408x900-dark (caseId as --cases takes it); an open
state adds #<label>, such as /@360x812#BUTTON:Menu. Prompts name baselines by these ids ({{BASELINE_IDS}} in
one-route.md). Each run adds to index.json, replacing the baselines it captured again; an index of another --prod is
refused.

Everything production measured goes through the production cache. With --states, the open states are stored under
state-capture's own key, so the first run-checks.mjs (or state-capture.mjs) with the same --prod, --mask,
--skip-control and --settle-ms reads them back instead of opening production's disclosures again. A route that answers
with an HTTP error is recorded with its status and printed as a warning (an error page may be a route on purpose).

Options:
  --prod <url>              Live production origin
  --route <path>            Route to record (repeatable, required)
  --states                  Also open every disclosure and record its crop (clicks production's controls)
  --mask <selector>         A documented dynamic region to leave out, such as a carousel (repeatable)
  --skip-control <selector> A control with side effects on the live site that --states must never open (repeatable)
  --settle-ms <ms>          Least time after navigation before capturing (default 5000)
  --matrix <file>           Breakpoint matrix JSON (default docs/migration/breakpoints.json)
  --cases <id>              Only these cases: an id such as 360x812, or a width (repeatable or comma separated)
  --out <dir>               Baselines folder (default ${DEFAULT_BASELINES})
  --prod-cache <dir>        Production cache folder (default artifacts/prod-cache)
  --refresh-prod            Capture production again and overwrite the cache (after production changes)
  --no-prod-cache           Neither read nor write the cache
  --json                    Print index.json
  --help                    Show this message

There is no --target: a baseline is production alone. Compare with run-checks.mjs once the target exists.`;

/** The id of one baseline: "<route>@<caseId>", such as "/pricing@360x812". */
export function baselineId(route, matrixCase) {
  return `${route}@${caseId(matrixCase)}`;
}

/** The id of one open state of a baseline: "<baseline id>#<label>", such as "/@360x812#BUTTON:Menu". */
export function stateId(baseline, label) {
  return `${baseline}#${label}`;
}

/** The files of one baseline, relative to --out: { dir, png, nodes, state(n) }. */
export function baselinePaths(route, matrixCase) {
  const dir = routeSlug(route);
  const id = caseId(matrixCase);
  return {
    dir,
    png: `${dir}/${id}.png`,
    nodes: `${dir}/${id}.nodes.json`,
    state: (n) => `${dir}/${id}.state-${n}.png`,
  };
}

/** The index format; bumped when its shape changes. */
export const INDEX_FORMAT = 1;

/**
 * index.json after a run: the baselines of `existing` (null for none) that this run did not capture again, plus
 * `run.baselines`, ordered by id. Baselines of another production origin are refused, never mixed into one index.
 */
export function mergeIndex(existing, run) {
  if (existing && existing.prod && existing.prod !== run.prod)
    throw new Error(
      `the baselines index holds baselines of ${existing.prod}, not ${run.prod}; pass another --out, or remove the folder to start over`,
    );
  const byId = new Map();
  for (const b of existing?.baselines ?? []) byId.set(b.id, b);
  for (const b of run.baselines ?? []) byId.set(b.id, b);
  const ids = [...byId.keys()].sort();
  return {
    format: INDEX_FORMAT,
    prod: run.prod,
    matrix: run.matrix,
    ...(run.matrixSha256 ? { matrixSha256: run.matrixSha256 } : {}),
    updatedAt: run.updatedAt ?? new Date().toISOString(),
    baselines: ids.map((id) => byId.get(id)),
  };
}

/** index.json in `out`, or null; a file that is not an index is an error before any browser starts. */
export function readIndex(out) {
  const file = join(out, "index.json");
  if (!existsSync(file)) return null;
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: not a baselines index (${error.message})`);
  }
  if (data?.format !== INDEX_FORMAT || !Array.isArray(data.baselines))
    throw new Error(
      `${file}: not a baselines index of format ${INDEX_FORMAT}; pass another --out, or remove the folder to start over`,
    );
  return data;
}

/** One route and case of production: the full-page PNG, collectNodes and the HTTP status, settled like every check. */
async function capturePage(browser, options, route, c, masks) {
  return withPage(
    browser,
    options.prod,
    route,
    c,
    async (page) => {
      await hideMasks(page, masks);
      const status = await page
        .evaluate(
          () =>
            performance.getEntriesByType("navigation")[0]?.responseStatus ??
            null,
        )
        .catch(() => null);
      const nodes = await page.evaluate(collectNodes);
      const png = await page.screenshot({
        fullPage: true,
        animations: "disabled",
        caret: "hide",
      });
      return { status: status || null, nodes, png };
    },
    masks,
    settleOf(options),
  );
}

/**
 * Captures the baselines of every route and case, one page at a time, and writes their files under `options.out`.
 * Resolves to the index entries: [{ id, route, caseId, case, png, nodes, nodeCount, status, states?, recordedAt }].
 * Options: prod, routes, cases, out, states, masks or mask, skipControls, settleMs, prodCache.
 */
export async function captureBaselines(browser, options) {
  const out = options.out ?? DEFAULT_BASELINES;
  const masks = masksOf(options);
  const skip = skipControlsOf(options);
  const sharp = options.states ? await loadSharp() : null;
  const entries = [];
  for (const route of options.routes ?? ["/"])
    for (const c of options.cases) {
      const id = baselineId(route, c);
      const paths = baselinePaths(route, c);
      mkdirSync(join(out, paths.dir), { recursive: true });
      const shot = await cachedProd(
        options,
        { check: CHECK, route, case: c },
        () => capturePage(browser, options, route, c, masks),
      );
      writeFileSync(join(out, paths.png), shot.png);
      writeFileSync(
        join(out, paths.nodes),
        JSON.stringify(shot.nodes, null, 2) + "\n",
      );
      const entry = {
        id,
        route,
        caseId: caseId(c),
        case: c,
        png: paths.png,
        nodes: paths.nodes,
        nodeCount: Object.keys(shot.nodes ?? {}).length,
        status: shot.status ?? null,
      };
      if (options.states) {
        const opened = await productionStates(
          browser,
          options,
          route,
          c,
          (n) => join(out, paths.state(n)),
          { sharp, masks, skip },
        );
        entry.states = opened.map(({ label, state }, n) => ({
          id: stateId(id, label),
          label,
          crop: state.crop ? paths.state(n) : null,
          box: state.box ?? null,
        }));
      }
      entry.recordedAt = new Date().toISOString();
      entries.push(entry);
    }
  return entries;
}

export function parseCliArgs(argv) {
  const help = argv.includes("--help") || argv.includes("-h");
  if (!help && argv.some((a) => a === "--target" || a.startsWith("--target=")))
    throw new Error(
      "capture-baselines records production only and takes no --target; leave it out (compare with run-checks.mjs once the target exists)",
    );
  const args = parseArgsFor(argv, {
    extra: {
      ...SKIP_CONTROL_OPTION,
      states: { type: "boolean", default: false },
    },
    need: ["prod", "route"],
    defaultOut: DEFAULT_BASELINES,
  });
  if (args.help) return args;
  const { "skip-control": skipControls, ...rest } = args;
  return { ...rest, skipControls: skipControlsFrom(skipControls) };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  const { cases, gate } = runMatrix(args);
  const existing = readIndex(args.out);
  // An index of another production origin fails here, before any browser starts.
  mergeIndex(existing, { prod: args.prod, baselines: [] });
  const { chromium } = await loadPlaywright();
  const browser = await launchPolite(chromium, args);
  let entries;
  let prodCache = null;
  try {
    prodCache = await openProdCache(browser, {
      dir: args.prodCache,
      refresh: args.refreshProd,
    });
    entries = await captureBaselines(browser, {
      ...args,
      routes: args.route,
      cases,
      prodCache,
    });
  } finally {
    await browser.close();
  }
  const index = mergeIndex(existing, {
    prod: args.prod,
    matrix: gate.matrix,
    matrixSha256: gate.sha256,
    baselines: entries,
  });
  mkdirSync(args.out, { recursive: true });
  const file = join(args.out, "index.json");
  writeFileSync(file, JSON.stringify(index, null, 2) + "\n");
  if (args.json) console.log(JSON.stringify(index, null, 2));
  else {
    for (const e of entries) {
      const states = e.states ? `, ${e.states.length} open state(s)` : "";
      console.log(
        `baseline  ${e.id}  ${join(args.out, e.png)}  (${e.nodeCount} nodes${states})`,
      );
    }
    console.log(
      `${entries.length} baseline(s) written; ${index.baselines.length} in ${file}`,
    );
  }
  for (const e of entries)
    if (e.status && e.status >= 400)
      process.stderr.write(
        `warning: ${e.id} answered HTTP ${e.status}; check the route, or keep it if it is an error page on purpose\n`,
      );
  if (prodCache) console.log(prodCacheSummary(prodCache.stats));
  const politeLine = politeSummary(
    browser.politeStats,
    args.polite.minIntervalMs,
  );
  if (politeLine) console.log(politeLine);
}

if (isMain(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    fail(`${CHECK}: ${error.message}`);
  }
}
