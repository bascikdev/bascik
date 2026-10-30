/**
 * Adds git-derived dates to the build output:
 * - `<lastmod>` in dist/sitemap.xml
 * - `dateModified` and `datePublished` in each page's TechArticle JSON-LD
 *
 * Runs as a `post` exec script, after Bascik writes the pages and sitemap. See src/lib/sitemap-lastmod.ts for
 * why this does not use Bascik's mtime-based `generate.sitemapLastmod`, and src/lib/article-dates.ts for why
 * the article dates are not written by the build script. It never fails the build: without git or history
 * it leaves the output exactly as generated.
 *
 * A shallow clone (actions/checkout's default depth of 1, Cloudflare's builds, or any other CI) would leave most
 * pages without a provable date, so `ensureFullHistory` asks git whether the clone is shallow and, on CI, fetches
 * the rest of the history when it is. GitHub Actions is the exception: a workflow sets its own depth (the deploy
 * jobs check out with fetch-depth: 0), so there it only logs how to get full history, and the test builds (docs
 * E2E, Lighthouse) start no network work inside their web server. A full clone and a local build are left
 * untouched, and a failed fetch only warns.
 *
 * Run via pipeline.exec in bascik.config.ts (build only), or directly: node scripts/generate-git-dates.ts
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { builtPageFor, injectArticleDates } from "../src/lib/article-dates.ts";
import {
  addGitLastmod,
  findRepoRoot,
  isShallowRepository,
  routeOf,
  unshallow,
} from "../src/lib/sitemap-lastmod.ts";

interface HistoryLog {
  log(line: string): void;
  warn(line: string): void;
}

/** A set flag such as `CI=true` or `CI=1`; empty, `false` and `0` mean unset. */
const isSet = (value: string | undefined) =>
  value !== undefined && !["", "0", "false"].includes(value.toLowerCase());

/**
 * Whether the build runs on CI: `CI` (most hosts), `GITHUB_ACTIONS`, `WORKERS_CI` (Cloudflare Workers Builds),
 * or `CF_PAGES` (Cloudflare Pages).
 */
export function isCiBuild(env: NodeJS.ProcessEnv): boolean {
  return (
    isSet(env.CI) ||
    isSet(env.GITHUB_ACTIONS) ||
    isSet(env.WORKERS_CI) ||
    isSet(env.CF_PAGES)
  );
}

/**
 * Completes a shallow clone on CI so every page can be dated, except on GitHub Actions, where the workflow's
 * actions/checkout `fetch-depth` decides and this only logs a hint. Returns whether the clone has full history
 * afterwards. A full clone, or a directory that is not a git checkout, is a silent no-op. A local build never
 * fetches, because it must not change a developer's checkout; the build's shallow-clone hint covers that case.
 * A failed fetch (offline, no remote, no permission, timeout) warns and returns false: the build continues with
 * the history it has, and pages without a provable date stay undated.
 */
export async function ensureFullHistory(
  repoRoot: string,
  {
    env = process.env,
    log = console,
    timeoutMs,
  }: { env?: NodeJS.ProcessEnv; log?: HistoryLog; timeoutMs?: number } = {},
): Promise<boolean> {
  if (!(await isShallowRepository(repoRoot))) return true;
  if (!isCiBuild(env)) return false;
  if (isSet(env.GITHUB_ACTIONS)) {
    log.log(
      "[sitemap-lastmod] shallow clone on GitHub Actions, not fetching history. Check out with fetch-depth: 0 to date every page.",
    );
    return false;
  }
  log.log("[sitemap-lastmod] shallow clone on CI, fetching full history...");
  if (await unshallow(repoRoot, timeoutMs)) {
    log.log("[sitemap-lastmod] full history fetched.");
    return true;
  }
  log.warn(
    "[sitemap-lastmod] could not fetch full history, continuing with what is available.",
  );
  return false;
}

async function main(): Promise<void> {
  const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const outDir = process.env.BASCIK_OUT_DIR ?? join(docsDir, "dist");
  const sitemapFile = join(outDir, "sitemap.xml");

  if (!existsSync(sitemapFile)) {
    console.warn(
      `[sitemap-lastmod] ${sitemapFile} not found, skipping. Set BASCIK_SITE_URL so the build writes a sitemap.`,
    );
  } else {
    const repoRoot = await findRepoRoot(docsDir);

    if (repoRoot) await ensureFullHistory(repoRoot);

    const summary = repoRoot
      ? await addGitLastmod(
          await readFile(sitemapFile, "utf8"),
          docsDir,
          repoRoot,
        )
      : null;

    if (!summary) {
      console.warn(
        "[sitemap-lastmod] not a git checkout, leaving sitemap.xml without <lastmod>.",
      );
    } else {
      await writeFile(sitemapFile, summary.xml);
      console.log(
        `[sitemap-lastmod] added <lastmod> to ${summary.dated} of ${summary.total} URLs.`,
      );
      if (summary.dated < summary.total) {
        const hint = summary.shallow
          ? " This is a shallow clone, so commits before its cut-off are unknown. Fetch full history (git fetch --unshallow, or fetch-depth: 0 in CI) to date every page."
          : "";
        console.warn(
          `[sitemap-lastmod] ${summary.total - summary.dated} URLs have no committed source history and were left undated.${hint}`,
        );
      }

      let articlesDated = 0;
      for (const [loc, times] of summary.timesByLoc) {
        const pageFile = builtPageFor(routeOf(loc), outDir);
        if (!pageFile) continue;
        const html = await readFile(pageFile, "utf8");
        const dated = injectArticleDates(html, times);
        if (dated === html) continue;
        await writeFile(pageFile, dated);
        articlesDated++;
      }
      console.log(
        `[article-dates] added dateModified to ${articlesDated} TechArticle pages.`,
      );
    }
  }
}

// Only when run as a script (pipeline.exec spawns it with node), so the test can import ensureFullHistory.
if (import.meta.main) await main();
