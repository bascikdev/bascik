/**
 * Builds the Cloudflare Pages `_headers` file for the docs site.
 *
 * Pages ignores Bascik's `http.cacheControl` (that option only configures `bascik --server`), so edge caching
 * is set with a `_headers` file at the root of the output. Bascik does not copy extensionless files, so
 * scripts/generate-pages-headers.ts writes this text during the build.
 *
 * Only folders whose image URLs carry a content hash (see VERSIONED_IMAGE_FOLDERS in md-renderer.ts) get the
 * far-future `immutable` rule. Everything else keeps the host default, which revalidates.
 *
 * The production `*.pages.dev` alias serves the same pages as bascik.dev. Pages already sends `noindex` for
 * preview deployments, but not for that alias, so a host-scoped rule keeps it out of search results. The
 * `:project` placeholder matches any project name, so the rule never touches the custom domain.
 */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export const SECURITY_HEADERS_RULE = `/*\n  Content-Security-Policy: frame-ancestors 'none'; object-src 'none'; base-uri 'self'\n  X-Frame-Options: DENY\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n`;

export const PAGES_DEV_NOINDEX_RULE = 'https://:project.pages.dev/*\n  X-Robots-Tag: noindex\n';

export function pagesHeaders(versionedFolders: readonly string[]): string {
  return [
    SECURITY_HEADERS_RULE,
    PAGES_DEV_NOINDEX_RULE,
    ...versionedFolders.map((folder) => `${folder}*\n  Cache-Control: ${IMMUTABLE_CACHE_CONTROL}\n`),
  ].join('\n');
}
