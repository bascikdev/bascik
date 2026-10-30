/**
 * Writes the Output blocks of the TypeScript script demos (build, server, stream, a page's own `.ts` file, and the
 * `scripts.typescript` esbuild compiler) from a real `bascik --build` and `bascik --server`.
 *
 *   yarn workspace bascik-docs generate:ts-script-demos
 *
 * Run it after changing a demo's source blocks or the compiler (build pkg first: `yarn pkg:build`).
 * scripts/ts-script-demos.test.ts regenerates the same way and fails when a committed block differs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { replaceDemoFence } from "./generate-rtc-demos.ts";
import { DEMOS, runTsScriptDemos } from "./ts-script-demos.ts";

const DOCS_ROOT = path.resolve(import.meta.dirname, "..");

async function main(): Promise<void> {
  const run = await runTsScriptDemos();
  const files = new Map<string, string>();
  for (const demo of DEMOS) {
    const file = path.join(DOCS_ROOT, demo.md);
    const md = files.get(file) ?? readFileSync(file, "utf8");
    files.set(file, replaceDemoFence(md, demo.output, run.formatted[demo.id]));
  }
  for (const [file, md] of files) {
    writeFileSync(file, md);
    console.log(`[ts-script-demos] wrote ${path.relative(DOCS_ROOT, file)}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
