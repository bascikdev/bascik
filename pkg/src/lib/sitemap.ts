/**
 * @module sitemap
 *
 * Sitemap and robots.txt Generation
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * When `generate.sitemap` and/or `generate.robots` are `true` (the defaults)
 * and `siteUrl` is configured, Bascik writes to `dist/` at the end of a build:
 *
 *   dist/sitemap.xml  — XML sitemap listing every HTML page
 *   dist/robots.txt   — robots directives pointing crawlers at the sitemap
 *
 * Only runs during `bascik --build`. The dev server does not generate these
 * files.
 *
 * @example bascik.config.ts
 * ```ts
 * export default {
 *   siteUrl: 'https://example.com',
 *   generate: { sitemap: true, robots: true }, // both default to true
 * };
 * ```
 */

import { writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { BascikConfig } from "./config.ts";
import { listPages } from "./file-system.ts";
import { getRelativePath } from "./file-system.ts";
import { getHttpPath } from "./paths.ts";

/**
 * Escape the five XML metacharacters for safe interpolation into `<loc>` etc.
 * Applied to the user-configured `siteUrl`; URL paths derived from page
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
 * Convert a relative page path (e.g. `pages/blog/post.html`) to an absolute
 * URL path (e.g. `/blog/post`) suitable for use in a sitemap.
 *
 * Rules:
 *  - Strip the leading `pages/` segment.
 *  - Strip the `.html` extension.
 *  - `/index` at the end of a path becomes `/`.
 *  - `index.html` at the root becomes `/`.
 *  - Percent-encode each path segment for non-ASCII characters.
 */
export const pagePathToUrlPath = (relativePath: string): string => {
  const clean = relativePath
    .replace(/^pages\//, "")
    .replace(/\.html$/, "");

  if (clean === "" || clean === "index") return "/";

  const segments = clean
    .split("/")
    .filter((s) => s.length > 0 && s !== "index")
    .map((s) => encodeURIComponent(s));

  if (segments.length === 0) return "/";
  return `/${segments.join("/")}`;
};

/**
 * True when a relative page path resolves to the site's 404 page
 * (`pages/404.html` → `/404`). Mirrors the detection in `http2.ts` — a page
 * is the 404 page only when its resolved HTTP path is exactly `/404`, so
 * `pages/blog/404.html` (a page *about* 404s) does not match.
 */
export const is404Page = (relativePath: string): boolean =>
  getHttpPath(relativePath) === "/404";

/**
 * Build the XML sitemap string from an array of URL paths.
 */
export const buildSitemapXml = (baseUrl: string, urlPaths: string[]): string => {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const safeBase = escapeXml(normalizedBase);
  const urls = urlPaths
    .map((p) => `  <url>\n    <loc>${safeBase}${escapeXml(p)}</loc>\n  </url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
};

/**
 * Build the robots.txt string pointing at the sitemap.
 */
export const buildRobotsTxt = (baseUrl: string): string => {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  return `User-agent: *\nAllow: /\n\nSitemap: ${normalizedBase}/sitemap.xml\n`;
};

/**
 * Generate `dist/sitemap.xml` and `dist/robots.txt`.
 *
 * Called by `processAllPages` at the end of a build. Skipped silently when
 * `generateSitemap` is `false` or `siteUrl` is not configured.
 */
export const generateSitemapFiles = async (
  transpiledPaths?: string[],
): Promise<void> => {
  const { sitemap: doSitemap, robots: doRobots } = BascikConfig.generate;
  if (!doSitemap && !doRobots) return;

  const siteUrl = (BascikConfig as any).siteUrl;
  if (!siteUrl) {
    console.warn(
      "[bascik] generate: `siteUrl` is not set in bascik.config.ts — skipping sitemap/robots generation. " +
      "Set `siteUrl: 'https://example.com'` to enable.",
    );
    return;
  }

  const baseUrl = siteUrl.replace(/\/+$/, ""); // trim trailing slash

  const writes: Promise<void>[] = [];

  if (doSitemap) {
    const rawPaths =
      transpiledPaths ??
      (await listPages()).map((p) => getRelativePath(p, "pages"));
    const urlPaths = rawPaths
      .map((p) => (p.startsWith("pages/") ? p : `pages/${p.replace(/^\/+/, "")}`))
      // Exclude the 404 page — it is an error document, not a crawlable URL.
      .filter((rel) => !is404Page(rel))
      .map(pagePathToUrlPath)
      .sort();
    const sitemapXml = buildSitemapXml(baseUrl, urlPaths);
    const sitemapPath = join(BascikConfig.directory.out, "sitemap.xml");
    const sitemapRel = relative(process.cwd(), sitemapPath);
    writes.push(
      writeFile(sitemapPath, sitemapXml, "utf8").then(() =>
        console.log(`generated: ${sitemapRel}`),
      ),
    );
  }

  if (doRobots) {
    const robotsTxt = buildRobotsTxt(baseUrl);
    const robotsPath = join(BascikConfig.directory.out, "robots.txt");
    const robotsRel = relative(process.cwd(), robotsPath);
    writes.push(
      writeFile(robotsPath, robotsTxt, "utf8").then(() =>
        console.log(`generated: ${robotsRel}`),
      ),
    );
  }

  await Promise.all(writes);
};
