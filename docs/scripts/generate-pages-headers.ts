/**
 * Writes the Cloudflare Pages `_headers` file to the output directory.
 *
 * bascik.dev is hosted on Cloudflare Pages, which sets its own Cache-Control and ignores `http.cacheControl`.
 * A `_headers` file is how a Pages site overrides that. Bascik's asset copier skips extensionless files, so the
 * file is generated here instead of authored in src/pages/.
 *
 * Run via pipeline.exec in bascik.config.ts (build only), or directly: node scripts/generate-pages-headers.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSIONED_IMAGE_FOLDERS } from "../src/lib/md-renderer.ts";
import { pagesHeaders } from "../src/lib/pages-headers.ts";

const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(
  process.env.BASCIK_OUT_DIR ?? join(docsDir, "dist"),
  "_headers",
);

await mkdir(dirname(output), { recursive: true });
await writeFile(output, pagesHeaders(VERSIONED_IMAGE_FOLDERS));
