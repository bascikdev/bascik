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

/**
 * Renders the section label <p class="section-label">...</p> for a given page.
 * Returns an empty string when currentPath is not found in NAV.
 *
 * @param {string} currentPath - e.g. '/slots'
 */
export function renderSectionLabel(currentPath: string): string {
  const path = currentPath === '/using-markdown' ? '/recipes/markdown' : currentPath;
  const section = NAV.find(s => s.pages.some(p => p.href === path));
  if (!section) return '';
  return `<p class="section-label">${section.section}</p>`;
}

/**
 * Renders the prev/next pagination <nav> for a given page. Returns an
 * empty string when currentPath is not found in NAV or is the only page.
 *
 * @param {string} currentPath - e.g. '/slots'
 */
export function renderPagination(currentPath: string): string {
  const flat = NAV.flatMap(s => s.pages);
  const idx = flat.findIndex(p => p.href === currentPath);
  if (idx === -1) return '';
  const prev = idx > 0 ? flat[idx - 1] : null;
  const next = idx < flat.length - 1 ? flat[idx + 1] : null;
  if (!prev && !next) return '';
  let html = '<nav class="docs-pagination" aria-label="Page navigation">';
  if (prev) {
    html += `<a href="${prev.href}" data-pg="prev">`;
    html += `<span data-pg-dir>&#8592; Previous</span>`;
    html += `<span data-pg-label>${prev.label}</span>`;
    html += `</a>`;
  }
  if (next) {
    html += `<a href="${next.href}" data-pg="next">`;
    html += `<span data-pg-dir>Next &#8594;</span>`;
    html += `<span data-pg-label>${next.label}</span>`;
    html += `</a>`;
  }
  html += '</nav>';
  return html;
}
