/**
 * Generates a <link rel="canonical"> tag for the current page.
 *
 * Reads context from env vars injected by bascik's build-script runner:
 *   BASCIK_SITE_URL  — the siteUrl from bascik.config.ts
 *   BASCIK_PAGE_FILE — absolute path to the page file being built
 *   BASCIK_PAGES_DIR — absolute path to the configured pages directory
 *
 * Usage inside a <script data-bascik-build> block:
 *
 *   import { join } from 'node:path';
 *   import { pathToFileURL } from 'node:url';
 *   const { canonical } = await import(
 *     pathToFileURL(join(process.cwd(), 'src/lib/canonical.ts')).href
 *   );
 *   console.log(await canonical());
 */

export async function canonical(routeOverride?: string): Promise<string> {
  const siteUrl = process.env.BASCIK_SITE_URL ?? '';
  const base = process.env.BASCIK_BASE ?? '/';
  const pageFile = process.env.BASCIK_SOURCE_FILE ?? process.env.BASCIK_PAGE_FILE ?? '';
  const pagesDir = process.env.BASCIK_PAGES_DIR ?? '';

  if (!siteUrl || !pageFile || !pagesDir) return '';

  if (routeOverride) {
    const normalizedOverride = routeOverride.startsWith('/') ? routeOverride : `/${routeOverride}`;
    const cleanBase = base === '/' ? '' : base.replace(/\/+$/, '');
    return `<link rel="canonical" href="${siteUrl}${cleanBase}${normalizedOverride}" />`;
  }

  const relPath = pageFile.startsWith(pagesDir)
    ? pageFile.slice(pagesDir.length).replace(/^[\\/]/, '').replace(/\\/g, '/')
    : '';

  if (!relPath) return '';

  const withoutExt = relPath.replace(/\.html$/, '');
  const routePath = withoutExt === 'index' ? '' : withoutExt.replace(/\/index$/, '/');
  const urlPath = routePath ? `/${routePath}` : '/';

  const cleanBase = base === '/' ? '' : base.replace(/\/+$/, '');
  return `<link rel="canonical" href="${siteUrl}${cleanBase}${urlPath}" />`;
}
