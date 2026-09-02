# Sitemap & robots.txt

Bascik generates a `sitemap.xml` and `robots.txt` automatically at build time. Set your site URL and both files appear in `dist/` alongside your compiled pages with no plugins, no extra steps.

Sitemap generation is on by default. The site URL is a per-deployment value, so it comes from the environment rather than the config file:

```sh
# Environment variable
BASCIK_SITE_URL=https://example.com bascik --build

# Or a .env file in the project root (loaded automatically)
echo 'BASCIK_SITE_URL=https://example.com' >> .env

# Or a per-invocation flag (overrides both)
bascik --build --site-url https://example.com
```

That's all, `generate.sitemap` and `generate.robots` both default to `true`, so no other change is needed. See [Configuration](/configuration#configuration-precedence) for the full precedence chain.

## What gets generated

**`dist/sitemap.xml`:** an XML sitemap listing every `.html` page in your `src/pages` directory as an absolute URL:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/</loc>
  </url>
  <url>
    <loc>https://example.com/about</loc>
  </url>
  <url>
    <loc>https://example.com/blog/post</loc>
  </url>
</urlset>
```

**`dist/robots.txt`:** allows all crawlers and points them at the sitemap:

```text
User-agent: *
Allow: /

Sitemap: https://example.com/sitemap.xml
```

## Authored file precedence and source-tree checks

If you author your own `src/pages/robots.txt` or `src/pages/sitemap.xml`, Bascik preserves your authored file and skips writing the generated version.

Bascik checks for the existence of authored files in `directory.pages` (the source tree), never in `directory.out` (the output tree). Checking the output tree would cause stale artifacts from past builds to block regeneration indefinitely. When an authored file is found in `src/pages/` while generation is enabled, Bascik emits an actionable warning:

```text
warning: src/pages/robots.txt exists, so generate.robots did not write dist/robots.txt.
  - To keep your authored file and silence this warning, set generate.robots: false
  - To use Bascik's generated file, delete src/pages/robots.txt
  - Your authored robots.txt should include its own "Sitemap:" line
```

Robots.txt and sitemap precedence are evaluated independently. Authoring one does not suppress generation of the other. Nested files (such as `src/pages/about/robots.txt`) are ignored for site-root precedence.

### Composing generated sitemaps with custom additions

Instead of manually maintaining a full `sitemap.xml`, you can use an `exec` script with `phase: 'post'` to read Bascik's freshly generated `dist/sitemap.xml` and append custom external URLs or split into a sitemap index:

```ts
// bascik.config.ts
export default defineConfig({
  pipeline: {
    exec: [
      { script: 'scripts/augment-sitemap.ts', phase: 'post' },
    ],
  },
});
```

Because post-phase scripts run on the newly emitted build output, this pattern remains completely deterministic across builds.

## Per-page sitemap exclusion

To exclude a specific page (such as a legacy URL redirect) from `sitemap.xml`, place a meta tag in the page's HTML:

```html
<meta name="bascik-sitemap" content="exclude">
```

The `404` and `500` error pages are automatically excluded from `sitemap.xml`, since neither is real content.

## Optional lastmod timestamps

By default, `generate.sitemapLastmod` is `false`. When enabled, `<lastmod>` tags in `sitemap.xml` are populated using the source file's last modified timestamp:

```ts
// bascik.config.ts
export default defineConfig({
  generate: {
    sitemapLastmod: true,
  },
});
```

`sitemapLastmod` is opt-in because filesystem mtimes can vary across CI checkouts, which would create unnecessary diff churn. Bascik intentionally omits `changefreq` and `priority` elements, as search engines publicly ignore them.

## URL path rules

Each page is converted from its file path to a URL path following these rules:

| Source file | URL |
| --- | --- |
| `src/pages/index.html` | `/` |
| `src/pages/about.html` | `/about` |
| `src/pages/blog/index.html` | `/blog/` |
| `src/pages/blog/post.html` | `/blog/post` |
| `src/pages/blog/[slug].html` (dynamic) | `/blog/hello-world`, `/blog/second-post` (concrete generated paths) |

Directory index URLs include a trailing slash. The sitemap uses the same canonical path as the development and production servers, so crawlers reach the page directly instead of following a redirect from `/blog` to `/blog/`.

When `base` is not `/`, every generated absolute URL composes `BASCIK_SITE_URL`, the normalized base, and the page path. For example, `BASCIK_SITE_URL=https://example.com`, `base: '/docs/'`, and `src/pages/about.html` produce `https://example.com/docs/about`. The `Sitemap:` line in `robots.txt` uses the same composition and never adds a doubled slash.

### Dynamic route expansion and percent-encoding

When using [Dynamic Routes](/dynamic-routes), Bascik discovers all concrete HTML pages generated from your templates and adds their final URLs to `sitemap.xml`. The unexpanded template path with literal brackets (such as `/blog/[slug]`) is omitted from the sitemap.

Parameter segments containing non-ASCII or special characters are automatically percent-encoded (for example, `/products/item%20name`) to ensure valid XML sitemap output.

## Opting out

Control sitemap and robots.txt generation independently via the `generate` option:

```js
export default {
  generate: {
    sitemap: true,  // default
    robots: true,   // default
  },
};
```

Set either to `false` to skip that file:

```js
export default {
  generate: { sitemap: true, robots: false }, // skip robots.txt
};
```

If `generate.sitemap` or `generate.robots` is `true` but no site URL is available from any source, the build **fails** with an error showing how to set `BASCIK_SITE_URL`. It cannot produce absolute URLs without a base URL, and a warning on every zero-config build would train you to ignore Bascik warnings.

## Build-only

Sitemap and robots.txt are only generated during `bascik --build`. The dev server does not write these files.
