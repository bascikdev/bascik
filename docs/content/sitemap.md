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
