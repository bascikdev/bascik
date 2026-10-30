/**
 * coverage-table.ts
 *
 * The coverage table on /internals/testing. Each workspace commits a totals-only `test-coverage.json`
 * (pkg also commits `e2e-test-coverage.json`), and the table reads them at build time so the page never
 * quotes a stale number. The rows follow the order of the coverage table in the repo-root README.md.
 *
 * Every path below must stay under `pipeline.watchPaths` in docs/bascik.config.ts, or regenerating a JSON
 * file never re-renders the page in dev; docs/scripts/watch-paths.test.ts checks this.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface CoverageSuite {
  /** The workspace's package name. */
  workspace: string;
  /** The workspace folder, from the repo root. */
  folder: string;
  /** Which tests the numbers come from. */
  suite: string;
  /** The coverage JSON, relative to the docs project root (the build's working directory). */
  file: string;
  /** The root script that regenerates the file. */
  command: string;
}

export const COVERAGE_SUITES: readonly CoverageSuite[] = [
  {
    workspace: "@bascik/bascik",
    folder: "pkg/",
    suite: "Unit",
    file: "../pkg/test-coverage.json",
    command: "yarn pkg:coverage",
  },
  {
    workspace: "@bascik/bascik",
    folder: "pkg/",
    suite: "E2E build steps",
    file: "../pkg/e2e-test-coverage.json",
    command: "yarn pkg:coverage",
  },
  {
    workspace: "create-bascik",
    folder: "create/",
    suite: "Unit",
    file: "../create/test-coverage.json",
    command: "yarn create:coverage",
  },
  {
    workspace: "@bascik/language-server",
    folder: "lsp/",
    suite: "Unit",
    file: "../lsp/test-coverage.json",
    command: "yarn lsp:coverage",
  },
  {
    workspace: "bascik-vscode",
    folder: "extensions/vscode-bascik/",
    suite: "Unit",
    file: "../extensions/vscode-bascik/test-coverage.json",
    command: "yarn ext:coverage",
  },
  {
    workspace: "@bascik/adapter-cloudflare",
    folder: "adapters/cloudflare/",
    suite: "Unit",
    file: "../adapters/cloudflare/test-coverage.json",
    command: "yarn adapter:cf:coverage",
  },
  {
    workspace: "bascik-docs",
    folder: "docs/",
    suite: "Unit and integration",
    file: "../docs/test-coverage.json",
    command: "yarn docs:coverage",
  },
  {
    workspace: "bascik-skills-tests",
    folder: "skills-tests/",
    suite: "Unit",
    file: "../skills-tests/test-coverage.json",
    command: "yarn skills:coverage",
  },
];

export const COVERAGE_METRICS = [
  "lines",
  "statements",
  "functions",
  "branches",
] as const;

export type CoverageMetricName = (typeof COVERAGE_METRICS)[number];

export interface CoverageMetric {
  total: number;
  covered: number;
  pct: number;
}

export type CoverageTotals = Record<CoverageMetricName, CoverageMetric>;

export interface CoverageRow {
  suite: CoverageSuite;
  /** Null when the file is missing or is not a coverage summary. */
  totals: CoverageTotals | null;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** The `total` block of a coverage JSON file, or null when the text is not one. */
export function parseCoverageTotals(raw: string): CoverageTotals | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const total = (parsed as { total?: Record<string, unknown> } | null)?.total;
  if (!total || typeof total !== "object") return null;
  const totals = {} as CoverageTotals;
  for (const name of COVERAGE_METRICS) {
    const metric = total[name] as Partial<CoverageMetric> | undefined;
    if (
      !metric ||
      !isCount(metric.total) ||
      !isCount(metric.covered) ||
      !isCount(metric.pct)
    ) {
      return null;
    }
    totals[name] = {
      total: metric.total,
      covered: metric.covered,
      pct: metric.pct,
    };
  }
  return totals;
}

/** Reads every suite's coverage JSON, resolving paths against `docsRoot`. */
export async function readCoverageRows(
  docsRoot: string = process.cwd(),
  suites: readonly CoverageSuite[] = COVERAGE_SUITES,
): Promise<CoverageRow[]> {
  return Promise.all(
    suites.map(async (suite) => {
      let raw: string;
      try {
        raw = await readFile(resolve(docsRoot, suite.file), "utf8");
      } catch {
        return { suite, totals: null };
      }
      return { suite, totals: parseCoverageTotals(raw) };
    }),
  );
}

const CELL = "padding:10px 12px;vertical-align:top";
const NUMBER_CELL = `${CELL};text-align:right;white-space:nowrap`;
const MUTED = "color:var(--text-muted)";

const percent = (pct: number): string => `${pct.toFixed(1)}%`;

function metricCell(metric: CoverageMetric): string {
  return (
    `<td style="${NUMBER_CELL}"><strong>${percent(metric.pct)}</strong>` +
    `<br /><span style="${MUTED};font-size:.8rem">${metric.covered} / ${metric.total}</span></td>`
  );
}

function renderRow({ suite, totals }: CoverageRow): string {
  const metrics = totals
    ? COVERAGE_METRICS.map((name) => metricCell(totals[name])).join("")
    : `<td colspan="${COVERAGE_METRICS.length}" style="${CELL};${MUTED}">Not generated yet</td>`;
  return (
    `<tr style="border-bottom:1px solid var(--border)">` +
    `<th scope="row" style="${CELL};padding-left:0;text-align:left;font-weight:600"><code>${suite.workspace}</code>` +
    `<br /><span style="${MUTED};font-size:.8rem;font-weight:400">${suite.folder}</span></th>` +
    `<td style="${CELL}">${suite.suite}</td>` +
    metrics +
    `<td style="${CELL}"><code>${suite.command}</code></td>` +
    `</tr>`
  );
}

/** The coverage table, wrapped in <doc-table> so it scrolls sideways on narrow screens. */
export function renderCoverageTable(rows: readonly CoverageRow[]): string {
  const heading = (
    label: string,
    align: "left" | "right",
    padding = "8px 12px",
  ) =>
    `<th scope="col" style="padding:${padding};text-align:${align};${MUTED};font-weight:600">${label}</th>`;
  const head =
    `<tr style="border-bottom:1px solid var(--border)">` +
    heading("Workspace", "left", "8px 12px 8px 0") +
    heading("Suite", "left") +
    COVERAGE_METRICS.map((name) =>
      heading(name[0].toUpperCase() + name.slice(1), "right"),
    ).join("") +
    heading("Generated by", "left") +
    `</tr>`;
  return (
    `<doc-table>` +
    `<table style="width:100%;border-collapse:collapse;margin:1.5rem 0;font-size:.9rem" data-testid="coverage-table">` +
    `<caption style="caption-side:top;text-align:left;padding-bottom:.5rem;${MUTED};font-size:.85rem">` +
    `Percentage covered, then covered and total counts, from each workspace's committed coverage JSON</caption>` +
    `<thead>${head}</thead>` +
    `<tbody>${rows.map(renderRow).join("")}</tbody>` +
    `</table>` +
    `</doc-table>`
  );
}

/** Reads the coverage files and renders the table; the page's build script calls this. */
export async function coverageTable(
  docsRoot: string = process.cwd(),
): Promise<string> {
  return renderCoverageTable(await readCoverageRows(docsRoot));
}
