/**
 * Adds a Content-Security-Policy `<meta>` to every built page, listing the page's own inline script hashes.
 *
 * Runs as a `post` exec script, after Bascik writes the pages and after the other post scripts, because the
 * hashes are computed from the final inline script text. See src/lib/csp-meta.ts for why this is a `<meta>`
 * and not a `_headers` rule. Build only: the dev server never runs it.
 *
 * Run via pipeline.exec in bascik.config.ts (build only), or directly: node scripts/generate-csp-meta.ts
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { injectCspMeta } from "../src/lib/csp-meta.ts";

const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.BASCIK_OUT_DIR ?? join(docsDir, "dist");

let updated = 0;
for (const entry of await readdir(outDir, {
  recursive: true,
  withFileTypes: true,
})) {
  if (!entry.isFile() || !entry.name.endsWith(".html")) continue;
  const file = join(entry.parentPath, entry.name);
  const html = await readFile(file, "utf8");
  const withPolicy = injectCspMeta(html);
  if (withPolicy === html) continue;
  await writeFile(file, withPolicy);
  updated++;
}
console.log(`[csp-meta] added a Content-Security-Policy to ${updated} pages.`);
