/**
 * Writes the Output blocks of the demos on /name-attribute from a real `bascik --build`.
 *
 *   yarn workspace bascik-docs generate:name-attribute-demos
 *
 * Run it after changing the demos' source blocks or the compiler (build pkg first: `yarn pkg:build`).
 * scripts/name-attribute-demos.test.ts regenerates the same way and fails when a committed block differs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { replaceDemoFence } from "./generate-rtc-demos.ts";
import { MD, runNameAttributeDemos } from "./name-attribute-demos.ts";

const DOCS_ROOT = path.resolve(import.meta.dirname, "..");

async function main(): Promise<void> {
  const run = await runNameAttributeDemos();
  const file = path.join(DOCS_ROOT, MD);
  let md = readFileSync(file, "utf8");
  for (const output of run.outputs)
    md = replaceDemoFence(md, output.marker, output.formatted, "html");
  writeFileSync(file, md);
  console.log(`[name-attribute-demos] wrote ${MD}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
