/**
 * render-nav.ts: build-time pagination generator.
 *
 * Usage in a page's `<script data-bascik-build>` block:
 *
 *   <script data-bascik-build>
 *     console.log(renderPagination('/getting-started'));
 *   </script>
 *
 * Nav, sidebar, and footer are bascik components; see src/components/.
 * Page order comes from nav.ts (the single source of truth).
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { marked } from 'marked';
import { headingPlainText, slugFromHeadingHtml } from './heading-slug.ts';
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
  let contentPaths: string[];
  if (pageContentPath) {
    contentPaths = [resolve(process.cwd(), pageContentPath)];
  } else {
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
    contentPaths = [...pageSource.matchAll(/['"]\.\/content\/([^'"]+\.md)['"]/g)]
      .map(match => join(dirname(pageFile), 'content', match[1]));
  }
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

    // The lexer skips fenced code and indented code, and the heading HTML is
    // slugged by the same function md-renderer.ts uses for the page's ids.
    for (const token of marked.lexer(markdown)) {
      if (token.type !== 'heading' || (token.depth !== 2 && token.depth !== 3)) continue;
      const headingHtml = marked.parseInline(token.text, { async: false });
      headings.push({
        level: token.depth,
        text: headingPlainText(headingHtml),
        id: slugFromHeadingHtml(headingHtml),
      });
    }
  }

  if (!headings.length) return '';
  // Only data goes through the script. The list items, links, and nested lists
  // belong to the toc-entry and toc-sublist components, so their scoped CSS
  // applies; markup printed by a build script is not scoped.
  const entryOpen = (heading: { level: 2 | 3; text: string; id: string }): string =>
    `<toc-entry data-bascik-prop-href="#${escapeHtml(heading.id)}" ` +
    `data-bascik-prop-level="${heading.level}" ` +
    `data-bascik-prop-text="${escapeHtml(heading.text)}">`;
  let html = '';
  let subsectionListOpen = false;
  let subsectionHasItems = false;
  const closeSubsections = (): void => {
    if (!subsectionListOpen) return;
    // An h2 with no h3 children emits no empty sublist.
    html += subsectionHasItems ? '</toc-sublist></toc-entry>' : '</toc-entry>';
    subsectionListOpen = false;
    subsectionHasItems = false;
  };
  for (const heading of headings) {
    if (heading.level === 2) {
      closeSubsections();
      html += entryOpen(heading);
      subsectionListOpen = true;
    } else if (subsectionListOpen) {
      if (!subsectionHasItems) html += '<toc-sublist>';
      subsectionHasItems = true;
      html += `${entryOpen(heading)}</toc-entry>`;
    } else {
      html += `${entryOpen(heading)}</toc-entry>`;
    }
  }
  closeSubsections();
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
  const flat = NAV.flatMap(s => s.pages.map(p => ({ ...p, section: s.section })));
  const idx = flat.findIndex(p => p.href === path);
  if (idx === -1) return '';
  const prev = idx > 0 ? flat[idx - 1] : null;
  const next = idx < flat.length - 1 ? flat[idx + 1] : null;
  if (!prev && !next) return '';
  // Only data goes through the script. The <nav> and every link's markup and
  // styles belong to components (docs-pagination, pagination-link), so their
  // scoped CSS applies; build-script output is not scoped.
  const link = (item: { href: string; section: string; label: string }, dir: string, which: 'prev' | 'next'): string =>
    `<pagination-link data-bascik-prop-href="${escapeHtml(item.href)}" data-pg="${which}" ` +
    `data-bascik-prop-dir="${dir}" ` +
    `data-bascik-prop-section="${escapeHtml(item.section)}" ` +
    `data-bascik-prop-label="${escapeHtml(item.label)}"></pagination-link>`;
  let html = '';
  if (prev) html += link(prev, '\u2190 Previous', 'prev');
  if (next) html += link(next, 'Next \u2192', 'next');
  return html;
}
