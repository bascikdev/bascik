/**
 * Writes the Cloudflare `_headers` and `_redirects` files into the output directory.
 *
 * bascik.dev is served by Cloudflare (Pages, moving to an assets-only Worker defined in docs/wrangler.jsonc),
 * which sets its own Cache-Control and ignores `http.cacheControl`. A `_headers` file is how the site overrides
 * that; Pages and Workers static assets read the same syntax. Bascik's asset copier skips extensionless files, so the
 * file is generated here instead of authored in src/pages/. See src/lib/pages-headers.ts for each rule. The
 * `_redirects` file (one 301 per moved page, PAGE_REDIRECTS) is written the same way.
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
  pagesRedirects,
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
await writeFile(join(outDir, "_redirects"), pagesRedirects());
