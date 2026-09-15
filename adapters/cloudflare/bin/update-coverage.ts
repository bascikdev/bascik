#!/usr/bin/env node
// Reads coverage/coverage-summary.json produced by Vitest and writes a
// totals-only adapters/cloudflare/test-coverage.json (no machine-specific absolute paths).
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const summaryPath = join(__dirname, '..', 'coverage', 'coverage-summary.json');
const outPath = join(__dirname, '..', 'test-coverage.json');

const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
const totals = summary['total'];
if (!totals) {
  console.error('No "total" key found in coverage-summary.json');
  process.exit(1);
}
writeFileSync(outPath, JSON.stringify({ total: totals }, null, 2) + '\n');
console.log(`Wrote totals to ${outPath}`);
