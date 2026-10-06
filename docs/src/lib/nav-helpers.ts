/**
 * nav-helpers.ts: shared rendering for NAV entries shown in the sidebar, the
 * mobile nav, and the footer sitemap. Kept separate from nav.ts (the data) and
 * render-nav.ts (build-time pagination) so every off-site link looks the same
 * in each surface.
 *
 * The markup these helpers emit is printed by a `data-bascik-build` script, so
 * Bascik scopes its element/class names per component. That means class-based
 * styling (and the global `.sr-only` used elsewhere) would not resolve here.
 * Like social-links.ts, the external indicator is therefore fully self-contained:
 * an inline SVG plus an inline-styled visually-hidden label, so it renders
 * correctly inside all three scoped components without triplicated CSS.
 *
 * External entries (nav.ts `external: true`) open in a new tab and show an
 * "opens in a new tab" indicator. They are excluded from pagination, the search
 * index, llms.txt, OG images, and the Lighthouse audit, since they have no local
 * page or content Markdown.
 */

import type { NavPage } from './nav.ts';

/** True when a NAV page points off-site and should render as an external link. */
export function isExternalNavPage(page: NavPage): boolean {
  return page.external === true || /^https?:\/\//i.test(page.href);
}

/**
 * A small "arrow out of a box" glyph that marks an off-site link. Decorative, so
 * it is aria-hidden; the visually-hidden text carries the meaning for assistive
 * tech. Sized and aligned with attributes/inline style so no scoped CSS is needed.
 */
const EXTERNAL_ICON =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ' +
  'focusable="false" style="margin-left:4px;flex:none">' +
  '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>' +
  '<polyline points="15 3 21 3 21 9"/>' +
  '<line x1="10" y1="14" x2="21" y2="3"/>' +
  '</svg>';

/** Inline visually-hidden style (the standard .sr-only technique) for the label. */
const SR_ONLY_STYLE =
  'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;' +
  'clip:rect(0,0,0,0);white-space:nowrap;border:0';

/**
 * Renders one sidebar/mobile/footer `<li>` for a NAV page. Internal pages emit a
 * plain same-tab link; external pages open in a new tab and append the icon plus
 * a screen-reader " (opens in a new tab)" label.
 */
export function renderNavListItem(page: NavPage): string {
  if (isExternalNavPage(page)) {
    return (
      `<li><a href="${page.href}" target="_blank" rel="noopener noreferrer">` +
      `${page.label}${EXTERNAL_ICON}` +
      `<span style="${SR_ONLY_STYLE}"> (opens in a new tab)</span></a></li>`
    );
  }
  return `<li><a href="${page.href}">${page.label}</a></li>`;
}
