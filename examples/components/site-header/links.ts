// links.ts: the main navigation, in one place. Edit this list for your site. site-header.html imports it from a
// build script, so the links are plain HTML in every page and the current page is marked without JavaScript.
// Paths are relative to the deployment base; Bascik adds the base for you.

export interface NavLink {
  label: string;
  href: string;
}

export const NAV_LINKS: NavLink[] = [
  { label: 'Home', href: '/' },
  { label: 'About', href: '/about' },
  { label: 'Blog', href: '/blog/' },
  { label: 'Contact', href: '/contact' },
];

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (ch) => ENTITIES[ch]);

/** "/blog/" and "/blog" compare equal; "/" only matches the home page. */
const normalize = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path);

/** True when `href` is the current page, or a section that contains it ("/blog/" for "/blog/hello/"). */
export function isCurrent(href: string, pagePath: string): boolean {
  const target = normalize(href);
  const current = normalize(pagePath);
  if (target === '/') return current === '/';
  return current === target || current.startsWith(`${target}/`);
}

/** The nav list for one page. `pagePath` is the page being built, from BASCIK_PAGE_PATH. */
export function navLinks(pagePath = '/', links: NavLink[] = NAV_LINKS): string {
  const items = links.map((link) => {
    const exact = normalize(link.href) === normalize(pagePath);
    // aria-current="page" for the page itself, "true" for the section it belongs to.
    const current = exact ? ' aria-current="page"' : isCurrent(link.href, pagePath) ? ' aria-current="true"' : '';
    return `<li><a href="${escapeHtml(link.href)}"${current}>${escapeHtml(link.label)}</a></li>`;
  });
  return `<ul class="nav-list">${items.join('')}</ul>`;
}
