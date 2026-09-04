/**
 * @module serve
 *
 * Production Server
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `bascik --server` starts the HTTP server against a previously-built
 * `dist/` directory.  Run `bascik --build` first to produce `dist/`, then
 * `bascik --server` to start the production server.
 *
 * Unlike the dev server (`bascik`), the production server does NOT:
 *   - Watch source files for changes
 *   - Inject the live-reload SSE script
 *   - Rebuild pages on demand
 *
 * `data-bascik-server` script blocks preserved in `dist/` HTML are executed
 * on every request, exactly as in dev mode.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, extname, relative, resolve } from "node:path";
import { mem } from "./mem.ts";
import { BascikConfig } from "./config.ts";
import { serverSidecarRegistry } from "./server-sidecar.ts";

/**
 * Recursively collect every `.html` file path under `dir`.
 */
const collectHtmlFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectHtmlFiles(fullPath)));
    } else if (entry.isFile() && extname(entry.name) === ".html") {
      results.push(fullPath);
    }
  }
  return results;
};

/**
 * Read every HTML page from output directory and store it in the in-memory page store
 * so the HTTP/2 server can serve them. The same memory store and server used
 * for dev mode is reused here — no second server implementation needed.
 */
const loadDistIntoMemory = async (): Promise<void> => {
  const distDir = resolve(BascikConfig.directory.out);
  const outDirRel = relative(process.cwd(), distDir) || "dist";
  let htmlFiles: string[];
  try {
    htmlFiles = await collectHtmlFiles(distDir);
  } catch (err) {
    throw new Error(
      `[bascik] --server: could not read ${outDirRel}/ directory.\n` +
      `Run \`bascik --build\` first to generate the production build.\n` +
      `(${(err as Error).message})`,
    );
  }

  if (htmlFiles.length === 0) {
    console.warn(
      `[bascik] --server: no HTML pages found in ${outDirRel}/. ` +
      "Run `bascik --build` first.",
    );
  }

  // ORDERING CONTRACT: the sidecar must be loaded BEFORE the store loop
  // below. mem.storePage computes each page's server-script plan at store
  // time (prompt 67) and resolves every `data-bascik-server-id` placeholder
  // against serverSidecarRegistry while doing so. Reordering these two steps
  // would record an "unresolvable placeholder" error on every server-script
  // page.
  const sidecarPath = join(distDir, ".bascik", "server-scripts.json");
  try {
    await serverSidecarRegistry.loadSidecar(sidecarPath);
  } catch {
    // Sidecar may not exist if no pages used server scripts
  }

  // Bounded concurrency during production boot to avoid EMFILE on large sites
  const concurrency = 32;
  for (let i = 0; i < htmlFiles.length; i += concurrency) {
    const chunk = htmlFiles.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (absPath) => {
        // Derive a relativePagePath in the "pages/..." format that getHttpPath expects.
        const distRelative = absPath.slice(distDir.length).replace(/\\/g, "/"); // normalize Windows separators
        const relativePagePath = `pages${distRelative}`;

        let rawString = await readFile(absPath, "utf8");
        // Defense in depth: runtime strip any live-reload script if present
        if (rawString.includes("/bascik-live-reload")) {
          rawString = rawString.replace(/<script[^>]*>[\s\S]*?bascik-live-reload[\s\S]*?<\/script>/gi, "");
        }
        const buffer = Buffer.from(rawString, "utf8");

        await mem.storePage({
          relativePagePath,
          absolutePagePath: absPath,
          pageContent: buffer,
          usedComponentsNames: [],
        });
      }),
    );
  }

  console.log(`Loaded ${htmlFiles.length} page${htmlFiles.length !== 1 ? "s" : ""} from ${outDirRel}/`);
};

/**
 * Entry point for `bascik --server`.
 * Loads output directory into memory and starts the production HTTP/2 server.
 */
export const serverProduction = async (): Promise<string> => {
  await loadDistIntoMemory();
  const { startServer } = await import("./server.ts");
  const url = await startServer();
  if (url) console.log(`Server running at ${url}`);
  return url;
};
export const serveProduction = serverProduction;
