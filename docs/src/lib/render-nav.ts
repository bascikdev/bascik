/**
 * render-nav.ts — Build-time pagination generator.
 *
 * Usage in a page's `<script data-bascik-build>` block:
 *
 *   <script data-bascik-build>
 *     import { join } from 'node:path';
 *     import { pathToFileURL } from 'node:url';
 *     const { renderPagination } = await import(
 *       pathToFileURL(join(process.cwd(), 'src/lib/render-nav.ts')).href
 *     );
 *     console.log(renderPagination('/getting-started'));
 *   </script>
 *
 * Nav, sidebar, and footer are bascik components — see src/components/.
 * Page order comes from nav.ts (the single source of truth).
 */

import { NAV } from './nav.ts';

function resolveRoutePath(currentPath?: string): string {
  let path = currentPath || process.env.BASCIK_PAGE_PATH;
  if (!path) {
    // Fallback for older runners or custom callers
    const pageFile = process.env.BASCIK_SOURCE_FILE ?? process.env.BASCIK_PAGE_FILE ?? '';
    const pagesDir = process.env.BASCIK_PAGES_DIR ?? '';
    if (pageFile && pagesDir && pageFile.startsWith(pagesDir)) {
      const relPath = pageFile.slice(pagesDir.length).replace(/^[\\/]/, '').replace(/\\/g, '/');
      const withoutExt = relPath.replace(/\.html$/, '');
      path = withoutExt === 'index' ? '/' : `/${withoutExt.replace(/\/index$/, '/')}`;
    }
  }
  if (!path) return '';
  return path === '/using-markdown' ? '/recipes/markdown' : path;
}

/**
 * Renders the section label <p class="section-label">...</p> for a given page.
 * Returns an empty string when currentPath is not found in NAV.
 *
 * @param {string} [currentPath] - e.g. '/slots' (auto-detected from env if omitted)
 */
export function renderSectionLabel(currentPath?: string): string {
  const path = resolveRoutePath(currentPath);
  if (!path) return '';
  const section = NAV.find(s => s.pages.some(p => p.href === path));
  if (!section) return '';
  return `<p class="section-label">${section.section}</p>`;
}

/**
 * Renders the prev/next pagination <nav> for a given page. Returns an
 * empty string when currentPath is not found in NAV or is the only page.
 *
 * @param {string} [currentPath] - e.g. '/slots' (auto-detected from env if omitted)
 */
export function renderPagination(currentPath?: string): string {
  const path = resolveRoutePath(currentPath);
  if (!path) return '';
  const flat = NAV.flatMap(s => s.pages.map(p => ({ ...p, section: s.section })));
  const idx = flat.findIndex(p => p.href === path);
  if (idx === -1) return '';
  const prev = idx > 0 ? flat[idx - 1] : null;
  const next = idx < flat.length - 1 ? flat[idx + 1] : null;
  if (!prev && !next) return '';
  let html = '<nav class="docs-pagination" aria-label="Page navigation">';
  if (prev) {
    html += `<a href="${prev.href}" data-pg="prev">`;
    html += `<span data-pg-dir>&#8592; Previous</span>`;
    html += `<span data-pg-section>${prev.section}</span>`;
    html += `<span data-pg-label>${prev.label}</span>`;
    html += `</a>`;
  }
  if (next) {
    html += `<a href="${next.href}" data-pg="next">`;
    html += `<span data-pg-dir>Next &#8594;</span>`;
    html += `<span data-pg-section>${next.section}</span>`;
    html += `<span data-pg-label>${next.label}</span>`;
    html += `</a>`;
  }
  html += '</nav>';
  return html;
}
