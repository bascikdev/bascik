/**
 * render-nav.ts — Build-time pagination generator.
 *
 * Usage in a page's `<script data-bascik-build>` block:
 *
 *   <script data-bascik-build>
 *     console.log(renderPagination('/getting-started'));
 *   </script>
 *
 * Nav, sidebar, and footer are bascik components — see src/components/.
 * Page order comes from nav.ts (the single source of truth).
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { NAV } from './nav.ts';

function resolveRoutePath(currentPath?: string): string {
  let path = currentPath || process.env.BASCIK_PAGE_PATH;
  if (!path) {
    const pageFile = process.env.BASCIK_SOURCE_FILE ?? process.env.BASCIK_PAGE_FILE ?? '';
    const pagesDir = process.env.BASCIK_PAGES_DIR ?? '';
    if (pageFile && pagesDir && pageFile.startsWith(pagesDir)) {
      const relPath = pageFile.slice(pagesDir.length).replace(/^[\\/]/, '').replace(/\\/g, '/');
      const withoutExt = relPath.replace(/\.html$/, '');
      const routePath = withoutExt === 'index' ? '' : withoutExt.replace(/\/index$/, '');
      path = routePath ? `/${routePath}` : '/';
    }
  }
  if (!path) return '';
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path === '/using-markdown') return '/how-to/markdown';
  if (path === '/how-to/cloudflare') return '/deployment/cloudflare';
  if (path === '/deploying') return '/deployment';
  return path;
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

function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Renders the current page's Markdown section links during the build. The
 * sidebar component calls this from a data-bascik-build script, leaving the
 * browser responsible only for indicating the section currently in view.
 */
export async function renderPageTableOfContents(pageContentPath?: string): Promise<string> {
  let pageFile = process.env.BASCIK_SOURCE_FILE ?? process.env.BASCIK_PAGE_FILE ?? '';
  if (!pageFile) {
    const route = resolveRoutePath();
    if (!route) return '';
    const pageRelativePath = route === '/'
      ? 'index.html'
      : route === '/deployment'
        ? 'deployment/index.html'
        : `${route.slice(1)}.html`;
    pageFile = join(process.cwd(), 'src/pages', pageRelativePath);
  }

  let pageSource: string;
  try {
    pageSource = await readFile(pageFile, 'utf8');
  } catch {
    return '';
  }

  const contentPaths = pageContentPath
    ? [join(process.cwd(), pageContentPath)]
    : [...pageSource.matchAll(/['"]\.\/content\/([^'"]+\.md)['"]/g)]
      .map(match => join(dirname(pageFile), 'content', match[1]));
  const uniqueContentPaths = [...new Set(contentPaths)];
  if (!uniqueContentPaths.length) return '';

  const headings: Array<{ level: 2 | 3; text: string; id: string }> = [];
  for (const contentPath of uniqueContentPaths) {
    let markdown: string;
    try {
      markdown = await readFile(contentPath, 'utf8');
    } catch {
      continue;
    }

    for (const match of markdown.matchAll(/^(#{2,3})\s+(.+?)\s*$/gm)) {
      const level = match[1].length as 2 | 3;
      const text = match[2].replace(/\s+#+\s*$/, '');
      headings.push({ level, text, id: slugifyHeading(text) });
    }
  }

  if (!headings.length) return '';
  let html = '';
  let subsectionListOpen = false;
  for (const heading of headings) {
    const link = `<a href="#${escapeHtml(heading.id)}" data-toc-level="${heading.level}">${escapeHtml(heading.text)}</a>`;
    if (heading.level === 2) {
      if (subsectionListOpen) html += '</ol></li>';
      html += `<li>${link}<ol class="docs-toc-subsections">`;
      subsectionListOpen = true;
    } else if (subsectionListOpen) {
      html += `<li>${link}</li>`;
    } else {
      html += `<li>${link}</li>`;
    }
  }
  if (subsectionListOpen) html += '</ol></li>';
  return html;
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
  const flat = NAV.flatMap(s => s.pages.filter(p => !p.external).map(p => ({ ...p, section: s.section })));
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
