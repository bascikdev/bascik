/**
 * Publishes the repo-root `examples/` folder as `dist/assets/examples.json`, the file
 * `skills/bascik/scripts/add-example.mjs` downloads to copy an example into a project. One JSON file, not the raw
 * files, so example `.html` components are never served as pages of the docs site.
 *
 * Run via pipeline.exec in bascik.config.ts (dev and build), or directly: node scripts/publish-examples.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createExamplesBundle } from "./examples-bundle.ts";

const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.BASCIK_OUT_DIR ?? join(docsDir, "dist");
const output = join(outDir, "assets/examples.json");

const bundle = await createExamplesBundle(resolve(docsDir, "../examples"));
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(bundle)}\n`);
console.log(
  `[publish-examples] wrote assets/examples.json with ${bundle.examples.length} examples`,
);
