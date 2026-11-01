// links.ts: the footer links. Edit this list for your site. site-footer.html prints it from a build script.
// The markup is built with html from @bascik/bascik/html, which escapes each label and href for where it lands and
// turns a javascript: link into about:invalid, so there is no escaper to write.
import { html, type SafeHtml } from "@bascik/bascik/html";

export interface FooterLink {
  label: string;
  href: string;
}

export const FOOTER_LINKS: FooterLink[] = [
  { label: "About", href: "/about" },
  { label: "Blog", href: "/blog/" },
  { label: "Feed", href: "/feed.xml" },
  { label: "Contact", href: "/contact" },
];

/** The footer link list. */
export function footerLinks(links: FooterLink[] = FOOTER_LINKS): SafeHtml {
  const items = links.map(
    (link) => html`<li><a href="${link.href}">${link.label}</a></li>`,
  );
  // An array of html values is inserted as it is: no .join("").
  return html`<ul class="links">
    ${items}
  </ul>`;
}
