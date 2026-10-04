import { join } from 'node:path';

// Site-wide data and small helpers. Mirrors the upstream `_data/metadata.js` and
// `_config/filters.js`. Build scripts import this file with the `@/` alias.

/** Directory holding the Markdown sources. Build scripts run with the project root as cwd. */
export const contentRoot = (): string => join(process.cwd(), 'content');

export const SITE = {
  title: 'Harbor Notes',
  description: 'Short notes from a small coastal workshop.',
  language: 'en',
  author: { name: 'Site Author' },
} as const;

// Upstream builds this from `eleventyNavigation` front matter keys and `order`.
export const NAV: ReadonlyArray<{ title: string; url: string }> = [
  { title: 'Home', url: '/' },
  { title: 'Archive', url: '/blog/' },
  { title: 'About', url: '/about/' },
  { title: 'Feed', url: '/feed/feed.xml' },
];

/**
 * Drafts are written in development and left out of production builds, which is
 * the upstream rule (`ELEVENTY_RUN_MODE === "build"` drops them). Bascik sets
 * BASCIK_BUILD to "1" for `bascik --build` and "0" for the dev server.
 */
export function includeDrafts(): boolean {
  return process.env.BASCIK_BUILD !== '1';
}

/** Escape text for an HTML text node or a double-quoted attribute value. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Decode the few entities that marked and escapeHtml produce. */
export function decodeEntities(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

/** Lowercase, accent-stripped, hyphen-separated. Used for tag URLs and heading ids. */
export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/** `01 May 2018`, the default of the upstream `readableDate` filter. */
export function readableDate(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
}

/** `May 2018`, used by the post lists (`readableDate("LLLL yyyy")` upstream). */
export function monthYear(date: Date): string {
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
}

/** `2018-05-01`, the upstream `htmlDateString` filter. */
export function htmlDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Absolute site origin without a trailing slash. Fails instead of emitting relative feed URLs. */
export function siteOrigin(): string {
  const origin = process.env.BASCIK_SITE_URL;
  if (!origin) throw new Error('BASCIK_SITE_URL is required for feed and sitemap URLs.');
  return origin.replace(/\/$/, '');
}

/** Normalized route of the page being built, with a trailing slash. */
export function pagePath(): string {
  const path = process.env.BASCIK_PAGE_PATH ?? '/';
  return path.endsWith('/') ? path : `${path}/`;
}
