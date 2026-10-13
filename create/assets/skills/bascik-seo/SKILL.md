---
name: bascik-seo
description: Search, social sharing, and AI discoverability for Bascik sites. Use when adding page titles, meta descriptions, canonical URLs, Open Graph or Twitter cards, JSON-LD structured data (Article, BreadcrumbList, Organization, FAQ), noindex, sitemap.xml, robots.txt, llms.txt, or social images; when fixing Lighthouse SEO findings or duplicate titles; or when generating meta tags for dynamic routes. Includes an SEO audit script for the built site.
license: MIT
metadata:
  author: bascik
  homepage: https://bascik.dev
---

# SEO, Social Cards, and Discoverability

Bascik outputs static HTML, so search engines and AI crawlers read every word without running JavaScript. The work is correct head tags on every page plus the files crawlers look for. Requires the `bascik` skill; `bascik-scripts` covers build scripts and dynamic routes.

## Every page needs

| Tag | Rule |
|---|---|
| `<html lang>` and `<meta name="viewport">` | On every page, usually from a shared head component |
| `<title>` | Unique, 10 to 65 characters, most specific part first: `Pricing - Acme` |
| `<meta name="description">` | Unique, 50 to 160 characters, written for a person reading search results |
| `<link rel="canonical">` | Absolute URL of this page, including the base, only when the site URL is known |
| `og:title`, `og:description`, `og:url`, `og:type` | Social previews; an absolute `og:image` (1200x630) for a large card |
| One `<h1>` | Matches the title's intent |

## Rules (must follow)

1. **Write per-page tags from the page, not from a shared component.** A component's build script runs once for the whole site unless it is marked `data-bascik-build="page"`, so every page would get the first page's canonical URL.
2. **Never hard-code the domain.** URLs come from `BASCIK_SITE_URL` (CI variable or `.env`), `BASCIK_BASE`, and `BASCIK_PAGE_PATH`. `bascik --build` fails without the site URL because it writes the sitemap and robots.txt.
3. **Escape every value** you interpolate into a tag. For JSON-LD, `JSON.stringify` and replace `<` with `\u003c` so data can never close the script tag. Describe only what is visible on the page.
4. **Dynamic routes** read the item from `BASCIK_ROUTE` in the head build script and pass its fields to the tag helper.
5. **A noindex page also needs `<meta name="bascik-sitemap" content="exclude" />` written literally in its source.** Bascik reads the source file, not script output, to decide what `sitemap.xml` lists. 404 and 500 pages are excluded automatically.
6. **Keep authored `robots.txt` and `sitemap.xml` only for custom rules**, and turn off the matching `generate` flag. Otherwise let Bascik generate them.

Copy a tested helper instead of writing one: `add-example.mjs starter-site/src/lib/seo.ts` gives `seo({ title, description, image, type, noindex, ... })`, `jsonLd()`, `breadcrumbList()`, and `article()`. `add-example.mjs starter-site/scripts/llms-txt.ts` adds a post-phase exec script that writes `llms.txt` from every indexable page's title and description.

## Audit the build

```sh
BASCIK_SITE_URL=https://example.com npx bascik --build
node <skills-dir>/bascik-seo/scripts/audit-seo.mjs            # reads the site URL from the environment or .env
node <skills-dir>/bascik-seo/scripts/audit-seo.mjs --strict   # fail on warnings too (CI)
```

- **error**: missing title, description, `lang`, or viewport; invalid JSON-LD; relative canonical or `og:image`.
- **warn**: lengths outside the ranges above, duplicate titles or descriptions, not exactly one `<h1>`, images without `alt`, missing canonical or Open Graph tags, a canonical that points at another page, a noindex page still in `sitemap.xml`, missing `sitemap.xml` or `robots.txt`.
- **info**: noindex pages and pages without `og:image`.

Also run `node <skills-dir>/bascik/scripts/check-links.mjs` for broken links and `#fragments`.

## Look it up

| How do I... | Read |
|---|---|
| Write the essential head tags and JSON-LD | `/lighthouse/seo` |
| Control `sitemap.xml`, `robots.txt`, and lastmod dates | `/sitemap` |
| Publish `llms.txt` and support AI agents | `/lighthouse/agentic-browsing` |
| Generate per-page canonical URLs and titles | `/how-to/page-aware-scripts` |
| See the helper in a working site | `/examples/starter-site#seo-tags` |
| Serve files under `/.well-known/` | `/deployment#well-known-uris` |

`node <skills-dir>/bascik/scripts/read-doc.mjs <path>` prints any of these.
