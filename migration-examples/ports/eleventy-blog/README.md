# Eleventy base blog, ported to Bascik

A hand port of the official Eleventy base blog (`11ty/eleventy-base-blog`, commit `94bd3b7`) to
Bascik. It exists to check specific migration claims, not to be a starter template. Code is adapted
under the upstream MIT license (see `NOTICE.md`). The sample content and the image are original.

The port has no Eleventy runtime dependency. Content handling is a few small files under
`src/lib/`, built on `gray-matter`, `marked`, `prismjs`, `zod`, `feed`, and `image-size`.

## Run it

```sh
npm ci --ignore-scripts
npm run dev      # development server (drafts are included)
npm run build    # writes dist/ (drafts are not written)
npm run serve    # production server over dist/
```

The scripts pass `--site-url https://example.com` because canonical URLs, the feed, and the sitemap
need an absolute origin. Replace it with your own. A build without a site URL fails on purpose
rather than writing relative feed URLs.

## Mapping from the original

| Original | Port |
| --- | --- |
| `content/blog/*.md`, `content/blog/*/*.md`, `content/blog/blog.11tydata.js` | `content/blog/*.md` and `content/blog/<name>/<name>.md`, read by `src/lib/posts.ts` (front matter validated with zod, dates required) |
| `content/index.njk`, `about.md` | `src/pages/index.html`, `src/pages/about/index.html` |
| `content/blog.njk`, `content/blog/blog.11tydata.js` | `src/pages/blog/index.html`, `src/pages/blog/[slug]/index.html` (dynamic route) |
| `content/tags.njk`, `tag-pages` | `src/pages/tags/index.html`, `src/pages/tags/[tag]/index.html` |
| `content/404.md` | `src/pages/404.html` |
| `_includes/layouts/*.njk`, `_includes/postslist.njk` | `src/lib/render.ts` helpers called from page build scripts |
| `_includes/layouts/base.njk` head, nav, footer | `site-head`, `site-header`, `site-footer` components |
| `eleventy.config.js` `getPreviousCollectionItem` and `getNextCollectionItem` | `renderPost` in `src/lib/render.ts`, neighbors in date order |
| `eleventy-plugin-syntaxhighlight` | `src/lib/highlight.ts`, Prism at build time (including `diff-<language>`), theme read from `prismjs` in `src/lib/render.ts` |
| `IdAttributePlugin` and `heading-anchors` | `src/lib/markdown.ts` assigns ids and writes the anchor markup at build time |
| `eleventy-plugin-rss` feed | `scripts/generate-feed.ts`, an Atom feed written by a post-build exec step |
| `sitemap.xml.njk` | Bascik's built-in `sitemap.xml` |
| Eleventy image transform for post images | `scripts/copy-content-assets.ts` copies images beside a post to the post's URL |

## Deliberate differences

- No AVIF or WebP variants. The original image is copied as authored with its width and height.
- No pretty-feed XSL. The upstream stylesheet has no license, so it is not copied. The Atom feed is
  otherwise equivalent and carries the same entries.
- The `<heading-anchors>` web component is replaced with the same anchor markup written at build
  time. No script ships to the browser.
- The feed comes from the `feed` package and `<id>` values differ in detail.
- Links between posts are written as paths to the Markdown files and checked at build time. A link
  to a missing file or to a draft fails the production build and names the source file.
- Removing a post that other posts link to fails the build until the link is removed. A failed
  build also clears the previous `dist/` pages, so a broken site never ships a stale mix.
- Bascik's built-in sitemap lists every published page, including tag pages, and not the feed. The
  upstream sitemap lists the feed and no tag pages. The development server serves no sitemap.
- Classes not defined in a component's own stylesheet stay global, so page-level CSS in
  `src/css/global.css` keeps working inside components.

## Bascik version

The port needs a Bascik build that includes the no-stylesheet class passthrough fix (classes that a
component's own CSS does not define stay unscoped, with or without a stylesheet). The released
`1.0.0-rc.2` does not have it. Install from a local pack of this repository until the next release:

```sh
yarn pkg:build && yarn workspace @bascik/bascik pack --out /tmp/bascik.tgz
npm install --ignore-scripts /tmp/bascik.tgz
```

Verify the port against the original with the shared harness: from `migration-examples/`, run
`npm run test:eleventy` for the production, development, and control lanes, and
`npm run test:eleventy-mutations` for add, edit, remove, and failure scenarios.
