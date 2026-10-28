#!/usr/bin/env node
// Lighthouse gate: fail unless every report scores 100 in all five categories for the requested form factor.
// Performance, Accessibility, Best Practices and SEO must score exactly 1 (0.995 rounds to 100 in the UI and still
// fails here). Agentic Browsing is a pass-ratio category: every passable audit must pass under Lighthouse's own rule
// (manual, notApplicable and hidden audits skipped, informative not counted, otherwise score >= 0.9).
// Dependency-free; Node.js 22.18+. Reads Lighthouse JSON written by `lighthouse --output=json`; it never runs
// Lighthouse itself. Collect with the Lighthouse CLI 13.3 or later from your project (npx lighthouse). @lhci/cli
// 0.15 runs its own bundled Lighthouse 12, which has no Agentic Browsing category, so its reports always fail here.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { fail, isMain } from "./lib/cli.mjs";

const HELP = `Usage: node lighthouse-gate.mjs (--dir <folder> | <report.json>...) [--form-factor mobile|desktop]
                                  [--expect-urls <file>] [--json]

Checks each Lighthouse result: performance, accessibility, best-practices and seo at exactly 1, every passable
agentic-browsing audit passed, and configSettings.formFactor equal to --form-factor. With --expect-urls (one URL
per line, or a JSON array), every listed URL needs a report and every report must be listed. Exits 1 on failure.

Options:
  --dir <folder>        Read every *.json Lighthouse result in a folder, such as artifacts/lighthouse/mobile
  --form-factor <ff>    mobile (default) or desktop
  --expect-urls <file>  The URLs that must be covered
  --json                Print the result as JSON
  --help                Show this message

Example: one folder per form factor, one report per URL, against a production build (bascik --server):
  mkdir -p artifacts/lighthouse/mobile artifacts/lighthouse/desktop
  npx lighthouse http://localhost:8080/ --quiet --chrome-flags=--headless=new --output=json \\
    --output-path=artifacts/lighthouse/mobile/home.json
  npx lighthouse http://localhost:8080/ --quiet --chrome-flags=--headless=new --output=json --preset=desktop \\
    --output-path=artifacts/lighthouse/desktop/home.json
  node lighthouse-gate.mjs --dir artifacts/lighthouse/mobile --form-factor mobile --expect-urls docs/migration/urls.txt
  node lighthouse-gate.mjs --dir artifacts/lighthouse/desktop --form-factor desktop --expect-urls docs/migration/urls.txt
Agentic Browsing needs Lighthouse 13.3 or later and Chrome 150 or later (CHROME_PATH picks the browser).`;

export const SCORED = Object.freeze([
  "performance",
  "accessibility",
  "best-practices",
  "seo",
]);
export const AGENTIC = "agentic-browsing";
const PASS = 0.9;

/** Lighthouse's pass ratio for the agentic-browsing category: { passed, total, failed: [audit ids] }. */
export function agenticFraction(lhr) {
  const category = lhr.categories?.[AGENTIC];
  const result = { passed: 0, total: 0, failed: [] };
  for (const ref of category?.auditRefs ?? []) {
    if (ref.group === "hidden") continue;
    const audit = lhr.audits?.[ref.id];
    const mode = audit?.scoreDisplayMode;
    if (mode === "manual" || mode === "notApplicable" || mode === "informative")
      continue;
    result.total++;
    if (
      audit &&
      mode !== "error" &&
      audit.score !== null &&
      Number(audit.score) >= PASS
    )
      result.passed++;
    else result.failed.push(ref.id);
  }
  return result;
}

/** Checks one Lighthouse result. Returns { requestedUrl, formFactor, ok, failures, scores }. */
export function evaluateLhr(lhr, { formFactor = "mobile" } = {}) {
  const failures = [];
  const actual = lhr.configSettings?.formFactor;
  if (actual !== formFactor)
    failures.push(
      `formFactor: the report is ${actual ?? "unknown"}, expected ${formFactor}`,
    );
  const scores = {};
  for (const id of SCORED) {
    const category = lhr.categories?.[id];
    if (!category) {
      failures.push(`${id}: category missing from the report`);
      continue;
    }
    scores[id] = category.score;
    if (category.score === null || category.score === undefined)
      failures.push(`${id}: no score (the run errored for this category)`);
    else if (category.score !== 1)
      failures.push(`${id}: ${category.score}, expected 1`);
  }
  if (!lhr.categories?.[AGENTIC]) {
    failures.push(
      `${AGENTIC}: category missing (it needs Lighthouse 13.3 or later and Chrome 150 or later)`,
    );
  } else {
    const fraction = agenticFraction(lhr);
    scores[AGENTIC] = `${fraction.passed}/${fraction.total}`;
    if (fraction.total === 0)
      failures.push(`${AGENTIC}: no passable audits ran`);
    else if (fraction.failed.length)
      failures.push(
        `${AGENTIC}: ${fraction.passed}/${fraction.total} passed; failing: ${fraction.failed.join(", ")}`,
      );
  }
  return {
    requestedUrl: lhr.requestedUrl,
    formFactor: actual,
    ok: failures.length === 0,
    failures,
    scores,
  };
}

const normalizeUrl = (url) => {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
};

/** Checks every report and the URL coverage. Returns { ok, pages, missingUrls, unexpectedUrls }. */
export function gate(lhrs, { formFactor = "mobile", expectUrls } = {}) {
  const pages = lhrs.map((lhr) => evaluateLhr(lhr, { formFactor }));
  const seen = new Set(pages.map((p) => normalizeUrl(p.requestedUrl)));
  const expected = expectUrls ? expectUrls.map(normalizeUrl) : undefined;
  const missingUrls = expected ? expected.filter((u) => !seen.has(u)) : [];
  const unexpectedUrls = expected
    ? [...seen].filter((u) => !expected.includes(u))
    : [];
  return {
    ok:
      pages.length > 0 &&
      pages.every((p) => p.ok) &&
      missingUrls.length === 0 &&
      unexpectedUrls.length === 0,
    pages,
    missingUrls,
    unexpectedUrls,
  };
}

/** Lighthouse results from a folder and/or files. Other JSON in a folder (such as a manifest.json) is skipped. */
export function readLhrs({ dir, files = [] } = {}) {
  const paths = [...files];
  if (dir)
    paths.push(
      ...readdirSync(dir)
        .filter((f) => f.endsWith(".json") && f !== "manifest.json")
        .sort()
        .map((f) => join(dir, f)),
    );
  const reports = [];
  for (const path of paths) {
    let data;
    try {
      data = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Error(
        `${path}: not a readable Lighthouse JSON report (${error.message})`,
      );
    }
    if (
      data &&
      typeof data === "object" &&
      data.lighthouseVersion &&
      data.categories
    )
      reports.push(data);
    else if (files.includes(path))
      throw new Error(
        `${basename(path)} is not a Lighthouse result (no lighthouseVersion)`,
      );
  }
  return reports;
}

export function parseCliArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: "string" },
      "form-factor": { type: "string" },
      "expect-urls": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return { help: true };
  const formFactor = values["form-factor"] ?? "mobile";
  if (formFactor !== "mobile" && formFactor !== "desktop")
    throw new Error(
      `--form-factor must be mobile or desktop (got "${formFactor}")`,
    );
  if (!values.dir && positionals.length === 0)
    throw new Error("pass --dir <folder> or one or more Lighthouse JSON files");
  return {
    dir: values.dir,
    formFactor,
    expectUrls: values["expect-urls"],
    files: positionals,
    json: values.json,
  };
}

/** One URL per line (# comments allowed) or a JSON array. */
export function readUrlList(file) {
  const text = readFileSync(file, "utf8");
  if (text.trim().startsWith("[")) return JSON.parse(text);
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) return console.log(HELP);
  const lhrs = readLhrs({ dir: args.dir, files: args.files });
  const result = gate(lhrs, {
    formFactor: args.formFactor,
    expectUrls: args.expectUrls ? readUrlList(args.expectUrls) : undefined,
  });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const page of result.pages) {
      const s = page.scores;
      console.log(
        `${page.ok ? "ok  " : "FAIL"}  ${page.requestedUrl}  ` +
          SCORED.map((id) => `${id} ${s[id] ?? "-"}`).join("  ") +
          `  ${AGENTIC} ${s[AGENTIC] ?? "-"}`,
      );
      for (const f of page.failures) console.log(`        ${f}`);
    }
    for (const url of result.missingUrls)
      console.log(`MISSING  ${url}: no report`);
    for (const url of result.unexpectedUrls)
      console.log(`EXTRA    ${url}: not in --expect-urls`);
    if (lhrs.length === 0) console.log("FAIL  no Lighthouse reports found");
    console.log(
      result.ok
        ? `\n${lhrs.length} report(s): 5 x 100`
        : "\nLighthouse gate failed",
    );
  }
  if (!result.ok) process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (error) {
    fail(`lighthouse-gate: ${error.message}`);
  }
}
