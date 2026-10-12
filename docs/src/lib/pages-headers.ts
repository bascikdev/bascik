/**
 * Builds the Cloudflare Pages `_headers` file for the docs site.
 *
 * Pages ignores Bascik's `http.cacheControl` (that option only configures `bascik --server`), so edge caching
 * is set with a `_headers` file at the root of the output. Bascik does not copy extensionless files, so
 * scripts/generate-pages-headers.ts writes this text during the build.
 *
 * Only folders whose image URLs carry a content hash (see VERSIONED_IMAGE_FOLDERS in md-renderer.ts) get the
 * far-future `immutable` rule. Everything else keeps the host default, which revalidates.
 */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';


export function pagesHeaders(versionedFolders: readonly string[]): string {
  return versionedFolders
    .map((folder) => `${folder}*\n  Cache-Control: ${IMMUTABLE_CACHE_CONTROL}\n`)
    .join('\n');
}
