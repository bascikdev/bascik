/**
 * @module server-prod
 *
 * Production Server
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `bascik --server` runs the same HTTP server as dev mode (`server.ts`, the
 * shared core) against a previously-built `dist/` directory. Run
 * `bascik --build` first to produce `dist/`, then `bascik --server`.
 *
 * Relative to the dev server (`server-dev.ts`), production does NOT:
 *   - Watch source files for changes
 *   - Inject the live-reload SSE script
 *   - Rebuild pages on demand
 *
 * Everything else (routing, headers, compression, server scripts, streaming,
 * error pages) is the shared code path, so behavior matches dev.
 * `data-bascik-server` script blocks preserved in `dist/` HTML are executed
 * on every request, exactly as in dev mode.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, extname, relative, resolve } from "node:path";
import { mem } from "./mem.ts";
import { BascikConfig } from "./config.ts";
import { serverSidecarRegistry, type SidecarLoadResult } from "./server-sidecar.ts";
import { setServerHealthState } from "./server-lifecycle.ts";

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
  // Three distinct sidecar states. A missing file is an optional sidecar: a
  // genuinely static release with no server scripts is valid, so it does NOT
  // fail startup and does not trigger placeholder validation. A present but
  // malformed, schema-incompatible, or stale sidecar is a required-runtime
  // artifact defect: loadSidecar throws an actionable diagnostic and startup
  // aborts before any socket binds.
  let sidecarResult: SidecarLoadResult;
  try {
    sidecarResult = await serverSidecarRegistry.loadSidecar(sidecarPath);
  } catch (sidecarErr) {
    setServerHealthState("booting");
    throw sidecarErr;
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

  // ── Production readiness boundary (prompt 108) ─────────────────────────
  // Once every page is stored, confirm that a present sidecar was fully
  // consumable before advertising readiness. Each stored page carries a
  // precomputed serverScriptPlan; a `{ error }` plan (unresolvable placeholder
  // ID, stale mode marker, conflicting directive) proves this release's
  // required runtime artifacts cannot be resolved. A genuinely static release
  // with no sidecar remains valid and skips this check.
  if (sidecarResult.present) {
    const failedPages = mem.pages().filter(
      (page) => page.serverScriptPlan && "error" in page.serverScriptPlan,
    );
    if (failedPages.length > 0) {
      const first = failedPages[0].serverScriptPlan as { error: Error };
      setServerHealthState("booting");
      throw new Error(
        `[bascik] --server: production startup validation failed. ` +
        `${failedPages.length} stored page(s) reference an unresolvable or stale server-script ` +
        `placeholder while dist/.bascik/server-scripts.json is present. First failure (${failedPages[0].relativePagePath}): ` +
        `${first.error.message}. Run \`bascik --build\` to regenerate matching artifacts.`,
      );
    }
  }

  console.log(`Loaded ${htmlFiles.length} page${htmlFiles.length !== 1 ? "s" : ""} from ${outDirRel}/`);
};

/**
 * Entry point for `bascik --server`.
 * Loads output directory into memory and starts the shared HTTP server.
 * If validation fails, startup rejects before binding so a broken release is
 * never advertised as ready; readiness state is reset to "booting" on failure.
 */
export const startProdServer = async (): Promise<string> => {
  const { startServer } = await import("./server.ts");
  try {
    await loadDistIntoMemory();
    const url = await startServer();
    if (url) console.log(`Server running at ${url}`);
    return url;
  } catch (err) {
    // The shared core flips "booting" -> "ready" when the socket binds. If
    // validation (or binding) fails, reset so a later probe cannot observe a
    // stale ready state and failure cleanup is explicit.
    setServerHealthState("booting");
    throw err;
  }
};
