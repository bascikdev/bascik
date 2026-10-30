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

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, extname, relative, resolve } from "node:path";
import { mem } from "./mem.ts";
import { BascikConfig } from "./config.ts";
import {
  serverSidecarRegistry,
  sidecarHasPageEntries,
  type SidecarLoadResult,
} from "./server-sidecar.ts";
import {
  readComponentManifest,
  type ComponentManifest,
} from "./component-manifest-file.ts";
import { loadComponentJobs } from "./request-render-node.ts";
import { setServerHealthState } from "./server-lifecycle.ts";
import {
  LIVE_RELOAD_SCRIPT_ATTR,
  stripLiveReloadScript,
} from "./live-reload.ts";
import {
  assertProductionBuildState,
  hashPage,
  pageDifferenceWarning,
  type UnhashedInlineCode,
} from "./build-state.ts";
import { privateDirFor, privateDirLabel } from "./private-dir.ts";
import { computePageCspHashes, type CspHashesManifest } from "./csp-hashes.ts";
import { cspHashRestrictedKinds } from "./content-security-policy.ts";
import { getHttpPath } from "./paths.ts";
import {
  lostPlaceholderError,
  lostPlaceholderMessages,
} from "./lost-placeholders.ts";

/**
 * The served page's inline scripts and styles whose hashes the build did not
 * record, of the kinds the sent policy restricts to those hashes (`restricted`).
 */
const unhashedInlineCode = (
  page: string,
  html: string,
  manifest: CspHashesManifest | null,
  restricted: { scripts: boolean; styles: boolean },
): UnhashedInlineCode | undefined => {
  const route = getHttpPath(`pages/${page}`);
  const own = manifest?.[route];
  const scripts = new Set(own?.scripts ?? []);
  const styles = new Set(own?.styles ?? []);
  const hashes = computePageCspHashes(html);
  const unhashed = {
    page,
    scripts: restricted.scripts
      ? hashes.scripts.filter((hash) => !scripts.has(hash)).length
      : 0,
    styles: restricted.styles
      ? hashes.styles.filter((hash) => !styles.has(hash)).length
      : 0,
  };
  return unhashed.scripts + unhashed.styles > 0 ? unhashed : undefined;
};

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
 * for dev mode is reused here, so no second server implementation is needed.
 */
const loadDistIntoMemory = async (): Promise<void> => {
  const distDir = resolve(BascikConfig.directory.out);
  const outDirRel = relative(process.cwd(), distDir) || "dist";
  const recordedPages = await assertProductionBuildState("server");
  /** Each page's hash, by path relative to dist/, to compare with the build's record. */
  const foundPages: Record<string, string> = {};
  /**
   * With a CSP, the served HTML of each page that is not the recorded one,
   * by path relative to dist/: its inline code may no longer match the
   * build's hashes.
   */
  const changedHtml = new Map<string, string>();
  const policy = BascikConfig.contentSecurityPolicy;
  const restricted = policy
    ? cspHashRestrictedKinds(policy)
    : { scripts: false, styles: false };
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
  const privateRel = privateDirLabel(distDir);
  const sidecarPath = join(privateDirFor(distDir), "server-scripts.json");
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

  // A release whose sidecar has page-owned server or stream entries renders
  // component tags from their output through .bascik/dist/components.json
  // (prompt 157), so that manifest is a required runtime artifact for it and
  // is validated here like the sidecar: present, of this schema, and naming
  // only component scripts the sidecar stages (the jobs are built once here
  // and shared by every request). A static release has none to check.
  let manifest: ComponentManifest | null = null;
  if (sidecarHasPageEntries(sidecarResult.scripts)) {
    try {
      manifest = await readComponentManifest(distDir);
      if (!manifest) {
        throw new Error(
          `[bascik] --server: ${privateRel}/server-scripts.json has server-script entries ` +
            `but ${privateRel}/components.json is missing. ` +
            `Run \`bascik --build\` to regenerate matching artifacts.`,
        );
      }
      loadComponentJobs(manifest, outDirRel);
    } catch (manifestErr) {
      setServerHealthState("booting");
      throw manifestErr;
    }
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

        const raw = await readFile(absPath);
        if (recordedPages) foundPages[distRelative.slice(1)] = hashPage(raw);
        let rawString = raw.toString("utf8");
        // Defense in depth: a `bascik --build` never injects the dev
        // live-reload client, but a dist/ produced by a dev session could.
        // Identify that script ONLY by its own `data-bascik-live-reload` open
        // tag. Never sniff page content for the SSE path: a page may mention
        // `/bascik-live-reload` in prose, a code sample, or an ordinary client
        // script, and a content-based match starting at the first `<script`
        // used to swallow every client script up to that mention.
        if (rawString.includes(LIVE_RELOAD_SCRIPT_ATTR)) {
          rawString = stripLiveReloadScript(rawString);
        }
        const buffer = Buffer.from(rawString, "utf8");
        const rel = distRelative.slice(1);
        if (
          recordedPages &&
          (restricted.scripts || restricted.styles) &&
          recordedPages[rel] !== foundPages[rel]
        )
          changedHtml.set(rel, rawString);

        await mem.storePage({
          relativePagePath,
          absolutePagePath: absPath,
          pageContent: buffer,
          usedComponentsNames: [],
          // Pages with a server-script plan render component tags from
          // script output with this manifest (prompt 157).
          componentManifest: manifest,
        });
      }),
    );
  }

  // ── Production readiness boundary (prompt 108) ─────────────────────────
  // Once every page is stored, confirm that every server-script plan resolved
  // before advertising readiness. Each stored page carries a precomputed
  // serverScriptPlan; a `{ error }` plan (unresolvable placeholder ID, stale
  // mode marker, conflicting directive) proves this release's required runtime
  // artifacts cannot be resolved. This runs regardless of sidecar presence: a
  // placeholder page with no sidecar would 500 on every request, so a missing
  // sidecar is only optional when no page references a server script. A
  // genuinely static release (no sidecar AND no placeholders) passes.
  const failedPages = mem
    .pages()
    .filter(
      (page) => page.serverScriptPlan && "error" in page.serverScriptPlan,
    );
  if (failedPages.length > 0) {
    const first = failedPages[0].serverScriptPlan as { error: Error };
    const sidecarState = sidecarResult.present
      ? `while ${privateRel}/server-scripts.json is present`
      : `and the sidecar ${privateRel}/server-scripts.json is missing`;
    setServerHealthState("booting");
    throw new Error(
      `[bascik] --server: production startup validation failed. ` +
        `${failedPages.length} stored page(s) reference an unresolvable or stale server-script ` +
        `placeholder ${sidecarState}. First failure (${failedPages[0].relativePagePath}): ` +
        `${first.error.message.replace(/\.$/, "")}` +
        `${/bascik --build/.test(first.error.message) ? "." : ". Run `bascik --build` to regenerate matching artifacts."}`,
    );
  }

  // Every page whose server-script placeholder the sidecar holds but the
  // stored page no longer has: a deploy step removed the placeholder, or
  // rewrote it into something a browser does not read as
  // `<script type="text/bascik-server">` (dropped its type, renamed its id).
  // Its script cannot run, and the page would be served with it missing, so
  // startup refuses and names the page. `bascik --build` runs the same check
  // after its `post` phase; this one catches a dist/ edited after the build.
  // A page that is gone from dist/ entirely is not served at all; the
  // page-difference warning names it.
  const placeholders = new Map<string, Set<string>>();
  for (const page of mem.pages()) {
    const ids = new Set<string>();
    const plan = page.serverScriptPlan;
    if (plan && !("error" in plan))
      for (const segment of plan.segments)
        if (segment.kind === "script" && segment.job.placeholderId)
          ids.add(segment.job.placeholderId);
    placeholders.set(page.relativePagePath.replace(/\\/g, "/"), ids);
  }
  const lost = lostPlaceholderMessages(
    placeholders,
    sidecarResult.scripts,
    outDirRel,
    privateRel,
  );
  if (lost.length > 0) {
    setServerHealthState("booting");
    throw new Error(
      lostPlaceholderError(
        "--server: production startup validation failed.",
        lost,
        "A deploy step",
      ),
    );
  }

  // The private folder describes the pages of its own build. A page that
  // differs from its record is a warning, never a refusal: a deploy step
  // that edits dist/ after the build (analytics, a minifier, a CDN rewrite)
  // is legitimate, and the check above already refused every page whose
  // server scripts cannot run. A changed page is served as it is, with the
  // server scripts and CSP hashes the private folder holds.
  if (recordedPages) {
    const unhashed: UnhashedInlineCode[] = [];
    if (changedHtml.size > 0) {
      let manifest: CspHashesManifest | null = null;
      try {
        manifest = JSON.parse(
          await readFile(
            join(privateDirFor(distDir), "csp-hashes.json"),
            "utf8",
          ),
        ) as CspHashesManifest;
      } catch {
        // No hashes recorded: every inline block of a changed page is unhashed.
      }
      for (const [rel, html] of [...changedHtml].sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      )) {
        const entry = unhashedInlineCode(rel, html, manifest, restricted);
        if (entry) unhashed.push(entry);
      }
    }
    const warning = pageDifferenceWarning(recordedPages, foundPages, unhashed, {
      reportOnly: Boolean(policy?.reportOnly),
      serverScripts: sidecarResult.present,
      cspHashes:
        Boolean(policy) ||
        existsSync(join(privateDirFor(distDir), "csp-hashes.json")),
    });
    if (warning) console.warn(warning);
  }

  console.log(
    `Loaded ${htmlFiles.length} page${htmlFiles.length !== 1 ? "s" : ""} from ${outDirRel}/`,
  );
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
