import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COVERAGE_SUITES,
  coverageTable,
  parseCoverageTotals,
  readCoverageRows,
  renderCoverageTable,
} from "./coverage-table.ts";

const docsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = resolve(docsRoot, "..");

const metric = (covered: number, total: number) => ({
  total,
  covered,
  skipped: 0,
  pct: Math.round((covered / total) * 10000) / 100,
});

const summary = (covered: number, total: number) =>
  JSON.stringify({
    total: {
      lines: metric(covered, total),
      statements: metric(covered, total),
      functions: metric(covered, total),
      branches: metric(covered, total),
    },
  });

describe("parseCoverageTotals", () => {
  it("reads the four metrics from a json-summary total", () => {
    const totals = parseCoverageTotals(summary(9, 10));
    expect(totals?.lines).toEqual({ total: 10, covered: 9, pct: 90 });
    expect(totals?.branches.pct).toBe(90);
  });

  it.each([
    ["invalid JSON", "{"],
    ["no total", "{}"],
    ["null", "null"],
    ["a missing metric", JSON.stringify({ total: { lines: metric(1, 2) } })],
    [
      "a non-numeric count",
      summary(1, 2).replace('"covered":1', '"covered":"1"'),
    ],
    [
      "a markup string where a number belongs",
      summary(1, 2).replace('"pct":50', '"pct":"<script>"'),
    ],
  ])("returns null for %s", (_label, raw) => {
    expect(parseCoverageTotals(raw)).toBeNull();
  });
});

describe("COVERAGE_SUITES", () => {
  it("lists the coverage files in the README table's order", async () => {
    const readme = await readFile(join(repoRoot, "README.md"), "utf8");
    const readmeFiles = [
      ...readme.matchAll(/\[JSON\]\(([\w./-]+test-coverage\.json)\)/g),
    ].map((match) => match[1]);
    expect(
      COVERAGE_SUITES.map((suite) => suite.file.replace(/^\.\.\//, "")),
    ).toEqual(readmeFiles);
  });

  it("names a root script that exists for every file", async () => {
    const { scripts } = JSON.parse(
      await readFile(join(repoRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    for (const suite of COVERAGE_SUITES) {
      const script = suite.command.replace(/^yarn /, "");
      expect(scripts[script], suite.command).toBeTypeOf("string");
    }
  });

  it("reads every committed coverage file", async () => {
    const rows = await readCoverageRows(docsRoot);
    const missing = rows
      .filter((row) => row.totals === null)
      .map((row) => row.suite.file);
    expect(missing).toEqual([]);
  });
});

describe("renderCoverageTable", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bascik-coverage-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("renders an accessible table with a row per suite", () => {
    const html = renderCoverageTable(
      COVERAGE_SUITES.map((suite) => ({
        suite,
        totals: parseCoverageTotals(summary(3, 4)),
      })),
    );
    expect(html).toContain("<caption");
    expect(html.match(/<th scope="col"/g)).toHaveLength(7);
    expect(html.match(/<th scope="row"/g)).toHaveLength(COVERAGE_SUITES.length);
    expect(html).toContain("<strong>75.0%</strong>");
    expect(html).toContain("3 / 4");
    expect(html).toContain("<code>yarn skills:coverage</code>");
  });

  it("keeps a row for a suite whose file is missing", async () => {
    const suites = COVERAGE_SUITES.slice(0, 2);
    await mkdir(join(dir, "docs"));
    await mkdir(join(dir, "pkg"));
    await writeFile(join(dir, "pkg/test-coverage.json"), summary(1, 2));
    const rows = await readCoverageRows(join(dir, "docs"), suites);
    expect(rows.map((row) => row.totals === null)).toEqual([false, true]);
    const html = renderCoverageTable(rows);
    expect(html).toContain("50.0%");
    expect(html).toContain("Not generated yet");
  });

  it("renders the committed files from the docs root", async () => {
    const html = await coverageTable(docsRoot);
    expect(html.match(/<th scope="row"/g)).toHaveLength(8);
    expect(html).not.toContain("Not generated yet");
  });
});
