/**
 * Writes the Cloudflare Pages `_headers` file and the speculation rules it points to into the output directory.
 *
 * bascik.dev is hosted on Cloudflare Pages, which sets its own Cache-Control and ignores `http.cacheControl`.
 * A `_headers` file is how a Pages site overrides that. Bascik's asset copier skips extensionless files, so the
 * file is generated here instead of authored in src/pages/. See src/lib/pages-headers.ts for each rule.
 *
 * Run via pipeline.exec in bascik.config.ts (build only), or directly: node scripts/generate-pages-headers.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSIONED_IMAGE_FOLDERS } from "../src/lib/md-renderer.ts";
import {
  pagesHeaders,
  pageFolders,
  speculationRules,
  SPECULATION_RULES_PATH,
} from "../src/lib/pages-headers.ts";
import {
  buildSearchEntries,
  searchIndexJson,
  searchIndexPath,
} from "../src/lib/search-index.ts";

const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.BASCIK_OUT_DIR ?? join(docsDir, "dist");

await mkdir(outDir, { recursive: true });
await writeFile(
  join(outDir, "_headers"),
  pagesHeaders(VERSIONED_IMAGE_FOLDERS, {
    pageFolders: pageFolders(join(docsDir, "src/pages")),
    // Only the content-hashed index. The unversioned /assets/search-index.json changes on every deploy.
    versionedFiles: [
      searchIndexPath(searchIndexJson(await buildSearchEntries())),
    ],
  }),
);
const rulesFile = join(outDir, SPECULATION_RULES_PATH);
await mkdir(dirname(rulesFile), { recursive: true });
await writeFile(rulesFile, `${JSON.stringify(speculationRules(), null, 2)}\n`);
