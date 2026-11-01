// links.ts: the main navigation, in one place. Edit this list for your site. site-header.html imports it from a
// build script, so the links are plain HTML in every page and the current page is marked without JavaScript.
// Paths are relative to the deployment base; Bascik adds the base for you. The markup is built with html from
// @bascik/bascik/html, which escapes each label and href for where it lands, so there is no escaper to write.
import { html, type SafeHtml } from "@bascik/bascik/html";

export interface NavLink {
  label: string;
  href: string;
}

export const NAV_LINKS: NavLink[] = [
  { label: "Home", href: "/" },
  { label: "About", href: "/about" },
  { label: "Blog", href: "/blog/" },
  { label: "Contact", href: "/contact" },
];

/** "/blog/" and "/blog" compare equal; "/" only matches the home page. */
const normalize = (path: string): string =>
  path.length > 1 ? path.replace(/\/+$/, "") : path;

/** True when `href` is the current page, or a section that contains it ("/blog/" for "/blog/hello/"). */
export function isCurrent(href: string, pagePath: string): boolean {
  const target = normalize(href);
  const current = normalize(pagePath);
  if (target === "/") return current === "/";
  return current === target || current.startsWith(`${target}/`);
}

/** One nav item. aria-current is "page" for the page itself and "true" for the section it belongs to. */
function navItem(link: NavLink, current?: "page" | "true"): SafeHtml {
  const { href, label } = link;
  // A hole cannot add or remove an attribute, so the tag is written twice and code picks one.
  const anchor = current
    ? html`<a href="${href}" aria-current="${current}">${label}</a>`
    : html`<a href="${href}">${label}</a>`;
  return html`<li>${anchor}</li>`;
}

/** The nav list for one page. `pagePath` is the page being built, from BASCIK_PAGE_PATH. */
export function navLinks(pagePath = "/", links = NAV_LINKS): SafeHtml {
  const items = links.map((link) =>
    navItem(
      link,
      normalize(link.href) === normalize(pagePath)
        ? "page"
        : isCurrent(link.href, pagePath)
          ? "true"
          : undefined,
    ),
  );
  return html`<ul class="nav-list">
    ${items}
  </ul>`;
}
