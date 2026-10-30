/**
 * Writes the search index from all nav pages: the compact index at dist/assets/search-index.<hash>.json, which
 * pages fetch, and a plain array of entries at dist/assets/search-index.json, which the agent skill scripts and
 * older pages read. Earlier hashed files are removed. See src/lib/search-index.ts for what each entry holds and how the
 * file is laid out.
 *
 * Run via: node scripts/generate-search-index.ts
 */
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSearchEntries,
  publicSearchIndexJson,
  searchIndexJson,
  searchIndexPath,
  PUBLIC_SEARCH_INDEX_PATH,
  SEARCH_INDEX_FILE_PATTERN,
} from "../src/lib/search-index.ts";

export { stripMd, metaDescription } from "../src/lib/search-index.ts";

const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.BASCIK_OUT_DIR ?? join(docsDir, "dist");

const entries = await buildSearchEntries();
const json = searchIndexJson(entries);
const outPath = join(outDir, searchIndexPath(json));
const assetsDir = dirname(outPath);
await mkdir(assetsDir, { recursive: true });
// Old hashed files would pile up in dist during dev, where content changes rebuild the index.
for (const name of await readdir(assetsDir))
  if (SEARCH_INDEX_FILE_PATTERN.test(name) && name !== basename(outPath))
    await rm(join(assetsDir, name), { force: true });
await writeFile(outPath, json);
await writeFile(
  join(outDir, PUBLIC_SEARCH_INDEX_PATH),
  publicSearchIndexJson(entries),
);
