/**
 * Builds the Cloudflare Pages `_headers` file for the docs site.
 *
 * Pages ignores Bascik's `http.cacheControl` (that option only configures `bascik --server`), so edge caching
 * is set with a `_headers` file at the root of the output. Bascik does not copy extensionless files, so
 * scripts/generate-pages-headers.ts writes this text during the build.
 *
 * Only URLs that carry a content hash get the far-future `immutable` rule: the image folders listed in
 * VERSIONED_IMAGE_FOLDERS (md-renderer.ts) and the search index (search-index.ts).
 *
 * Pages: Pages sends no ETag or Last-Modified for HTML (checked on bascik.dev and on the pages.dev alias
 * directly, so no zone feature removes them), so a browser cannot get a 304 for a page. The pages keep
 * `max-age=0`, so every visit still asks for the latest deploy, and add `stale-while-revalidate`, so a repeat
 * visit shows the cached page at once while that request runs. A deploy reaches a returning visitor one
 * visit later at most. The rules name pages by URL shape (`/`, `/:page` and `/<folder>/:page` for each folder
 * of pages), not with `/*`, because Pages joins a header set by two matching rules with a comma, and `/*`
 * would also match the immutable files.
 *
 * Speculation rules are not sent here. A `Speculation-Rules` header names a rules file, which is one more request
 * before first paint on every page, so the rules are inline in docs-head and hashed into each page's policy.
 *
 * The production `*.pages.dev` alias serves the same pages as bascik.dev. Pages already sends `noindex` for
 * preview deployments, but not for that alias, so a host-scoped rule keeps it out of search results. The
 * `:project` placeholder matches any project name, so the rule never touches the custom domain.
 */
import { readdirSync } from "node:fs";
import { relative, sep } from "node:path";

export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** Cache-Control for pages: always check for a new deploy, but show the cached page while checking. */
export const HTML_CACHE_CONTROL =
  "public, max-age=0, stale-while-revalidate=86400";

export const SECURITY_HEADERS_RULE = `/*\n  Content-Security-Policy: frame-ancestors 'none'; object-src 'none'; base-uri 'self'\n  X-Frame-Options: DENY\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n`;

export const PAGES_DEV_NOINDEX_RULE =
  "https://:project.pages.dev/*\n  X-Robots-Tag: noindex\n";

export interface PagesHeadersOptions {
  /** Site folders that hold pages, like `/deployment/`. See `pageFolders`. */
  pageFolders?: readonly string[];
  /** Single files whose URLs carry a content hash. */
  versionedFiles?: readonly string[];
}

export function pagesHeaders(
  versionedFolders: readonly string[],
  { pageFolders = [], versionedFiles = [] }: PagesHeadersOptions = {},
): string {
  const pageRule = (pattern: string) =>
    `${pattern}\n  Cache-Control: ${HTML_CACHE_CONTROL}\n`;
  return [
    SECURITY_HEADERS_RULE,
    PAGES_DEV_NOINDEX_RULE,
    pageRule("/"),
    pageRule("/:page"),
    ...pageFolders.map((folder) => pageRule(`${folder}:page`)),
    ...versionedFolders.map(
      (folder) => `${folder}*\n  Cache-Control: ${IMMUTABLE_CACHE_CONTROL}\n`,
    ),
    ...versionedFiles.map(
      (file) => `${file}\n  Cache-Control: ${IMMUTABLE_CACHE_CONTROL}\n`,
    ),
  ].join("\n");
}

/** Site folders under `pagesDir` that contain pages, like `/deployment/`. The assets folder is not one. */
export function pageFolders(pagesDir: string): string[] {
  const folders = new Set<string>();
  for (const entry of readdirSync(pagesDir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith(".html")) continue;
    const folder = relative(pagesDir, entry.parentPath).split(sep).join("/");
    if (folder && folder !== "assets" && !folder.startsWith("assets/"))
      folders.add(`/${folder}/`);
  }
  return [...folders].sort();
}

export interface HeaderRule {
  pattern: string;
  headers: Array<[string, string]>;
}

/** The path rules of a `_headers` file, in order. Host rules (`https://...`) are left out. */
export function parseHeaderRules(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let current: HeaderRule | null = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) {
      current = line.startsWith("/")
        ? { pattern: line.trim(), headers: [] }
        : null;
      if (current) rules.push(current);
      continue;
    }
    if (!current) continue;
    const colon = line.indexOf(":");
    current.headers.push([
      line.slice(0, colon).trim(),
      line.slice(colon + 1).trim(),
    ]);
  }
  return rules;
}

/**
 * The headers Pages sends for `path`, by lower-case name, with one value per matching rule. Pages joins those
 * values with commas, so more than one value for Cache-Control means a broken header. As on Pages, `*` matches
 * the rest of the path and `:name` matches one path segment.
 */
export function headersForPath(
  rules: readonly HeaderRule[],
  path: string,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const rule of rules) {
    const source = rule.pattern
      .split(/(\*|:[A-Za-z]\w*)/)
      .map((part) =>
        part === "*"
          ? ".*"
          : part.startsWith(":")
            ? "[^/]+"
            : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("");
    if (!new RegExp(`^${source}$`).test(path)) continue;
    for (const [name, value] of rule.headers)
      (result[name.toLowerCase()] ??= []).push(value);
  }
  return result;
}
