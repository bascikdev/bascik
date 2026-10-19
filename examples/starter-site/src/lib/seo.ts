// src/lib/seo.ts: head tags for every page, generated at build time. Import from a page's <head>:
//
//   <script data-bascik-build>
//     import { seo } from '@/lib/seo.ts';
//     export default () => seo({ title: 'About - Acme', description: 'Who we are and what we build.' });
//   </script>
//
// Absolute URLs come from BASCIK_SITE_URL (set it per deployment, never in bascik.config.ts) and BASCIK_BASE.
// Every value is escaped, so titles from content files or APIs are safe to pass in.

export interface SeoOptions {
  /** The full document title, for example "Pricing - Acme". Unique per page, roughly 15 to 65 characters. */
  title: string;
  /** One or two sentences for search results, roughly 70 to 160 characters. */
  description: string;
  /** Social card image: a site path such as "/og/home.png" or an absolute URL. 1200x630 works everywhere. */
  image?: string;
  imageAlt?: string;
  /** "article" for posts, otherwise "website". */
  type?: "website" | "article";
  /** Site name for og:site_name. */
  siteName?: string;
  /**
   * Keep the page out of search results (thank-you pages, drafts, internal tools). Also write
   * <meta name="bascik-sitemap" content="exclude" /> literally in the page source: Bascik reads the source file,
   * not this script's output, to decide what sitemap.xml lists.
   */
  noindex?: boolean;
  /** Override the page path used for the canonical URL. Defaults to the page being built. */
  path?: string;
  /** ISO dates for articles. */
  publishedTime?: string;
  modifiedTime?: string;
}

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape text for HTML content and quoted attribute values. */
export const escapeHtml = (value: unknown): string =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ENTITIES[ch]);

/** The site origin without a trailing slash, or undefined when BASCIK_SITE_URL is not set (for example in dev). */
export const siteUrl = (): string | undefined =>
  process.env.BASCIK_SITE_URL?.replace(/\/+$/, "") || undefined;

/** The deployment base, always with leading and trailing slashes ("/" or "/docs/"). */
export const basePath = (): string => process.env.BASCIK_BASE || "/";

/** Path of the page being built, relative to the base, such as "/" or "/blog/hello-world/". */
export const pagePath = (): string => process.env.BASCIK_PAGE_PATH || "/";

/**
 * Absolute URL for a site path (relative to the base). Already-absolute URLs pass through. Without a site URL the
 * result is a root-relative path including the base.
 */
export function absoluteUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const withBase = `${basePath().replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  const origin = siteUrl();
  return origin ? `${origin}${withBase}` : withBase;
}

/** The canonical, Open Graph, and Twitter tags for one page. */
export function seo(options: SeoOptions): string {
  const tags: string[] = [];
  const meta = (
    attr: "name" | "property",
    key: string,
    value: string | undefined,
  ) => {
    if (value)
      tags.push(`<meta ${attr}="${key}" content="${escapeHtml(value)}" />`);
  };

  tags.push(`<title>${escapeHtml(options.title)}</title>`);
  meta("name", "description", options.description);
  if (options.noindex) meta("name", "robots", "noindex");

  // A canonical URL must be absolute, so it is only emitted when the site URL is known.
  const url = siteUrl() ? absoluteUrl(options.path ?? pagePath()) : undefined;
  if (url) tags.push(`<link rel="canonical" href="${escapeHtml(url)}" />`);

  meta("property", "og:type", options.type ?? "website");
  meta("property", "og:title", options.title);
  meta("property", "og:description", options.description);
  meta("property", "og:url", url);
  meta("property", "og:site_name", options.siteName);
  if (options.image) {
    meta("property", "og:image", absoluteUrl(options.image));
    meta("property", "og:image:alt", options.imageAlt);
  }
  if (options.type === "article") {
    meta("property", "article:published_time", options.publishedTime);
    meta("property", "article:modified_time", options.modifiedTime);
  }
  meta(
    "name",
    "twitter:card",
    options.image ? "summary_large_image" : "summary",
  );
  return tags.join("\n");
}

/**
 * A JSON-LD block. `<` is escaped so a value such as "</script>" can never close the tag early. Bascik leaves
 * application/ld+json scripts untouched.
 */
export function jsonLd(data: Record<string, unknown>): string {
  const json = JSON.stringify({
    "@context": "https://schema.org",
    ...data,
  }).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
}

/** BreadcrumbList data. Paths are relative to the base; the last item may omit its path. */
export function breadcrumbList(
  items: Array<{ name: string; path?: string }>,
): Record<string, unknown> {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      ...(item.path ? { item: absoluteUrl(item.path) } : {}),
    })),
  };
}

/** Article (BlogPosting) data for a post page. */
export function article(options: {
  headline: string;
  description?: string;
  datePublished: string;
  dateModified?: string;
  authorName?: string;
  image?: string;
}): Record<string, unknown> {
  return {
    "@type": "BlogPosting",
    headline: options.headline,
    ...(options.description ? { description: options.description } : {}),
    datePublished: options.datePublished,
    dateModified: options.dateModified ?? options.datePublished,
    ...(options.authorName
      ? { author: { "@type": "Person", name: options.authorName } }
      : {}),
    ...(options.image ? { image: absoluteUrl(options.image) } : {}),
    ...(siteUrl() ? { mainEntityOfPage: absoluteUrl(pagePath()) } : {}),
  };
}
