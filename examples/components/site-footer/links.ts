// links.ts: the footer links. Edit this list for your site. site-footer.html prints it from a build script.

export interface FooterLink {
  label: string;
  href: string;
}

export const FOOTER_LINKS: FooterLink[] = [
  { label: 'About', href: '/about' },
  { label: 'Blog', href: '/blog/' },
  { label: 'Feed', href: '/feed.xml' },
  { label: 'Contact', href: '/contact' },
];

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (ch) => ENTITIES[ch]);

/** The footer link list. */
export function footerLinks(links: FooterLink[] = FOOTER_LINKS): string {
  const items = links.map((link) => `<li><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></li>`);
  return `<ul class="links">${items.join('')}</ul>`;
}
