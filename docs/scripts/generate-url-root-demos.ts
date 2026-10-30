/**
 * Writes the Output block of the "Attributes That Become URLs on the Root" demo on /attribute-inheritance from a
 * real `bascik --build`.
 *
 *   yarn workspace bascik-docs generate:url-root-demos
 *
 * Run it after changing the demo's source blocks or the compiler (build pkg first: `yarn pkg:build`).
 * scripts/url-root-demos.test.ts regenerates the same way and fails when the committed block differs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { replaceDemoFence } from "./generate-rtc-demos.ts";
import { MD, OUTPUT_MARKER, runUrlRootDemo } from "./url-root-demos.ts";

const DOCS_ROOT = path.resolve(import.meta.dirname, "..");

async function main(): Promise<void> {
  const run = await runUrlRootDemo();
  const file = path.join(DOCS_ROOT, MD);
  const md = replaceDemoFence(
    readFileSync(file, "utf8"),
    OUTPUT_MARKER,
    run.formatted,
    "html",
  );
  writeFileSync(file, md);
  console.log(`[url-root-demos] wrote ${MD}`);
  for (const warning of run.warnings)
    console.log(`[url-root-demos] ${warning}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
