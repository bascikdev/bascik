# WordPress blog, ported to Bascik

A static Bascik site that serves the same visitor-facing pages as a WordPress 7.1.2 blog using the default theme, Twenty Twenty-Five: the home listing with pagination, single posts at date permalinks, category and tag archives, top-level and child pages with a page menu, previous and next links, an RSS feed, a sitemap, and a 404 page. Zero client JavaScript.

Content comes from one of two places:

| `WORDPRESS_URL` | Source | Use it when |
| --- | --- | --- |
| set | The site's public REST API (`/wp-json/wp/v2/`), media downloaded from `/wp-content/uploads/` | WordPress stays as the editor (headless) |
| unset | Markdown in `content/`, converted from a WordPress export | You are leaving WordPress |

Requires Node 24 and a Bascik release with large route payload support and printed-directive removal.

## Run

```sh
npm ci --ignore-scripts
BASCIK_SITE_URL=https://example.com npm run build   # writes dist/
npm run serve                                        # production server over dist/
npm run dev                                          # development server, drafts in content/ included
```

A build needs `BASCIK_SITE_URL` for the feed's absolute links. To build from a live site:

```sh
WORDPRESS_URL=https://cms.example.com BASCIK_SITE_URL=https://example.com npm run build
```

Only published content is public over REST, so drafts, private posts, and password-protected bodies never reach the build. Rebuild after every publish (a WordPress webhook or a scheduled CI job).

## Convert an export

In WordPress, Tools > Export > All content produces a WXR file. Convert it with the community tool [`wordpress-export-to-markdown`](https://github.com/lonekorean/wordpress-export-to-markdown) while the old site is still online (it downloads images from it):

```sh
npx wordpress-export-to-markdown --wizard=false --input=export.xml --output=content \
  --post-folders=true --date-folders=none --save-images=all --include-time=true
```

Then add `content/site.json` and fix what the export does not carry:

- `site.json`: `name`, `description`, `author`, and display names for categories and tags (`{"categories": {"notes": "Notes"}}`). The export only has slugs.
- A child page needs `parent: "<slug>"` and the menu order needs `order: <n>` in its front matter.
- A featured image needs `coverImageAlt`; the converter drops the alt text.
- Remove links to images the converter could not download. The build stops and names the missing file.
- Exported drafts have no date. They are skipped with a warning until you give them one.

## Where things are

| WordPress | Port |
| --- | --- |
| `header.html` template part, Page List block | `src/components/site-header/` |
| Query Loop, Query Pagination | `src/lib/render.ts` (`renderListing`), `src/pages/index.html`, `src/pages/page/[page]/` |
| `single.html` | `src/pages/[year]/[month]/[day]/[slug]/` |
| `page.html` (top level, child) | `src/pages/[pageslug]/`, `src/pages/[parent]/[child]/` |
| `archive.html` for categories and tags | `src/pages/category/[term]/`, `src/pages/tag/[term]/`, plus their `page/[page]/` |
| `/feed/` | `scripts/generate-feed.ts`, written to `/feed.xml` |
| `wp_kses` on save | `src/lib/html.ts` (`sanitize-html` allowlist) |

`scripts/sync-wordpress.ts` is a `pre` exec step. It reads all content once, sanitizes it, rewrites WordPress URLs to local paths, and writes a validated JSON snapshot to `node_modules/.cache/bascik-wordpress/`. Pages read only that file, so no page fetches anything.

## Differences from WordPress

- Comments, search (`/?s=`), date archives (`/2026/`, `/2026/03/`), author archives, and the admin are not ported. Comments and search need a hosted service.
- The feed is at `/feed.xml`, not `/feed/`. Add a redirect on the host for the old address.
- Empty categories (such as "Uncategorized") have no archive page; WordPress shows an empty one.
- Posts per page is 3, set in `src/lib/model.ts`. The REST API does not expose WordPress's Reading setting.
- Dates assume the site's timezone is UTC. Set the WordPress timezone to UTC or adjust `readableDate` and the feed.
- Only the default "Day and name" permalink structure and two levels of pages are supported.
- Markdown converted from an export has no resized image copies, and titles keep straight quotes (WordPress curls them when rendering).
- Embeds, scripts, iframes, inline event handlers, `javascript:` links, and custom elements in post bodies are removed. Allow more in `src/lib/html.ts` only for markup you trust.
- The look is original CSS, not Twenty Twenty-Five (which is GPL).
