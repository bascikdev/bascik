/**
 * @module serve
 *
 * Production Server
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `bascik --serve` starts the HTTP/2 server against a previously-built
 * `dist/` directory.  Run `bascik --build` first to produce `dist/`, then
 * `bascik --serve` to start the production server.
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
import { join, extname, resolve } from "node:path";
import { mem } from "./mem.ts";

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
 * Read every HTML page from `dist/` and store it in the in-memory page store
 * so the HTTP/2 server can serve them.  The same memory store and server used
 * for dev mode is reused here — no second server implementation needed.
 */
const loadDistIntoMemory = async (): Promise<void> => {
  const distDir = resolve(process.cwd(), "dist");
  let htmlFiles: string[];
  try {
    htmlFiles = await collectHtmlFiles(distDir);
  } catch (err) {
    throw new Error(
      `[bascik] --serve: could not read dist/ directory.\n` +
      `Run \`bascik --build\` first to generate the production build.\n` +
      `(${(err as Error).message})`,
    );
  }

  if (htmlFiles.length === 0) {
    console.warn(
      "[bascik] --serve: no HTML pages found in dist/. " +
      "Run `bascik --build` first.",
    );
  }

  await Promise.all(
    htmlFiles.map(async (absPath) => {
      // Derive a relativePagePath in the "pages/..." format that getHttpPath expects.
      // e.g. dist/about.html        → pages/about.html        → HTTP /about
      //      dist/blog/post.html    → pages/blog/post.html    → HTTP /blog/post
      //      dist/index.html        → pages/index.html        → HTTP /
      const distRelative = absPath.slice(distDir.length).replace(/\\/g, "/"); // normalize Windows separators
      const relativePagePath = `pages${distRelative}`;

      const content = (await readFile(absPath)).toString();

      await mem.storePage({
        relativePagePath,
        absolutePagePath: absPath,
        pageContent: content,
        // dist/ pages have no component tracking; this is not needed at serve time
        usedComponentsNames: [],
      });
    }),
  );

  console.log(`Loaded ${htmlFiles.length} page${htmlFiles.length !== 1 ? "s" : ""} from dist/`);
};

/**
 * Entry point for `bascik --serve`.
 * Loads `dist/` into memory and starts the production HTTP/2 server.
 */
export const serveProduction = async (): Promise<string> => {
  await loadDistIntoMemory();
  const { startServer } = await import("./server.ts");
  const url = await startServer();
  if (url) console.log(`Server running at ${url}`);
  return url;
};
