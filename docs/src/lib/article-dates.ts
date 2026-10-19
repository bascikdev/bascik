/**
 * article-dates.ts
 *
 * Adds git-derived `dateModified` and `datePublished` to the TechArticle JSON-LD in built pages.
 *
 * The dates are written after the build, not by the `articleSchema()` build script, for two reasons:
 * - Build script output is cached by script text and dependency contents. Git history is not an input
 *   Bascik can see, so a cached TechArticle would keep an old date.
 * - Cloudflare Pages clones one commit. Full history is fetched in the post phase, after pages compile.
 *
 * The dates come from the same source files as the sitemap `<lastmod>` (see sitemap-lastmod.ts), so the
 * two never disagree.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PageCommitTimes } from "./sitemap-lastmod.ts";

const JSON_LD_RE =
  /(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/g;

/** `2026-10-12T13:21:00Z` for a unix time in seconds: an ISO 8601 date-time with a time zone. */
export function formatDateTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Sets `datePublished` (when known) and `dateModified` on every TechArticle JSON-LD block in `html`.
 * Other JSON-LD blocks and unparsable JSON are left exactly as they were. Running it twice changes nothing.
 */
export function injectArticleDates(
  html: string,
  times: PageCommitTimes,
): string {
  return html.replace(
    JSON_LD_RE,
    (block: string, open: string, body: string, close: string) => {
      let data: unknown;
      try {
        data = JSON.parse(body);
      } catch {
        return block;
      }
      if (
        typeof data !== "object" ||
        data === null ||
        (data as Record<string, unknown>)["@type"] !== "TechArticle"
      ) {
        return block;
      }
      const dated: Record<string, unknown> = {
        ...(data as Record<string, unknown>),
      };
      if (times.published !== undefined)
        dated.datePublished = formatDateTime(times.published);
      dated.dateModified = formatDateTime(times.modified);
      return `${open}\n${JSON.stringify(dated, null, 2).replace(/</g, "\\u003c")}\n${close}`;
    },
  );
}

/** Built HTML file for a route (`''` is the home page), or `null` when the build wrote none. */
export function builtPageFor(route: string, outDir: string): string | null {
  const candidates =
    route === ""
      ? ["index.html"]
      : [`${route}.html`, join(route, "index.html")];
  return (
    candidates
      .map((candidate) => join(outDir, candidate))
      .find((file) => existsSync(file)) ?? null
  );
}
