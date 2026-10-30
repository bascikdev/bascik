#!/usr/bin/env node
// Reads coverage/coverage-summary.json produced by Vitest and writes a
// totals-only skills-tests/test-coverage.json (no machine-specific absolute paths).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const summaryPath = join(
  import.meta.dirname,
  "coverage",
  "coverage-summary.json",
);
const outPath = join(import.meta.dirname, "test-coverage.json");

const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
const totals = summary["total"];
if (!totals) {
  console.error('No "total" key found in coverage-summary.json');
  process.exit(1);
}
writeFileSync(outPath, JSON.stringify({ total: totals }, null, 2) + "\n");
console.log(`Wrote totals to ${outPath}`);
