import { HOME_OG_IMAGE_PATH, SITE_DESCRIPTION, SITE_TITLE } from "./constants.ts";

/** Escape text for an HTML text node or a double-quoted attribute value. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Absolute site origin without a trailing slash. Next.js warns and falls back to
 * http://localhost:3000 when `metadataBase` is unset; the port fails instead, so a build never
 * ships social URLs that point at a developer machine.
 */
export function siteOrigin(): string {
  const origin = process.env.BASCIK_SITE_URL;
  if (!origin) throw new Error("BASCIK_SITE_URL is required to emit Open Graph and feed URLs.");
  return origin.replace(/\/$/, "");
}

type HeadOptions = { title?: string; image?: string };

/**
 * Equivalent of the root layout `metadata` export plus a page's `generateMetadata`. Next.js
 * merges both into `<head>`; here one function prints the whole computed part of the head.
 */
export function renderHead({ title = SITE_TITLE, image = HOME_OG_IMAGE_PATH }: HeadOptions = {}): string {
  const origin = siteOrigin();
  const t = escapeHtml(title);
  const d = escapeHtml(SITE_DESCRIPTION);
  const i = escapeHtml(`${origin}${image}`);
  return [
    `<title>${t}</title>`,
    `<meta name="description" content="${d}">`,
    `<meta property="og:title" content="${t}">`,
    `<meta property="og:description" content="${d}">`,
    `<meta property="og:image" content="${i}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${t}">`,
    `<meta name="twitter:description" content="${d}">`,
    `<meta name="twitter:image" content="${i}">`,
    `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(SITE_TITLE)}" href="${origin}/feed.xml">`,
  ].join("\n");
}
