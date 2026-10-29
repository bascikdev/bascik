#!/usr/bin/env node
// Look up the Baseline browser support status of web platform features from the Web Platform Status API
// (https://webstatus.dev), which is built on the web-features data that MDN and caniuse also use.
// Dependency-free; Node.js 22.22+.
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const HELP = `Usage: node baseline.mjs <feature> [more features...] [--limit 3] [--json]

Prints the Baseline status, the date it was reached, and the first browser versions for each feature, plus what that
status means for a Bascik site. A feature can be a web-features ID (popover, light-dark, anchor-positioning,
view-transitions, container-queries, has) or words from its name ("invoker commands").

Examples:
  node baseline.mjs popover dialog
  node baseline.mjs "anchor positioning" --limit 5

Options:
  --limit <n>  Matches to show per query (default 3)
  --json       Print JSON
  --help       Show this message

Environment:
  BASCIK_WEBSTATUS_URL  API origin (default https://api.webstatus.dev)`;

const BROWSERS = [
  ["chrome", "Chrome"],
  ["edge", "Edge"],
  ["firefox", "Firefox"],
  ["safari", "Safari"],
  ["chrome_android", "Chrome Android"],
  ["firefox_android", "Firefox Android"],
  ["safari_ios", "Safari iOS"],
];

/** What a Baseline status means for a feature in a Bascik site. Exported for tests. */
export function advice(status) {
  switch (status) {
    case "widely":
      return "Use it. Supported in every major browser for at least 30 months.";
    case "newly":
      return "Use it when older browsers can do without it (a progressive enhancement), or behind @supports or feature detection with a fallback. Otherwise wait until it is widely available.";
    case "limited":
      return "Not in every major browser. Use only as an enhancement inside @supports or a feature check, so the page still works without it.";
    default:
      return "No Baseline status recorded. Check MDN and test in every browser you support.";
  }
}

/** One feature as display text. Exported for tests. */
export function formatFeature(feature) {
  const baseline = feature.baseline ?? {};
  const label =
    baseline.status === "widely"
      ? `Baseline widely available${baseline.high_date ? ` since ${baseline.high_date}` : ""}`
      : baseline.status === "newly"
        ? `Baseline newly available since ${baseline.low_date ?? "an unknown date"}`
        : baseline.status === "limited"
          ? "Limited availability (not Baseline)"
          : "No Baseline status";
  const implementations = feature.browser_implementations ?? {};
  const browsers = BROWSERS.map(([key, name]) => {
    const entry = implementations[key];
    return `${name} ${entry?.status === "available" && entry.version ? entry.version : "no"}`;
  }).join(", ");
  return [
    `${feature.name} (${feature.feature_id})`,
    `  ${label}`,
    `  ${browsers}`,
    `  ${advice(baseline.status)}`,
  ].join("\n");
}

/** The search queries to try for one user term: an exact ID first when it looks like one. Exported for tests. */
export function queriesFor(term) {
  const trimmed = term.trim();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed)
    ? [`id:${trimmed}`, trimmed]
    : [trimmed];
}

async function search(origin, query, limit) {
  const url = new URL("/v1/features", origin);
  url.searchParams.set("q", query);
  url.searchParams.set("page_size", String(limit));
  // The API sometimes takes several seconds per query.
  const response = await fetch(url, {
    signal: AbortSignal.timeout(45_000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const body = await response.json();
  return Array.isArray(body.data) ? body.data : [];
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      limit: { type: "string", default: "3" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || positionals.length === 0) return console.log(HELP);

  const origin =
    process.env.BASCIK_WEBSTATUS_URL || "https://api.webstatus.dev";
  const limit = Math.max(1, Number.parseInt(values.limit, 10) || 3);
  let results;
  try {
    results = await Promise.all(
      positionals.map(async (term) => {
        let features = [];
        for (const query of queriesFor(term)) {
          features = await search(origin, query, limit);
          if (features.length) break;
        }
        return { term, features: features.slice(0, limit) };
      }),
    );
  } catch (error) {
    process.stderr.write(
      `baseline: ${error.message}. Check the network, or look the feature up on https://webstatus.dev or MDN.\n`,
    );
    process.exit(1);
  }

  if (values.json) return console.log(JSON.stringify(results, null, 2));
  let missing = 0;
  for (const { term, features } of results) {
    console.log(`\n# ${term}`);
    if (features.length === 0) {
      missing++;
      console.log(
        `  No feature matches. Try its web-features ID or other words; browse https://webstatus.dev`,
      );
      continue;
    }
    console.log(features.map(formatFeature).join("\n\n"));
  }
  process.exitCode = missing === results.length ? 1 : 0;
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) await main();
