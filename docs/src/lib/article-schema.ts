/**
 * article-schema.ts
 *
 * Generates a TechArticle JSON-LD script tag for a docs content page,
 * deriving headline, description, and URL from the page's own <title> and
 * <meta name="description"> so the schema stays in sync with those tags.
 *
 * Usage inside a <script data-bascik-build> block:
 *
 *   import { articleSchema } from '@/lib/article-schema.ts';
 *   export default async () => await articleSchema();
 */
import { readFile } from "node:fs/promises";
import { socialImageUrl } from "./open-graph.ts";

/** Official Bascik profiles. Lets search engines connect the site to the same entity. */
export const BRAND_SAME_AS = [
  "https://github.com/bascikdev/bascik",
  "https://www.npmjs.com/package/@bascik/bascik",
  "https://youtube.com/@bascikdev",
  "https://x.com/bascikdev",
  "https://www.instagram.com/bascik.dev/",
] as const;

export async function articleSchema(): Promise<string> {
  const pageFile =
    process.env.BASCIK_SOURCE_FILE ?? process.env.BASCIK_PAGE_FILE ?? "";
  const pagesDir = process.env.BASCIK_PAGES_DIR ?? "";
  const siteUrl = (process.env.BASCIK_SITE_URL ?? "").replace(/\/$/, "");
  if (!pageFile || !siteUrl) return "";

  let html: string;
  try {
    html = await readFile(pageFile, "utf8");
  } catch (err) {
    console.warn(
      `[article-schema] Warning: Could not read page file "${pageFile}": ${(err as Error).message}`,
    );
    return "";
  }
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/);
  const descMatch =
    html.match(
      /<meta\b[^>]*\bname=["']description["'][^>]*\bcontent=["']([^"']+)["']/i,
    ) ||
    html.match(
      /<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*\bname=["']description["']/i,
    );
  if (!titleMatch || !descMatch) return "";

  const headline = titleMatch[1]
    .trim()
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const description = descMatch[1]
    .trim()
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const relPath = pageFile.startsWith(pagesDir)
    ? pageFile
        .slice(pagesDir.length)
        .replace(/^[\\/]/, "")
        .replace(/\\/g, "/")
    : "";
  const withoutExt = relPath.replace(/\.html$/, "");
  const routePath =
    withoutExt === "index" ? "" : withoutExt.replace(/\/index$/, "/");
  const urlPath = routePath ? `/${routePath}` : "/";
  const url = `${siteUrl}${urlPath}`;

  const schema = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    mainEntityOfPage: url,
    headline,
    description,
    image: socialImageUrl(siteUrl, urlPath, withoutExt),
    inLanguage: "en-US",
    url,
    author: {
      "@type": "Person",
      name: "Collin Thomas",
      url: "https://github.com/collin-thomas",
    },
    publisher: {
      "@type": "Organization",
      name: "Bascik",
      url: "https://bascik.dev",
      logo: {
        "@type": "ImageObject",
        url: `${siteUrl}/assets/apple-touch-icon.png`,
      },
      sameAs: [...BRAND_SAME_AS],
    },
  };

  return `<script type="application/ld+json">\n${JSON.stringify(schema, null, 2).replace(/</g, "\\u003c")}\n</script>`;
}
