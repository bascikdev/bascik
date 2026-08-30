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
 *  - Strip the leading `pages/` segment (already done via getRelativePath).
 *  - Strip the `.html` extension.
 *  - `/index` at the end of a path becomes `/`.
 *  - `index.html` at the root becomes `/`.
 */
export const pagePathToUrlPath = (relativePath: string): string => {
  // relativePath is like "pages/index.html" or "pages/blog/post.html"
  let path = relativePath
    .replace(/^pages\//, "/")   // leading pages/ → /
    .replace(/\.html$/, "");    // strip .html extension

  // /index → /
  if (path === "/index") return "/";
  // /foo/index → /foo
  path = path.replace(/\/index$/, "");

  return path || "/";
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
export const generateSitemapFiles = async (): Promise<void> => {
  const { sitemap: doSitemap, robots: doRobots } = BascikConfig.generate;
  if (!doSitemap && !doRobots) return;

  if (!BascikConfig.siteUrl) {
    console.warn(
      "[bascik] generate: `siteUrl` is not set in bascik.config.ts — skipping sitemap/robots generation. " +
      "Set `siteUrl: 'https://example.com'` to enable.",
    );
    return;
  }

  const baseUrl = BascikConfig.siteUrl.replace(/\/+$/, ""); // trim trailing slash

  const writes: Promise<void>[] = [];

  if (doSitemap) {
    const pages = await listPages();
    const urlPaths = pages
      .map((p) => getRelativePath(p, "pages"))
      // Exclude the 404 page — it is an error document, not a crawlable URL.
      .filter((rel) => !is404Page(rel))
      .map(pagePathToUrlPath)
      .sort();
    const sitemapXml = buildSitemapXml(baseUrl, urlPaths);
    writes.push(
      writeFile("dist/sitemap.xml", sitemapXml, "utf8").then(() =>
        console.log("generated: dist/sitemap.xml"),
      ),
    );
  }

  if (doRobots) {
    const robotsTxt = buildRobotsTxt(baseUrl);
    writes.push(
      writeFile("dist/robots.txt", robotsTxt, "utf8").then(() =>
        console.log("generated: dist/robots.txt"),
      ),
    );
  }

  await Promise.all(writes);
};
