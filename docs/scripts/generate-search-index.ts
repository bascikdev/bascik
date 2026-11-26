/**
 * Writes the search index from all nav pages: the outline at dist/assets/search-index.<hash>.json and the text
 * at dist/assets/search-text.<hash>.json, which pages fetch in that order, and a plain array of entries at
 * dist/assets/search-index.json, which the agent skill scripts and older pages read. Earlier hashed files are
 * removed. See src/lib/search-index.ts for what each file holds.
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
  searchTextJson,
  searchTextPath,
  PUBLIC_SEARCH_INDEX_PATH,
  SEARCH_INDEX_FILE_PATTERN,
  SEARCH_TEXT_FILE_PATTERN,
} from "../src/lib/search-index.ts";

export { stripMd, metaDescription } from "../src/lib/search-index.ts";

const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.BASCIK_OUT_DIR ?? join(docsDir, "dist");

const entries = await buildSearchEntries();
const json = searchIndexJson(entries);
const text = searchTextJson(entries);
const outPath = join(outDir, searchIndexPath(json));
const textPath = join(outDir, searchTextPath(text));
const assetsDir = dirname(outPath);
await mkdir(assetsDir, { recursive: true });
// Old hashed files would pile up in dist during dev, where content changes rebuild the index.
const current = [basename(outPath), basename(textPath)];
for (const name of await readdir(assetsDir))
  if (
    (SEARCH_INDEX_FILE_PATTERN.test(name) ||
      SEARCH_TEXT_FILE_PATTERN.test(name)) &&
    !current.includes(name)
  )
    await rm(join(assetsDir, name), { force: true });
await writeFile(outPath, json);
await writeFile(textPath, text);
await writeFile(
  join(outDir, PUBLIC_SEARCH_INDEX_PATH),
  publicSearchIndexJson(entries),
);
