/**
 * @module sitemap
 *
 * Sitemap and robots.txt Generation
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * When `generate.sitemap` and/or `generate.robots` are `true` (the defaults),
 * Bascik writes to `dist/` at the end of a build:
 *
 *   dist/sitemap.xml  — XML sitemap listing every HTML page
 *   dist/robots.txt   — robots directives pointing crawlers at the sitemap
 *
 * Both features need the site URL, which is a per-deployment value and so is
 * not a config key. It comes from `--site-url`, `BASCIK_SITE_URL`, or `.env`
 * (see environment.ts). A build with a feature enabled and no site URL fails
 * with a teaching error; it does not warn.
 *
 * Only runs during `bascik --build`. The dev server does not generate these
 * files.
 *
 * @example
 * ```sh
 * BASCIK_SITE_URL=https://example.com bascik --build
 * ```
 */

import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { BascikConfig } from "./config.ts";
import { getSiteUrl } from "./environment.ts";
import { listPages } from "./file-system.ts";
import { getRelativePath } from "./file-system.ts";
import { getHttpPath } from "./paths.ts";
import { composeSiteUrl } from "./base-path.ts";
import { manifestCollector } from "./manifest.ts";

/**
 * Escape the five XML metacharacters for safe interpolation into `<loc>` etc.
 * Applied to the configured site URL; URL paths derived from page
 * filenames are already safe but are escaped too for defense in depth.
 */
export const escapeXml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/**
 * Percent-encode each segment of an already canonical URL path for a sitemap.
 * Empty segments are retained so directory-index trailing slashes remain canonical.
 */
export const encodeUrlPath = (urlPath: string): string =>
  urlPath.split("/").map((segment) => encodeURIComponent(segment)).join("/");

/**
 * True when a relative page path resolves to the site's 404 page
 * (`pages/404.html` → `/404`). Mirrors the detection in `http2.ts` — a page
 * is the 404 page only when its resolved HTTP path is exactly `/404`, so
 * `pages/blog/404.html` (a page *about* 404s) does not match.
 */
export const is404Page = (relativePath: string): boolean =>
  getHttpPath(relativePath) === "/404";

/**
 * Check whether a page HTML contains `<meta name="bascik-sitemap" content="exclude">`.
 */
export const isPageExcludedFromSitemap = async (pageFilePath: string): Promise<boolean> => {
  try {
    const content = await readFile(pageFilePath, "utf8");
    return /<meta\b[^>]*\bname=["']bascik-sitemap["'][^>]*\bcontent=["']exclude["']/i.test(content) ||
      /<meta\b[^>]*\bcontent=["']exclude["'][^>]*\bname=["']bascik-sitemap["']/i.test(content);
  } catch {
    return false;
  }
};

export interface SitemapUrlEntry {
  path: string;
  lastmod?: string;
}

/**
 * Build the XML sitemap string from an array of URL paths or entries.
 */
export const buildSitemapXml = (
  siteUrl: string,
  entries: (string | SitemapUrlEntry)[],
  base = "/",
): string => {
  const urls = entries
    .map((entry) => {
      const path = typeof entry === "string" ? entry : entry.path;
      const lastmodTag = typeof entry === "object" && entry.lastmod ? `\n    <lastmod>${entry.lastmod}</lastmod>` : "";
      return `  <url>\n    <loc>${escapeXml(composeSiteUrl(siteUrl, base, path))}</loc>${lastmodTag}\n  </url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
};

/**
 * Build the robots.txt string pointing at the sitemap.
 */
export const buildRobotsTxt = (siteUrl: string, base = "/"): string =>
  `User-agent: *\nAllow: /\n\nSitemap: ${composeSiteUrl(siteUrl, base, "/sitemap.xml")}\n`;

/**
 * The error shown when a feature that needs the site URL is enabled and none
 * of the three sources (`--site-url`, `BASCIK_SITE_URL`, `.env`) supply one.
 * The build fails with this message; it does not warn.
 */
export const buildMissingSiteUrlError = (features: string[]): string => {
  const verb = features.length > 1 ? "are" : "is";
  const disable = features.map((f) => `${f}: false`).join(" and ");
  return (
    `[bascik] error: BASCIK_SITE_URL is not set, but ${features.join(" and ")} ${verb} enabled.\n` +
    `  Set it one of these ways:\n` +
    `    BASCIK_SITE_URL=https://example.com bascik --build\n` +
    `    echo 'BASCIK_SITE_URL=https://example.com' >> .env\n` +
    `    bascik --build --site-url https://example.com\n` +
    `  Or disable the feature${features.length > 1 ? "s" : ""} with ${disable}`
  );
};

/**
 * Generate `dist/sitemap.xml` and `dist/robots.txt`.
 *
 * Called by `processAllPages` at the end of a build. Skipped when both
 * `generate.sitemap` and `generate.robots` are `false`. Throws when either is
 * enabled and no site URL is available.
 */
export const generateSitemapFiles = async (
  transpiledPaths?: string[],
): Promise<void> => {
  const { sitemap: doSitemap, robots: doRobots, sitemapLastmod } = BascikConfig.generate;
  if (!doSitemap && !doRobots) return;

  const siteUrl = getSiteUrl();
  if (!siteUrl) {
    const features: string[] = [];
    if (doSitemap) features.push("generate.sitemap");
    if (doRobots) features.push("generate.robots");
    throw new Error(buildMissingSiteUrlError(features));
  }

  const pagesDir = resolve(process.cwd(), BascikConfig.directory.pages);
  const authoredRobotsPath = join(pagesDir, "robots.txt");
  const authoredSitemapPath = join(pagesDir, "sitemap.xml");

  const hasAuthoredRobots = existsSync(authoredRobotsPath);
  const hasAuthoredSitemap = existsSync(authoredSitemapPath);

  if (doRobots && hasAuthoredRobots) {
    console.warn(
      `warning: ${relative(process.cwd(), authoredRobotsPath)} exists, so generate.robots did not write ${join(BascikConfig.directory.out, "robots.txt")}.\n` +
      `  - To keep your authored file and silence this warning, set generate.robots: false\n` +
      `  - To use Bascik's generated file, delete ${relative(process.cwd(), authoredRobotsPath)}\n` +
      `  - Your authored robots.txt should include its own "Sitemap:" line`,
    );
  }

  if (doSitemap && hasAuthoredSitemap) {
    console.warn(
      `warning: ${relative(process.cwd(), authoredSitemapPath)} exists, so generate.sitemap did not write ${join(BascikConfig.directory.out, "sitemap.xml")}.\n` +
      `  - To keep your authored file and silence this warning, set generate.sitemap: false\n` +
      `  - To use Bascik's generated file, delete ${relative(process.cwd(), authoredSitemapPath)}`,
    );
  }

  await mkdir(BascikConfig.directory.out, { recursive: true });
  const writes: Promise<void>[] = [];

  if (doSitemap && !hasAuthoredSitemap) {
    const allPagePaths = await listPages();
    const rawPaths = transpiledPaths ?? allPagePaths.map((p) => getRelativePath(p, "pages"));

    const validPaths = rawPaths
      .map((p) => (p.startsWith("pages/") ? p : `pages/${p.replace(/^\/+/, "")}`))
      .filter((rel) => !is404Page(rel));

    // Remove duplicates and filter excluded meta
    const uniqueRawPaths = Array.from(new Set(validPaths));
    const entries: SitemapUrlEntry[] = [];

    for (const relPath of uniqueRawPaths) {
      const pageFile = resolve(pagesDir, relPath.replace(/^pages[\\/]/, ""));
      if (existsSync(pageFile)) {
        const isExcluded = await isPageExcludedFromSitemap(pageFile);
        if (isExcluded) continue;
      }

      const encodedPath = encodeUrlPath(getHttpPath(relPath));
      let lastmod: string | undefined;
      if (sitemapLastmod && existsSync(pageFile)) {
        try {
          const stat = statSync(pageFile);
          lastmod = stat.mtime.toISOString().split("T")[0];
        } catch {
          // ignore
        }
      }
      entries.push({ path: encodedPath, lastmod });
    }

    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const sitemapXml = buildSitemapXml(siteUrl, entries, BascikConfig.base);
    const sitemapPath = join(BascikConfig.directory.out, "sitemap.xml");
    const sitemapRel = relative(process.cwd(), sitemapPath);
    manifestCollector.recordFile(sitemapPath, sitemapXml);
    writes.push(
      writeFile(sitemapPath, sitemapXml, "utf8").then(() =>
        console.log(`generated: ${sitemapRel}`),
      ),
    );
  }

  if (doRobots && !hasAuthoredRobots) {
    const robotsTxt = buildRobotsTxt(siteUrl, BascikConfig.base);
    const robotsPath = join(BascikConfig.directory.out, "robots.txt");
    const robotsRel = relative(process.cwd(), robotsPath);
    manifestCollector.recordFile(robotsPath, robotsTxt);
    writes.push(
      writeFile(robotsPath, robotsTxt, "utf8").then(() =>
        console.log(`generated: ${robotsRel}`),
      ),
    );
  }

  await Promise.all(writes);
};
