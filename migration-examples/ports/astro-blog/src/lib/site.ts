// Place any global data in this file. Mirrors the upstream `src/consts.ts`.
export const SITE_TITLE = 'Bascik Port Blog';
export const SITE_DESCRIPTION = 'A Bascik port of the official Astro blog example.';

/** Escape text for an HTML text node or a double-quoted attribute value. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Absolute site origin without a trailing slash. Hard-fails rather than emitting relative metadata. */
export function siteOrigin(): string {
  const origin = process.env.BASCIK_SITE_URL;
  if (!origin) throw new Error('BASCIK_SITE_URL is required to emit canonical, Open Graph, and feed URLs.');
  return origin.replace(/\/$/, '');
}

/** Normalized page route with a trailing slash, matching the upstream canonical URLs. */
export function pagePath(): string {
  const path = process.env.BASCIK_PAGE_PATH ?? '/';
  return path.endsWith('/') ? path : `${path}/`;
}

/** `Jun 19, 2024` in the en-US short style used by the upstream FormattedDate component. */
export function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
