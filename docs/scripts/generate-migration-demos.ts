/**
 * Writes the Output blocks of the grid wrapper demo on /how-to/agent-migration from a real `bascik --build`.
 *
 *   yarn workspace bascik-docs generate:migration-demos
 *
 * Run it after changing the demo's source blocks or the compiler (build pkg first: `yarn pkg:build`).
 * scripts/migration-demos.test.ts regenerates the same way and fails when a committed block differs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { replaceDemoFence } from "./generate-rtc-demos.ts";
import { MD, OUTPUT_MARKERS, runMigrationDemos } from "./migration-demos.ts";

const DOCS_ROOT = path.resolve(import.meta.dirname, "..");

async function main(): Promise<void> {
  const run = await runMigrationDemos();
  const file = path.join(DOCS_ROOT, MD);
  let md = readFileSync(file, "utf8");
  md = replaceDemoFence(md, OUTPUT_MARKERS.html, run.formatted.html, "html");
  md = replaceDemoFence(md, OUTPUT_MARKERS.css, run.formatted.css, "css");
  writeFileSync(file, md);
  console.log(`[migration-demos] wrote ${MD}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
