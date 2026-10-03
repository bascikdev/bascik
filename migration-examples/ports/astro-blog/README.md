# Astro blog, ported to Bascik

A hand port of the official Astro blog example (`withastro/astro`, `examples/blog/`,
commit `4c1470a`) to Bascik. It exists to check specific migration claims, not to be a starter
template. Code is adapted under the upstream MIT license (see `NOTICE.md`). Content, images,
icons, and the favicon are original. The font files are Atkinson Hyperlegible under the SIL OFL 1.1.

## Run it

```sh
npm ci --ignore-scripts
npm run dev      # development server
npm run build    # writes dist/
npm run serve    # production server over dist/
```

The scripts pass `--site-url https://example.com` because canonical URLs, Open Graph metadata,
the feed, and the sitemap need an absolute origin. Replace it with your own.

## Mapping from the original

| Original | Port |
| --- | --- |
| `src/pages/index.astro`, `about.astro`, `blog/index.astro` | `src/pages/index.html`, `about/index.html`, `blog/index.html` |
| `src/pages/blog/[...slug].astro` | `src/pages/blog/[slug]/index.html` (dynamic route, trailing-slash URLs) |
| `src/content/blog/*.md(x)` + `content.config.ts` | `content/blog/*.md` + `src/lib/posts.ts` (front matter validated with zod) |
| `BaseHead.astro` | `base-head` (page-aware build script, props, attribute bindings) |
| `Header.astro`, `HeaderLink.astro` | `site-header`, `menu-link` |
| `Footer.astro` | `site-footer`, `social-links` |
| `FormattedDate.astro` | `formatted-date` |
| `layouts/BlogPost.astro` | `post-layout` (named slots) |
| `rss.xml.js` | `scripts/generate-feed.ts` (post-build exec script) |
| `@astrojs/sitemap` | Bascik's built-in `sitemap.xml` |
| MDX | Markdown rendered at build time. Component tags in the output are expanded by Bascik |

## Deliberate differences

- No image optimization. `astro:assets` produced resized WebP variants and `srcset`. This port
  ships the original files as authored. Widths and heights are set to prevent layout shift.
- No syntax highlighting. Code blocks are plain `<pre tabindex="0">` regions. The upstream
  highlighter output is not reproduced.
- Local font files are preloaded by hand. Astro's font pipeline generated the `@font-face` and
  fallback metrics.
- The feed is RSS 2.0 from the `feed` package. Item `guid` and channel metadata differ in detail.
- Dates in front matter are written as ISO dates so the machine-readable `datetime` is the same
  on every machine.
- The link component is named `menu-link`, not `header-link`. A component named `header-link`
  collides with a stylesheet that styles `header` (see the task record).
- Emitted nav anchors are styled by class rather than the upstream `nav a` descendant selector.
- `scripts.cache.exclude` uses `**/` prefixed patterns. Relative patterns did not match.
